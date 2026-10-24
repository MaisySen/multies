/**
 * Cloudflare Workers entry: API on /api/*, the built SPA from the ASSETS binding
 * for everything else, D1 as the database. Housekeeping runs opportunistically
 * (at most every 10 minutes) and on a cron trigger when one is configured.
 */
import * as Sentry from "@sentry/cloudflare";
import { drizzle } from "drizzle-orm/d1";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { applyMigrations, migrationDriver, schema, type DB } from "../server/db";
import { DohResolver } from "../server/services/dns/resolver";
import { LogOutbound, ResendOutbound } from "../server/services/mail/outbound";
import { ResilientOutbound } from "../server/services/resilience";
import { getOrCreateStoredSecret, runMaintenanceIfMigrated } from "../server/services/maintenance";
import type { Deps, RateLimitBinding } from "../server/context";
import { appCsp, isHttps, withSecurityHeaders } from "../server/lib/security-headers";
import { jsonLogger } from "../server/lib/logger";
import { withAuthRequestState } from "../server/lib/request-state";
import { S3BodyStore } from "../server/services/storage/body-store";
import { collabAccess } from "../server/collab/access";
import { collabDocId } from "../server/collab/room";
import type { DocRoomNamespace } from "../server/collab/durable-object";

/** The doc co-editing room (a Durable Object), exported for the DOC_ROOMS binding. */
export { DocRoom } from "../server/collab/durable-object";

interface D1Database { prepare(query: string): unknown }
interface Fetcher { fetch(input: Request | string, init?: RequestInit): Promise<Response> }
interface ExecutionContext { waitUntil(p: Promise<unknown>): void }

export interface WorkerEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  [key: string]: unknown;
}

/** Build-time defaults (set by scripts/build-worker.ts); real env vars win. */
declare const __MYMAIL_BUILD_ENV__: Record<string, string>;
/** The built index.html, served by the Worker for every app route. */
declare const __MYMAIL_SHELL_HTML__: string;

let ready: Promise<{ app: ReturnType<typeof createApp>; deps: Deps }> | null = null;
let lastMaintenance = 0;

async function boot(env: WorkerEnv) {
  // No migrations here: they run once per deploy (wrangler d1 migrations apply, or the
  // deploy hook below on hosts where wrangler cannot reach the database).
  const db = drizzle(env.DB as never, { schema }) as unknown as DB;
  const vars: Record<string, string | undefined> = { ...(typeof __MYMAIL_BUILD_ENV__ === "object" ? __MYMAIL_BUILD_ENV__ : {}) };
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") vars[k] = v;
  if (!vars.APP_SECRET && vars.ALLOW_GENERATED_SECRET === "true") vars.APP_SECRET = await getOrCreateStoredSecret(db);
  const config = loadConfig(vars);
  const outbound = config.outbound.driver === "resend" ? new ResilientOutbound(new ResendOutbound(config.outbound.resendApiKey!)) : new LogOutbound();
  const deps: Deps = {
    db, config, dns: new DohResolver(), outbound, now: () => new Date(), fetch: peerAwareFetch(env),
    log: jsonLogger({ service: "mymail-api", release: config.release, env: config.sentry.environment }),
    reportError: config.sentry.dsnApi ? (err, context) => Sentry.captureException(err, { extra: context }) : undefined,
    bodyStore: config.bodyStore ? new S3BodyStore(config.bodyStore) : undefined,
    rateLimiters: {
      auth: binding(env.RL_AUTH), api: binding(env.RL_API), webhooks: binding(env.RL_WEBHOOKS), app: binding(env.RL_APP),
    },
  };
  return { app: createApp(deps), deps };
}

/**
 * Workers on one account cannot fetch each other's workers.dev address (Cloudflare
 * answers 404, error 1042), so requests to the peer environment (production to staging
 * and back, for the uptime cross check) go through a service binding instead.
 */
function peerAwareFetch(env: WorkerEnv): typeof fetch {
  const peer = env.PEER as Fetcher | undefined;
  const host = typeof env.PEER_HOST === "string" ? env.PEER_HOST : "";
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (peer && typeof peer.fetch === "function" && host && new URL(req.url).hostname === host) return peer.fetch(req);
    return fetch(req);
  }) as typeof fetch;
}

/** A Cloudflare rate limiting binding, when wrangler.toml declares one. */
function binding(v: unknown): RateLimitBinding | undefined {
  return v && typeof (v as RateLimitBinding).limit === "function" ? (v as RateLimitBinding) : undefined;
}

let pageHeaders: { csp: string; hsts: boolean } | null = null;
let formPageHeaders: { csp: string; hsts: boolean } | null = null;

function getReady(env: WorkerEnv) {
  ready ??= boot(env).catch((err) => { ready = null; throw err; });
  return ready;
}

function envVar(env: WorkerEnv, key: string): string | undefined {
  const v = env[key];
  if (typeof v === "string") return v;
  return typeof __MYMAIL_BUILD_ENV__ === "object" ? __MYMAIL_BUILD_ENV__[key] : undefined;
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Deploy hook for hosts where `wrangler d1 migrations apply` cannot reach the database
 * (the hosted preview). Called once by the deploy script right after upload, with the
 * DEPLOY_TOKEN; it is off when no token is configured.
 */
async function deployMigrate(request: Request, env: WorkerEnv): Promise<Response> {
  const token = envVar(env, "DEPLOY_TOKEN");
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || token.length < 32 || request.method !== "POST" || !(await safeEqual(given, token))) {
    return Response.json({ error: { code: "not_found", message: "No such endpoint." } }, { status: 404 });
  }
  const applied = await applyMigrations(migrationDriver(env.DB));
  return Response.json({ ok: true, applied }, { headers: { "cache-control": "no-store" } });
}

/**
 * GET /api/docs/:id/collab: checks the session and the doc's workspace, then hands the
 * WebSocket to the doc's room. Hosts without the DOC_ROOMS binding answer 503 and the
 * editor stays in single person mode.
 */
async function collabUpgrade(request: Request, env: WorkerEnv, docId: string): Promise<Response> {
  const rooms = env.DOC_ROOMS as DocRoomNamespace | undefined;
  if (!rooms || typeof rooms.idFromName !== "function") return Response.json({ error: { code: "collab_off", message: "Co-editing is not set up on this host." } }, { status: 503 });
  const { app, deps } = await getReady(env);
  const access = await collabAccess(app, deps, request, docId);
  if (!access.ok) return Response.json({ error: { code: "collab_denied", message: access.message } }, { status: access.status });
  const headers = new Headers({ upgrade: "websocket", "x-collab-read-only": access.readOnly ? "1" : "0" });
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  return rooms.get(rooms.idFromName(docId)).fetch(new Request(request.url, { method: "GET", headers }));
}

/**
 * Better Auth keeps per-request state in AsyncLocalStorage. Opening that store once at
 * the start of each request keeps it for the whole request: when Better Auth opened it
 * lazily inside each auth call, concurrent requests in one isolate lost it and getSession
 * failed (500 failed_to_get_session on about 1 in 5 requests under load).
 */
async function serve(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/internal/migrate") return deployMigrate(request, env);
  const collabDoc = collabDocId(url.pathname);
  if (collabDoc) return collabUpgrade(request, env, collabDoc);
  if (url.pathname.startsWith("/api/") || url.pathname === "/.well-known/security.txt") {
    const { app, deps } = await getReady(env);
    // Hosts without a cron trigger (the hosted preview) run maintenance from requests.
    // Production and staging have cron triggers and must not: every new isolate used to
    // start a 20 second maintenance pass whose queries queued ahead of the request's own.
    if (envVar(env, "MAINTENANCE_ON_REQUEST") === "true" && Date.now() - lastMaintenance > 10 * 60_000) {
      lastMaintenance = Date.now();
      ctx.waitUntil(runMaintenanceIfMigrated(deps).catch((e) => console.error("[maintenance]", e)));
    }
    // The execution context lets a route finish work after its response (c.executionCtx.waitUntil).
    return app.fetch(request, undefined, ctx as unknown as Parameters<typeof app.fetch>[2]);
  }
  pageHeaders ??= { csp: appCsp(), hsts: isHttps(url.origin) };
  // Public form pages load Cloudflare Turnstile; the rest of the app runs only its own scripts.
  formPageHeaders ??= { csp: appCsp({ turnstile: true }), hsts: isHttps(url.origin) };
  const headers = url.pathname.startsWith("/f/") ? formPageHeaders : pageHeaders;
  const asset = await env.ASSETS.fetch(request);
  if (asset.status !== 404) {
    const res = withSecurityHeaders(asset, headers);
    // Hashed build files never change; everything else revalidates.
    if (url.pathname.startsWith("/assets/")) res.headers.set("cache-control", "public, max-age=31536000, immutable");
    return res;
  }
  // Every app route renders the app shell, which routes client-side.
  const shell = typeof __MYMAIL_SHELL_HTML__ === "string"
    ? new Response(__MYMAIL_SHELL_HTML__, { headers: { "content-type": "text/html; charset=utf-8" } })
    : await env.ASSETS.fetch(new Request(new URL("/", url), { headers: request.headers }));
  const res = withSecurityHeaders(new Response(request.method === "HEAD" ? null : shell.body, { status: 200, headers: shell.headers }), headers);
  res.headers.set("cache-control", "no-cache");
  return res;
}

const handler = {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return withAuthRequestState(() => serve(request, env, ctx));
  },

  async scheduled(_event: unknown, env: WorkerEnv, ctx: ExecutionContext) {
    const { deps } = await getReady(env);
    ctx.waitUntil(runMaintenanceIfMigrated(deps));
  },
};

const buildEnv = (typeof __MYMAIL_BUILD_ENV__ === "object" ? __MYMAIL_BUILD_ENV__ : {}) as Record<string, string | undefined>;

/** Sentry wraps the handler when SENTRY_DSN_API is set; without it the SDK stays off. */
export default Sentry.withSentry((rawEnv: unknown) => {
  const env = rawEnv as WorkerEnv;
  const dsn = (typeof env.SENTRY_DSN_API === "string" ? env.SENTRY_DSN_API : undefined) ?? buildEnv.SENTRY_DSN_API;
  if (!dsn) return undefined;
  return {
    dsn,
    environment: (typeof env.SENTRY_ENVIRONMENT === "string" ? env.SENTRY_ENVIRONMENT : undefined) ?? buildEnv.SENTRY_ENVIRONMENT ?? "production",
    release: (typeof env.RELEASE === "string" ? env.RELEASE : undefined) ?? buildEnv.RELEASE,
    tracesSampleRate: Number((typeof env.SENTRY_TRACES_SAMPLE_RATE === "string" ? env.SENTRY_TRACES_SAMPLE_RATE : undefined) ?? buildEnv.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
  };
}, handler as never);

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
import { getOrCreateStoredSecret, runMaintenance } from "../server/services/maintenance";
import type { Deps } from "../server/context";

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
  const outbound = config.outbound.driver === "resend" ? new ResendOutbound(config.outbound.resendApiKey!) : new LogOutbound();
  const deps: Deps = {
    db, config, dns: new DohResolver(), outbound, now: () => new Date(), fetch: (input, init) => fetch(input, init),
    reportError: config.sentry.dsnApi ? (err, context) => Sentry.captureException(err, { extra: context }) : undefined,
  };
  return { app: createApp(deps), deps };
}

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

const handler = {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/internal/migrate") return deployMigrate(request, env);
    if (url.pathname.startsWith("/api/")) {
      const { app, deps } = await getReady(env);
      if (Date.now() - lastMaintenance > 10 * 60_000) {
        lastMaintenance = Date.now();
        ctx.waitUntil(runMaintenance(deps).catch((e) => console.error("[maintenance]", e)));
      }
      return app.fetch(request);
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    // SPA fallback: unknown paths render the app shell, which routes client-side.
    const shell = await env.ASSETS.fetch(new Request(new URL("/", url), { headers: request.headers }));
    const headers = new Headers(shell.headers);
    headers.set("cache-control", "no-cache");
    return new Response(shell.body, { status: 200, headers });
  },

  async scheduled(_event: unknown, env: WorkerEnv, ctx: ExecutionContext) {
    const { deps } = await getReady(env);
    ctx.waitUntil(runMaintenance(deps));
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
    tracesSampleRate: 0.05,
  };
}, handler as never);

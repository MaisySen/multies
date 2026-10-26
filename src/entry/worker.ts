/**
 * Cloudflare Workers entry: API on /api/*, the built SPA from the ASSETS binding
 * for everything else, D1 as the database. Housekeeping runs opportunistically
 * (at most every 10 minutes) and on a cron trigger when one is configured.
 */
import { WEB_META_PATHS } from "../server/routes/web-meta-r32"; // R32: /version.json, /llms.txt
import { isKnownPage } from "../shared/known-routes";
import { metaFor, SITE_URL } from "../web/components/seo-meta";
import * as Sentry from "@sentry/cloudflare";
import { sentryPrivacy } from "../shared/sentry-scrub";
import { drizzle } from "drizzle-orm/d1";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { applyMigrations, migrationDriver, schema, type DB } from "../server/db";
import { DohResolver } from "../server/services/dns/resolver";
import { LogOutbound, ResendOutbound } from "../server/services/mail/outbound";
import { ResilientOutbound } from "../server/services/resilience";
import { getOrCreateStoredSecret, runMaintenanceIfMigrated } from "../server/services/maintenance";
import type { Deps, RateLimitBinding } from "../server/context";
import { API_CSP, appCsp, isHttps, withSecurityHeaders } from "../server/lib/security-headers";
import { jsonLogger } from "../server/lib/logger";
import { withAuthRequestState } from "../server/lib/request-state";
import { S3BodyStore } from "../server/services/storage/body-store";
import { collabAccess } from "../server/collab/access";
import { collabDocId } from "../server/collab/room";
import type { DocRoomNamespace } from "../server/collab/durable-object";

/** The doc co-editing room (a Durable Object), exported for the DOC_ROOMS binding. */
export { DocRoom } from "../server/collab/durable-object";
/** Round 22: live thread presence (in memory only), exported for the THREAD_PRESENCE binding. */
export { ThreadPresence } from "../server/collab/thread-presence";
/** Round 32: the workspace live chat hub, exported for the CHAT_HUB binding. */
export { ChatHub } from "../server/realtime/chat-hub-do";
import { chatLiveUpgrade, durableChatLive } from "../server/realtime/worker";
import { CHAT_LIVE_PATH } from "../server/realtime/hub";
import { durablePresence } from "../server/collab/thread-presence";
import { workerSocketOpener } from "./worker-socket";
import { syncConnection } from "../server/services/connect/sync";
import { LiveBudget, LiveMail, type LiveTouch } from "../server/services/connect/live";
import { withReadRetry } from "../server/lib/d1-busy";
import { BRAND_CACHE, htmlCacheControl, originHintsFor, shellFor, withOriginHints } from "../shared/prerender-shell";

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
/** R30: the shell with the landing page prerendered inside, served for "/" only (empty when not built). */
declare const __MYMAIL_LANDING_HTML__: string;
/** R30: the shell that preloads the sign in page's code, served for the auth pages (empty when not built). */
declare const __MYMAIL_AUTH_HTML__: string;

let ready: Promise<{ app: ReturnType<typeof createApp>; deps: Deps }> | null = null;
let lastMaintenance = 0;

async function boot(env: WorkerEnv) {
  // No migrations here: they run once per deploy (wrangler d1 migrations apply, or the
  // deploy hook below on hosts where wrangler cannot reach the database).
  // R28: a read retries once after a short pause when D1 is briefly unavailable (lib/d1-busy.ts).
  const db = drizzle(withReadRetry(env.DB) as never, { schema }) as unknown as DB;
  const vars: Record<string, string | undefined> = { ...(typeof __MYMAIL_BUILD_ENV__ === "object" ? __MYMAIL_BUILD_ENV__ : {}) };
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") vars[k] = v;
  if (!vars.APP_SECRET && vars.ALLOW_GENERATED_SECRET === "true") vars.APP_SECRET = await getOrCreateStoredSecret(db);
  const config = loadConfig(vars);
  const outbound = config.outbound.driver === "resend" ? new ResilientOutbound(new ResendOutbound(config.outbound.resendApiKey!)) : new LogOutbound();
  const deps: Deps = {
    db, config, dns: new DohResolver(), outbound, now: () => new Date(), fetch: peerAwareFetch(env),
    log: jsonLogger({ service: "mymail-api", release: config.release, env: config.sentry.environment }),
    reportError: config.sentry.dsnApi ? (err, context) => {
      // A report about another environment (an uptime cross check) carries that environment, not this worker's.
      const about = typeof context?.environment === "string" ? context.environment : null;
      if (!about) return Sentry.captureException(err, { extra: context });
      return Sentry.withScope((scope) => {
        scope.addEventProcessor((e) => ({ ...e, environment: about }));
        scope.setTag("reported_by", config.sentry.environment);
        return Sentry.captureException(err, { extra: context });
      });
    } : undefined,
    bodyStore: config.bodyStore ? new S3BodyStore(config.bodyStore) : undefined,
    openSocket: workerSocketOpener,
    dispatchMailSync: mailSyncDispatcher(env),
    liveMail: liveMailDispatcher(env),
    liveWait: liveWaitDispatcher(env),
    presence: presenceDispatcher(env),
    chatLive: durableChatLive(env.CHAT_HUB),
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

interface DurableObjectNamespaceLike { idFromName(name: string): unknown; get(id: unknown): Fetcher }

/**
 * Each connected mailbox syncs in its own Durable Object invocation (MAIL_SYNC binding), so one
 * mailbox's messages never use up the request budget of the cron run or of another mailbox. Hosts
 * without the binding run the pass inline.
 */
function mailSyncDispatcher(env: WorkerEnv): ((id: string) => Promise<void>) | undefined {
  const ns = env.MAIL_SYNC as DurableObjectNamespaceLike | undefined;
  if (!ns || typeof ns.idFromName !== "function") return undefined;
  return async (id: string) => {
    const res = await ns.get(ns.idFromName(id)).fetch(new Request("https://mail-sync/run", { method: "POST", body: JSON.stringify({ id }) }));
    if (!res.ok) throw new Error(`mail sync answered ${res.status}`);
  };
}

interface DurableObjectStateLike { storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; setAlarm(t: number): Promise<void> } }

/** Live mail (round 19): opens or extends a connection's live window in its Durable Object. */
function liveMailDispatcher(env: WorkerEnv): ((id: string, seconds: number) => Promise<LiveTouch>) | undefined {
  const ns = env.MAIL_SYNC as DurableObjectNamespaceLike | undefined;
  if (!ns || typeof ns.idFromName !== "function") return undefined;
  return async (id: string, seconds: number) => {
    const res = await ns.get(ns.idFromName(id)).fetch(new Request("https://mail-sync/live", { method: "POST", body: JSON.stringify({ id, seconds }) }));
    if (!res.ok) throw new Error(`live mail answered ${res.status}`);
    return (await res.json()) as LiveTouch;
  };
}

function liveWaitDispatcher(env: WorkerEnv): ((id: string, ms: number) => Promise<boolean>) | undefined {
  const ns = env.MAIL_SYNC as DurableObjectNamespaceLike | undefined;
  if (!ns || typeof ns.idFromName !== "function") return undefined;
  return async (id: string, ms: number) => {
    const res = await ns.get(ns.idFromName(id)).fetch(new Request("https://mail-sync/wait", { method: "POST", body: JSON.stringify({ id, ms }) }));
    return res.ok && ((await res.json()) as { stored: boolean }).stored;
  };
}

/** Round 22: thread presence rooms in the THREAD_PRESENCE Durable Object. Without the binding they live in the isolate. */
function presenceDispatcher(env: WorkerEnv) {
  const ns = env.THREAD_PRESENCE as DurableObjectNamespaceLike | undefined;
  return ns && typeof ns.idFromName === "function" ? durablePresence(ns) : undefined;
}

/** The one object that keeps the account's daily live mail allowance (Durable Object wall time). */
const LIVE_BUDGET_NAME = "live-budget";

/**
 * One per connected mailbox (idFromName(connection id)). A run does one sync pass; when more mail
 * is waiting (the first import) it sets an alarm 20 seconds out, and each alarm is a fresh
 * invocation with its own limits, until the backlog is in.
 *
 * Round 19: /live holds the connection's live window (IDLE on the Inbox, see
 * services/connect/live.ts) while heartbeats arrive; the object named "live-budget" answers /lease
 * from the account's daily allowance of live minutes.
 */
export class MailSyncRunner {
  private live?: LiveMail;
  private budget?: LiveBudget;
  constructor(private state: DurableObjectStateLike, private env: WorkerEnv) {}
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/lease") return this.lease(request);
    if (path === "/live" || path === "/wait") {
      const body = (await request.json()) as { id: string; seconds?: number; ms?: number };
      this.live ??= new LiveMail(async () => ({ ...(await getReady(this.env)).deps, dispatchMailSync: undefined }), { lease: (sec) => this.askLease(sec) });
      if (path === "/wait") return Response.json({ stored: await this.live.waitForMail(body.id, Math.min(Number(body.ms) || 0, 25_000)) });
      return Response.json(await this.live.touch(body.id, body.seconds));
    }
    const { id } = (await request.json()) as { id: string };
    await this.state.storage.put("id", id);
    return Response.json(await this.pass(id));
  }
  async alarm() {
    const id = await this.state.storage.get<string>("id");
    if (id) await this.pass(id);
  }
  private async askLease(seconds: number): Promise<boolean> {
    const ns = this.env.MAIL_SYNC as DurableObjectNamespaceLike;
    const res = await ns.get(ns.idFromName(LIVE_BUDGET_NAME)).fetch(new Request("https://mail-sync/lease", { method: "POST", body: JSON.stringify({ seconds }) }));
    return res.ok && ((await res.json()) as { granted: boolean }).granted;
  }
  private async lease(request: Request): Promise<Response> {
    const { seconds } = (await request.json()) as { seconds: number };
    const { deps } = await getReady(this.env);
    this.budget ??= new LiveBudget(deps.config.mailConnect.liveMinutesPerDay, Date.now, {
      get: () => this.state.storage.get<{ day: string; used: number }>("budget"),
      put: (v) => this.state.storage.put("budget", v),
    });
    const granted = await this.budget.lease(Math.min(Math.max(Number(seconds) || 0, 1), 900));
    return Response.json({ granted, ...this.budget.usage() });
  }
  private async pass(id: string) {
    const { deps } = await getReady(this.env);
    const r = await syncConnection({ ...deps, dispatchMailSync: undefined }, id);
    if (r.more && !r.skipped) await this.state.storage.setAlarm(Date.now() + 20_000);
    return { stored: r.stored, more: r.more, skipped: r.skipped ?? null };
  }
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
  // R30: the two responses served outside the app get the API headers too (a 101 upgrade cannot carry them).
  const apiHeaders = { csp: API_CSP, hsts: isHttps(url.origin) };
  if (url.pathname === "/api/internal/migrate") return withSecurityHeaders(await deployMigrate(request, env), apiHeaders);
  const collabDoc = collabDocId(url.pathname);
  if (collabDoc) {
    const res = await collabUpgrade(request, env, collabDoc);
    return res.status === 101 ? res : withSecurityHeaders(res, apiHeaders);
  }
  if (url.pathname === CHAT_LIVE_PATH) {
    const { deps } = await getReady(env);
    const res = await chatLiveUpgrade(request, env.CHAT_HUB, deps);
    return res.status === 101 ? res : withSecurityHeaders(res, apiHeaders);
  }
  if (url.pathname.startsWith("/api/") || WEB_META_PATHS.has(url.pathname) || url.pathname === "/health" || url.pathname === "/healthz" || url.pathname.startsWith("/cal/") || url.pathname.startsWith("/s/") || url.pathname === "/.well-known/security.txt" || url.pathname.startsWith("/.well-known/oauth-") || url.pathname === "/.well-known/openid-configuration") {
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
  const analytics = /^[a-f0-9]{32}$/i.test(envVar(env, "CF_BEACON_TOKEN") ?? "");
  const cspBase = { analytics, appUrl: envVar(env, "APP_URL") ?? url.origin, livekitUrl: envVar(env, "LIVEKIT_URL") };
  pageHeaders ??= { csp: appCsp(cspBase), hsts: isHttps(url.origin) };
  // Public form pages load Cloudflare Turnstile; the rest of the app runs only its own scripts.
  formPageHeaders ??= { csp: appCsp({ ...cspBase, turnstile: true }), hsts: isHttps(url.origin) };
  const headers = url.pathname.startsWith("/f/") ? formPageHeaders : pageHeaders;
  const asset = await env.ASSETS.fetch(request);
  if (asset.status !== 404) {
    const res = withSecurityHeaders(asset, headers);
    // Hashed build files never change; everything else revalidates.
    if (url.pathname.startsWith("/assets/")) res.headers.set("cache-control", "public, max-age=31536000, immutable");
    // R34: brand marks (the provider logos on sign in) are kept a year, revalidated in the background after that.
    else if (url.pathname.startsWith("/brand/")) res.headers.set("cache-control", BRAND_CACHE);
    // R32: the service worker is always checked for a newer copy.
    if (url.pathname === "/sw.js") res.headers.set("cache-control", "no-cache");
    // R34: static HTML files (the offline page) get no-transform too, so nothing is injected into them.
    if (res.headers.get("content-type")?.startsWith("text/html")) res.headers.set("cache-control", htmlCacheControl(res.headers.get("cache-control") ?? "no-cache"));
    return res;
  }
  // Every app route renders the app shell, which routes client-side.
  const shell = typeof __MYMAIL_SHELL_HTML__ === "string"
    ? new Response(withOriginHints(shellFor(url.pathname, __MYMAIL_SHELL_HTML__, typeof __MYMAIL_LANDING_HTML__ === "string" ? __MYMAIL_LANDING_HTML__ : null, typeof __MYMAIL_AUTH_HTML__ === "string" ? __MYMAIL_AUTH_HTML__ : null), originHintsFor(envVar(env, "SENTRY_DSN_WEB"))), { headers: { "content-type": "text/html; charset=utf-8" } })
    : await env.ASSETS.fetch(new Request(new URL("/", url), { headers: request.headers }));
  // Unknown pages still get the app (it shows page-not-found) but with a real 404 status.
  const res = withSecurityHeaders(new Response(request.method === "HEAD" ? null : shell.body, { status: isKnownPage(url.pathname) ? 200 : 404, headers: shell.headers }), headers);
  res.headers.set("cache-control", htmlCacheControl("no-cache"));
  return request.method === "HEAD" ? res : withPageMeta(res, url.pathname);
}

/**
 * Puts the page's own title, description, canonical and social tags into the shell, so crawlers and
 * link previews that do not run scripts see the right ones. A streaming rewrite: no extra CPU to speak of.
 */
interface RewriterElement { setAttribute(name: string, value: string): void; setInnerContent(text: string): void; append(content: string, opts?: { html: boolean }): void }
interface Rewriter { on(selector: string, handler: { element(el: RewriterElement): void }): Rewriter; transform(res: Response): Response }
declare const HTMLRewriter: { new (): Rewriter } | undefined;

function withPageMeta(res: Response, path: string): Response {
  if (typeof HTMLRewriter === "undefined") return res;
  const meta = metaFor(path);
  const url = `${SITE_URL}${path === "/" ? "/" : path.replace(/\/+$/, "")}`;
  const content = (value: string) => ({ element: (el: RewriterElement) => { el.setAttribute("content", value); } });
  return new HTMLRewriter()
    .on("title", { element: (el) => { el.setInnerContent(meta.title); } })
    .on('meta[name="description"]', content(meta.description))
    .on('meta[property="og:title"]', content(meta.title))
    .on('meta[property="og:description"]', content(meta.description))
    .on('meta[property="og:url"]', content(url))
    .on('meta[name="twitter:title"]', content(meta.title))
    .on('meta[name="twitter:description"]', content(meta.description))
    .on('link[rel="canonical"]', { element: (el) => { el.setAttribute("href", url); } })
    .on("head", { element: (el) => { if (meta.noindex) el.append('<meta name="robots" content="noindex" />', { html: true }); } })
    .transform(res);
}

/** www.<domain> answers with a permanent redirect to the same path on the apex. */
export function wwwRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (!url.hostname.startsWith("www.")) return null;
  url.hostname = url.hostname.slice(4);
  url.protocol = "https:";
  return new Response(null, { status: 301, headers: { location: url.toString(), "cache-control": "public, max-age=86400" } });
}

/**
 * Non production hosts (the preview) set NOINDEX=true: robots.txt disallows everything and every
 * response carries X-Robots-Tag, so search engines never list them.
 */
export async function withNoindex(request: Request, noindex: boolean, next: () => Promise<Response>): Promise<Response> {
  if (!noindex) return next();
  if (new URL(request.url).pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex, nofollow" } });
  }
  const res = await next();
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  out.headers.set("x-robots-tag", "noindex, nofollow");
  return out;
}

const handler = {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const www = wwwRedirect(request);
    if (www) return Promise.resolve(www);
    return withNoindex(request, envVar(env, "NOINDEX") === "true", () => withAuthRequestState(() => serve(request, env, ctx)));
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
    // sendDefaultPii stays at its default (off); the scrubber runs on every event.
    beforeSend: sentryPrivacy.beforeSend,
    beforeSendTransaction: sentryPrivacy.beforeSendTransaction,
  };
}, handler as never);

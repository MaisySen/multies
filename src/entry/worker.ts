/**
 * Cloudflare Workers entry: API on /api/*, the built SPA from the ASSETS binding
 * for everything else, D1 as the database. Housekeeping runs opportunistically
 * (at most every 10 minutes) and on a cron trigger when one is configured.
 */
import { kvToolFileStore, type AiRunner } from "../server/services/tools/p2-bindings";
import { movedPath } from "../shared/nav-menu"; // R121
import { WEB_META_PATHS } from "../server/routes/web-meta-r32"; // R32: /version.json, /llms.txt
import { isKnownPage } from "../shared/known-routes";
import { canonicalUrl, metaFor, SITE_URL } from "../web/components/seo-meta";
import { residencyStaticHtml, STATIC_FACTS_PATHS } from "../shared/residency"; // R60 (trust)

const cleanPath = (p: string) => p.replace(/\/+$/, "") || "/";
import { env as startupEnv } from "cloudflare:workers";
import { configureReporting, flushReporting, reportException, reportingClientExists, type ReportingEnv } from "./reporting";
import { drizzle } from "drizzle-orm/d1";
import { appPrebuild, createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { applyMigrations, INDEX_MIGRATIONS, migrationDriver, schema, type DB } from "../server/db";
import { DohResolver } from "../server/services/dns/resolver";
import { LogOutbound, ResendOutbound } from "../server/services/mail/outbound";
import { ResilientOutbound } from "../server/services/resilience";
import { getOrCreateStoredSecret, runMaintenanceIfMigrated } from "../server/services/maintenance";
import { toolsCronSteps } from "../server/services/tools/p2-cron"; // Tools P2
import { runCronSteps, type CronStep } from "../server/services/cron-steps"; // MPLAT-96
import type { Deps, RateLimitBinding } from "../server/context";
import { API_CSP, EMBED_FORM_PATH, PRIVATE_PAGE_PATH, appCsp, frameableCsp, isHttps, withSecurityHeaders } from "../server/lib/security-headers";
import { jsonLogger } from "../server/lib/logger";
import { withAuthRequestState } from "../server/lib/request-state";
import { S3BodyStore } from "../server/services/storage/body-store";
import { kvImportFileStore } from "../server/services/data-move/kept-file";
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
import { loadBody, syncConnection } from "../server/services/connect/sync";
import { LiveBudget, LiveMail, type LiveTouch } from "../server/services/connect/live";
import { withReadRetry } from "../server/lib/d1-busy";
import { withWriteMeter } from "../server/services/workspace-budget";
import { BRAND_CACHE, htmlCacheControl, AUTH_CARD_PATH, loginHtmlFor, originHintsFor, publicHtmlFor, shellFor, withOriginHints, type LoginPrerender } from "../shared/prerender-shell";
import { loginVariant, type LoginVariantOf } from "../server/auth/config";
import { authFor } from "../server/auth";
import { endWarmup, replayD1, warmHotRoutes, WARM_SECRET, type WarmFixture, type WarmReport } from "./warmup";
import warmFixtureJson from "./warm-fixture.json";
import { DocRoom as DocRoomClass } from "../server/collab/durable-object";
import { ThreadPresence as ThreadPresenceClass } from "../server/collab/thread-presence";
import { ChatHub as ChatHubClass } from "../server/realtime/chat-hub-do";
import { bindTestSessionEnv } from "../server/test-session-env-r45";
import { OPENAPI_ORIGIN_PLACEHOLDER } from "../server/routes/v1"; // R46
import { isWorkersDevHost, withRobotsHeader } from "@/server/lib/robots-host";

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
/** R66 (MB-259): e-sign's public pages exist only while the feature is on; otherwise /sign/* is any unknown page. */
async function esignOn(env: WorkerEnv): Promise<boolean> {
  const { deps } = await getReady(env);
  return deps.config.tools.enabled && deps.config.tools.features.includes("esign");
}

/** The built index.html, served by the Worker for every app route. */
declare const __MYMAIL_SHELL_HTML__: string;
/** R30: the shell with the landing page prerendered inside, served for "/" only (empty when not built). */
declare const __MYMAIL_LANDING_HTML__: string;
/** R30: the shell that preloads the sign in page's code, served for the auth pages (empty when not built). */
declare const __MYMAIL_AUTH_HTML__: string;
/** R34 (perf2): the sign in shell with critical CSS and one prerendered card per setup (null when not built). */
declare const __MYMAIL_LOGIN_PRERENDER__: LoginPrerender | null;
/** R76: the prerendered public pages, one HTML per path (scripts/prerender-landing.ts). */
declare const __MYMAIL_PUBLIC_HTML__: Record<string, string> | null;
/** The prerendered card this deployment shows, read from its config once per isolate. */
let loginCard: LoginVariantOf | null | undefined;
function loginCardFor(env: WorkerEnv): LoginVariantOf | null {
  if (loginCard !== undefined) return loginCard;
  try {
    const vars: Record<string, string | undefined> = { ...(typeof __MYMAIL_BUILD_ENV__ === "object" ? __MYMAIL_BUILD_ENV__ : {}) };
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") vars[k] = v;
    // Only the sign in setup is read here; a deployment whose secret is generated and stored in D1 is not refused for it.
    if (!vars.APP_SECRET && vars.ALLOW_GENERATED_SECRET === "true") vars.APP_SECRET = "x".repeat(48);
    loginCard = loginVariant(loadConfig(vars));
  } catch {
    loginCard = null; // a config the app itself would refuse: keep the plain sign in shell
  }
  return loginCard;
}

let ready: Promise<{ app: ReturnType<typeof createApp>; deps: Deps }> | null = null;
let lastMaintenance = 0;

async function boot(env: WorkerEnv) {
  // No migrations here: they run once per deploy (wrangler d1 migrations apply, or the
  // deploy hook below on hosts where wrangler cannot reach the database).
  // R28: a read retries once after a short pause when D1 is briefly unavailable (lib/d1-busy.ts).
  const db = drizzle(withWriteMeter(withReadRetry(env.DB)) as never, { schema }) as unknown as DB;
  const vars = envVars(env);
  if (!vars.APP_SECRET && vars.ALLOW_GENERATED_SECRET === "true") vars.APP_SECRET = await getOrCreateStoredSecret(db);
  return bootWith(env, db, vars);
}

function envVars(env: WorkerEnv): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = { ...(typeof __MYMAIL_BUILD_ENV__ === "object" ? __MYMAIL_BUILD_ENV__ : {}) };
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") vars[k] = v;
  return vars;
}

/** Synchronous part of boot: no I/O, so it can also run at isolate startup (R40, MB-199). */
function bootWith(env: WorkerEnv, db: DB, vars: Record<string, string | undefined>) {
  const config = loadConfig(vars);
  bindTestSessionEnv(vars); // R45: the app gets no env from app.fetch here, so the test session reads its settings from this.
  const outbound = config.outbound.driver === "resend" ? new ResilientOutbound(new ResendOutbound(config.outbound.resendApiKey!)) : new LogOutbound();
  const deps: Deps = {
    db, config, dns: new DohResolver(), outbound, now: () => new Date(), fetch: peerAwareFetch(env),
    log: jsonLogger({ service: "mymail-api", release: config.release, env: config.sentry.environment }),
    // R43 (MB-199): reported through our own lazily created client (src/entry/reporting.ts), not a request wrapper.
    reportError: config.sentry.dsnApi ? (err, context) => reportException(err, context) : undefined,
    bodyStore: config.bodyStore ? new S3BodyStore(config.bodyStore) : undefined,
    importFiles: env.IMPORT_FILES ? kvImportFileStore(env.IMPORT_FILES) : undefined, // R43
    // Tools P2: Workers AI (hard capped by the AI meter) and files kept past one job (KV with expiry, no R2).
    ai: env.AI ? (env.AI as AiRunner) : undefined,
    toolFiles: env.IMPORT_FILES ? kvToolFileStore(env.IMPORT_FILES) : undefined,
    // Tools P2 (17): the attachment text index lives in its own D1 database (no virtual table in the main one).
    indexDb: env.INDEX_DB ? drizzle(withReadRetry(env.INDEX_DB) as never, { schema }) as unknown as DB : undefined,
    filesDb: env.FILES_DB ? drizzle(withReadRetry(env.FILES_DB) as never, { schema }) as unknown as DB : undefined, // R101
    openSocket: workerSocketOpener,
    dispatchMailSync: mailSyncDispatcher(env),
    loadMailBody: mailBodyDispatcher(env),
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

/** R57: an older message's body is fetched in a Durable Object (named by mailbox), where the CPU allowance fits a MIME parse. */
function mailBodyDispatcher(env: WorkerEnv): ((mailboxId: string, messageId: string) => Promise<void>) | undefined {
  const ns = env.MAIL_SYNC as DurableObjectNamespaceLike | undefined;
  if (!ns || typeof ns.idFromName !== "function") return undefined;
  return async (mailboxId: string, messageId: string) => {
    const res = await ns.get(ns.idFromName(`body:${mailboxId}`)).fetch(new Request("https://mail-sync/body", { method: "POST", body: JSON.stringify({ messageId }) }));
    if (!res.ok) throw new Error(`mail body answered ${res.status}`);
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
    if (path === "/body") {
      const { messageId } = (await request.json()) as { messageId: string };
      const { deps } = await getReady(this.env);
      return Response.json({ loaded: await loadBody({ ...deps, loadMailBody: undefined, dispatchMailSync: undefined }, messageId) });
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
    // R57: while only older mail is left, the next pass follows sooner (it is header only and cheap).
    if (r.more && !r.skipped) await this.state.storage.setAlarm(Date.now() + (r.backfilled && r.backfilled === r.stored ? 10_000 : 20_000));
    return { stored: r.stored, more: r.more, skipped: r.skipped ?? null };
  }
}

/** A Cloudflare rate limiting binding, when wrangler.toml declares one. */
function binding(v: unknown): RateLimitBinding | undefined {
  return v && typeof (v as RateLimitBinding).limit === "function" ? (v as RateLimitBinding) : undefined;
}

let pageHeaders: { csp: string; hsts: boolean } | null = null;
let formPageHeaders: { csp: string; hsts: boolean } | null = null;
let privatePageHeaders: { csp: string; hsts: boolean } | null = null; // R112

function getReady(env: WorkerEnv) {
  ready ??= boot(env).catch((err) => { ready = null; throw err; });
  return ready;
}

/*
 * R40 (MB-199): the free plan stops a request at 10 ms of CPU, and building the app (config, the route
 * table, the router's matchers and the sign in library) took about 60 ms inside the first request of every new
 * isolate. Script startup has its own, much larger allowance, so when the bindings are readable at startup and
 * the app secret is set (no D1 read needed), the app is built here, before any request. No I/O, no timers and
 * no random values happen in this step. Anything that fails leaves `ready` empty and the first request boots
 * as before.
 */
export function startupBoot(env: WorkerEnv | undefined): boolean {
  try {
    if (!env || !env.DB || ready) return false;
    const vars = envVars(env);
    if (!vars.APP_SECRET) return false;
    const db = drizzle(withWriteMeter(withReadRetry(env.DB)) as never, { schema }) as unknown as DB;
    const built = bootWith(env, db, vars);
    // Hono compiles a method's route matcher on its first match; do it now for the common methods.
    const router = (built.app as unknown as { router?: { match: (m: string, p: string) => unknown } }).router;
    for (const m of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
      try { router?.match(m, "/api/account/me"); } catch { /* compiled on first request instead */ }
    }
    // The sign in library's instance too (about 20 ms of setup otherwise paid by the first signed in request).
    try { authFor(built.deps); } catch { /* built on first use instead */ }
    // R45 (MB-199): and the public API (about 150 OpenAPI routes, 12 to 34 ms locally), which the first /api/v1 request
    // of every new isolate used to build. STARTUP_V1=off moves it back to the first request.
    if (vars.STARTUP_V1 !== "off") { try { appPrebuild.get(built.app)?.(); v1BuiltAtStartup = true; } catch { /* built on first use instead */ } }
    ready = Promise.resolve(built);
    if (vars.STARTUP_BOOT_LOG === "1") console.log("[startup] app built before the first request");
    if (vars.STARTUP_WARM !== "off") startupWarm(env, vars);
    return true;
  } catch (err) {
    ready = null;
    console.warn("[startup] app build moved to the first request:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
/**
 * R42 (MB-199, cold start): answers the hot signed in GETs once from a throwaway copy of the app on a replay only
 * fake database, so the engine has compiled the request path before the first real request (src/entry/warmup.ts).
 * The copy shares no config, database, bindings or caches with the real app. STARTUP_WARM=off turns it off.
 */
export let lastWarmReport: WarmReport | null = null;
/** R45 (MB-199): whether the public API was built at isolate startup (shown on the first request log line). */
let v1BuiltAtStartup = false;
function startupWarm(_env: WorkerEnv, vars: Record<string, string | undefined>) {
  try {
    const fixture = warmFixtureJson as unknown as WarmFixture;
    if (!fixture?.routes?.length) return;
    const origin = vars.APP_URL && /^https?:\/\//.test(vars.APP_URL) ? vars.APP_URL.replace(/\/+$/, "") : "https://multies.si";
    const wvars: Record<string, string | undefined> = { ...vars, APP_SECRET: WARM_SECRET, OUTBOUND_DRIVER: "log", RESEND_API_KEY: undefined, SENTRY_DSN_API: undefined, STRIPE_SECRET_KEY: undefined, LIVEKIT_API_SECRET: undefined };
    const wdb = drizzle(replayD1(fixture) as never, { schema }) as unknown as DB;
    const wenv = { DB: replayD1(fixture), ASSETS: { fetch: async () => { throw new Error("warm up: no assets"); } } } as unknown as WorkerEnv;
    const copy = bootWith(wenv, wdb, wvars);
    // Only the app copy is warmed, never the outer error reporting wrapper: that wrapper keeps one client per isolate
    // with the address it was first given, so warming it would send every later report to the warm up's address.
    void warmHotRoutes(copy.app as never, fixture, origin, (fn) => withAuthRequestState(fn))
      .then((r) => { lastWarmReport = r; if (vars.STARTUP_BOOT_LOG === "1") console.log("[startup] warm up", JSON.stringify(r)); })
      .catch(() => { endWarmup(); });
  } catch {
    endWarmup(); // less warm, never broken
  }
}

// The Durable Object classes are entry points too: each of their handlers puts the platform classes back first.
for (const cls of [DocRoomClass, ThreadPresenceClass, ChatHubClass, MailSyncRunner] as unknown as { prototype: Record<string, unknown> }[]) {
  for (const name of ["fetch", "alarm", "webSocketMessage", "webSocketClose", "webSocketError"]) {
    const orig = cls?.prototype?.[name];
    if (typeof orig !== "function") continue;
    cls.prototype[name] = function (this: unknown, ...args: unknown[]) { endWarmup(); return (orig as (...a: unknown[]) => unknown).apply(this, args); };
  }
}

startupBoot(startupEnv as unknown as WorkerEnv | undefined);

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
  // Tools P2 (17): the attachment text index database, when bound, has its own migrations (drizzle-index/).
  if (env.INDEX_DB) applied.push(...(await applyMigrations(migrationDriver(env.INDEX_DB), INDEX_MIGRATIONS)).map((n) => `index:${n}`));
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
 * R46: GET /api/v1/openapi.json from the file the build wrote (_spec/openapi-v1.json), with this host's origin in place
 * of the placeholder, so no isolate builds the document (that walked every route schema: 266 to 413 ms of CPU). Null
 * when the file is missing (an older build, a host without assets) and the app route builds it as before.
 */
let openApiCache: { origin: string; text: string } | null = null;
async function builtOpenApi(env: WorkerEnv, url: URL): Promise<Response | null> {
  if (openApiCache?.origin !== url.origin) {
    try {
      const res = await env.ASSETS.fetch(new Request(new URL("/_spec/openapi-v1.json", url.origin)));
      if (!res.ok) return null;
      const text = (await res.text()).replace(OPENAPI_ORIGIN_PLACEHOLDER, url.origin);
      openApiCache = { origin: url.origin, text };
    } catch { return null; }
  }
  return new Response(openApiCache.text, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
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
  if (url.pathname === "/api/v1/openapi.json" && request.method === "GET") {
    const spec = await builtOpenApi(env, url);
    if (spec) return withSecurityHeaders(spec, apiHeaders);
  }
  if (url.pathname.startsWith("/api/") || (url.pathname === "/delete-account" && request.method === "POST") /* R83: Threads uninstall and delete callbacks */ || WEB_META_PATHS.has(url.pathname) || url.pathname === "/health" || url.pathname === "/healthz" || url.pathname.startsWith("/cal/") || url.pathname.startsWith("/s/") || url.pathname.startsWith("/help/") /* R122: public help center */ || url.pathname.startsWith("/site/") || url.pathname.startsWith("/share/snapchat") /* R132: Snapchat share page and its copy script (404 from the app while SOCIAL_P3_R132 is off) */ || url.pathname === "/site-assets/comments.js" /* R123: public sites */ || url.pathname === "/site-assets/blog.js" /* R124: blog subscribe box */ || url.pathname.startsWith("/d/") || url.pathname.startsWith("/u/") || url.pathname.startsWith("/x/") /* R88: file requests and secret links */ || url.pathname.startsWith("/l/") || url.pathname.startsWith("/bio/") /* R87: short links and bio pages */ || url.pathname === "/widget.js" || url.pathname === "/forms-embed.js" /* R93 */ || url.pathname.startsWith("/csat/") /* R119: website chat script and the one tap survey */ || url.pathname === "/dav" || url.pathname.startsWith("/dav/") || url.pathname === "/.well-known/caldav" || url.pathname === "/.well-known/carddav" /* R99: CalDAV and CardDAV */ || url.pathname.startsWith("/p/") /* R120: client portal pages */ || (url.pathname.startsWith("/sign/") && await esignOn(env)) /* Tools P2: share and signing pages (R66: /sign is a plain not found page while e-sign is off) */ || url.pathname === "/.well-known/security.txt" || url.pathname.startsWith("/.well-known/oauth-") || url.pathname === "/.well-known/openid-configuration" || url.pathname === "/auth/mobile/web" /* MH1: app to web sign in handoff (404 while MOBILE_WEB_LINK is off) */) {
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
  // F13: no analytics beacon host (the page policy names only our own scripts).
  const cspBase = { appUrl: envVar(env, "APP_URL") ?? url.origin, livekitUrl: envVar(env, "LIVEKIT_URL") };
  pageHeaders ??= { csp: appCsp(cspBase), hsts: isHttps(url.origin) };
  // F13: public form pages run only our own scripts too (same policy as every page).
  formPageHeaders ??= { csp: appCsp(cspBase), hsts: isHttps(url.origin) };
  // R112: the anonymous report and data request pages: no error reporting or analytics host, no referrer (set below).
  privatePageHeaders ??= { csp: appCsp({ ...cspBase, anonymous: true }), hsts: isHttps(url.origin) };
  const privatePage = PRIVATE_PAGE_PATH.test(url.pathname);
  let headers = url.pathname.startsWith("/f/") ? formPageHeaders : privatePage ? privatePageHeaders : pageHeaders;
  // R93: the form inside the website bubble may be framed by other sites (x-frame-options dropped below).
  const embedForm = EMBED_FORM_PATH.test(url.pathname) && ["true", "1"].includes(envVar(env, "FORMS_PLUS_R93") ?? "");
  if (embedForm) headers = { ...formPageHeaders, csp: frameableCsp(formPageHeaders.csp) };
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
  // R121 (NAV_P2_R121): an old mail setup address (a bookmark, a shared link) lands in Settings, Mail setup.
  // 302, not 301: browsers keep a 301, and the switch can still be turned off.
  if (request.method === "GET" && ["on", "true", "1"].includes((envVar(env, "NAV_P2_R121") ?? "").toLowerCase())) {
    const moved = movedPath(url.pathname);
    if (moved) return new Response(null, { status: 302, headers: { location: `${moved}${url.search}`, "cache-control": "no-store" } });
  }
  // Every app route renders the app shell, which routes client-side.
  const shell = typeof __MYMAIL_SHELL_HTML__ === "string"
    ? new Response(withOriginHints((AUTH_CARD_PATH.test(url.pathname) && typeof __MYMAIL_LOGIN_PRERENDER__ === "object" ? loginHtmlFor(url.pathname, url.search, __MYMAIL_LOGIN_PRERENDER__, loginCardFor(env)) : null) ?? shellFor(url.pathname, __MYMAIL_SHELL_HTML__, typeof __MYMAIL_LANDING_HTML__ === "string" ? __MYMAIL_LANDING_HTML__ : null, typeof __MYMAIL_AUTH_HTML__ === "string" ? __MYMAIL_AUTH_HTML__ : null, typeof __MYMAIL_PUBLIC_HTML__ === "object" ? __MYMAIL_PUBLIC_HTML__ : null), originHintsFor(envVar(env, "SENTRY_DSN_WEB"))), { headers: { "content-type": "text/html; charset=utf-8" } })
    : await env.ASSETS.fetch(new Request(new URL("/", url), { headers: request.headers }));
  // Unknown pages still get the app (it shows page-not-found) but with a real 404 status.
  const res = withSecurityHeaders(new Response(request.method === "HEAD" ? null : shell.body, { status: isKnownPage(url.pathname) ? 200 : 404, headers: shell.headers }), headers);
  if (embedForm) res.headers.delete("x-frame-options"); // R93
  if (privatePage) res.headers.set("referrer-policy", "no-referrer"); // R112
  res.headers.set("cache-control", htmlCacheControl("no-cache"));
  const prerendered = typeof __MYMAIL_PUBLIC_HTML__ === "object" && !!publicHtmlFor(url.pathname, __MYMAIL_PUBLIC_HTML__);
  return request.method === "HEAD" ? res : withPageMeta(res, url.pathname, prerendered);
}

/**
 * Puts the page's own title, description, canonical and social tags into the shell, so crawlers and
 * link previews that do not run scripts see the right ones. A streaming rewrite: no extra CPU to speak of.
 */
interface RewriterElement { setAttribute(name: string, value: string): void; setInnerContent(text: string, opts?: { html: boolean }): void; append(content: string, opts?: { html: boolean }): void; after(content: string, opts?: { html: boolean }): void }
interface Rewriter { on(selector: string, handler: { element(el: RewriterElement): void }): Rewriter; transform(res: Response): Response }
declare const HTMLRewriter: { new (): Rewriter } | undefined;

function withPageMeta(res: Response, path: string, prerendered = false): Response {
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
    // W1: each product area page has its own link preview picture.
    .on('meta[property="og:image"]', content(meta.image ?? `${SITE_URL}/og-image.png`))
    .on('meta[name="twitter:image"]', content(meta.image ?? `${SITE_URL}/og-image.png`))
    .on('meta[property="og:image:alt"]', content(meta.title))
    .on('link[rel="canonical"]', { element: (el) => { el.setAttribute("href", canonicalUrl(path)); } })
    .on("head", { element: (el) => { if (meta.noindex) el.append('<meta name="robots" content="noindex" />', { html: true }); } })
    // R60 (trust): residency, safe trial and connections as plain HTML for readers that do not run scripts.
    // R76: a prerendered page already carries its content for those readers; the facts then follow it in <noscript>, so
    // the markup React hydrates is left exactly as the build rendered it.
    .on("#root", { element: (el) => {
      if (!STATIC_FACTS_PATHS.has(cleanPath(path))) return;
      if (prerendered) el.after(`<noscript>${residencyStaticHtml()}</noscript>`, { html: true });
      else el.setInnerContent(residencyStaticHtml(), { html: true });
    } })
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
  if (!noindex) return isWorkersDevHost(request.url) ? withRobotsHeader(await next()) : next();
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
    ctx.waitUntil(runScheduledSteps(deps));
  },
};

/**
 * The cron tick's passes, in this order, one after another (MPLAT-96: never all in the same second). Each pass is
 * guarded, so one that fails is reported and the next still runs.
 */
export function scheduledSteps(deps: Deps): CronStep[] {
  const lazy = (name: string, where: string, run: () => Promise<unknown>): CronStep => ({
    name,
    run: () => run().catch((err: unknown) => deps.reportError?.(err, { where })),
  });
  const steps: CronStep[] = [
    // R50 (CPU limit): the cron pass rotates its hourly housekeeping across the four passes of each hour.
    { name: "maintenance", run: () => runMaintenanceIfMigrated(deps, { rotate: true }) },
    // Tools P2: share and signing, mail merge, AI usage housekeeping and the attachment index, each on its own.
    ...toolsCronSteps(deps),
  ];
  // R111: mail retention (MAIL_ARCHIVE_R111): only workspaces whose admin turned a policy on, past its 7 day grace.
  if (deps.config.mailArchive) steps.push(lazy("mail.retention_pass", "mail.retention_pass", () => import("../server/services/mail/archive-r111").then((m) => m.runRetentionPass(deps))));
  // R105: repeating invoices and payment reminders (INVOICES_ENABLED), bounded per pass.
  if (deps.config.invoicesEnabled) steps.push(lazy("invoices.cron", "invoices.cron", () => import("../server/services/invoices/deliver").then((m) => m.runInvoiceCron(deps))));
  // R129: course due soon and overdue reminders (COURSES_R129), 100 a pass.
  if (deps.config.coursesR129) steps.push(lazy("courses.reminders", "courses.reminders", () => import("../server/services/courses-r129").then((m) => m.runCourseReminders(deps))));
  // TD8: Team AI routines due now and runs left waiting (TEAMAI_TD8), 10 runs a pass on the workspace's own key.
  if (deps.config.teamaiTd8) steps.push(lazy("teamai.pass", "teamai.pass", () => import("../server/services/teamai-td8").then((m) => m.runTeamAiPass(deps))));
  // R97: due notification digests (50 a run, only rows whose digest time has come).
  if (deps.config.notificationCentre !== false) steps.push(lazy("notify.digest_pass", "notify.digest_pass", () => import("../server/services/suite/notify-centre-r97").then((m) => m.runNotificationDigests(deps))));
  return steps;
}

/** R43: what the passes report is sent before the run ends. */
async function runScheduledSteps(deps: Deps) {
  // F3: each pass has its own time limit, so the final flush is always reached; a failed or timed out pass flushes at once.
  try { await runCronSteps(deps, scheduledSteps(deps), { flush: () => flushReporting() }); } finally { await flushReporting(); }
}

const buildEnv = (typeof __MYMAIL_BUILD_ENV__ === "object" ? __MYMAIL_BUILD_ENV__ : {}) as Record<string, string | undefined>;

/** R43: the reporting settings (no SDK work; the client is made only when an error is reported). */
function reportingEnv(env: WorkerEnv): ReportingEnv {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    dsn: str(env.SENTRY_DSN_API) ?? buildEnv.SENTRY_DSN_API,
    environment: str(env.SENTRY_ENVIRONMENT) ?? buildEnv.SENTRY_ENVIRONMENT ?? "production",
    release: str(env.RELEASE) ?? buildEnv.RELEASE,
  };
}

/**
 * R43: a deliberately thrown error, to prove end to end that an error escaping a request still reaches error
 * reporting. Answers only POST /api/_report-test with the header x-report-test equal to the REPORT_TEST_TOKEN secret
 * (at least 32 characters). Without that secret set (the normal state) the path is an ordinary 404.
 */
export class ReportTestError extends Error {}
function reportTest(request: Request, env: WorkerEnv) {
  const token = typeof env.REPORT_TEST_TOKEN === "string" ? env.REPORT_TEST_TOKEN : "";
  if (token.length < 32 || request.method !== "POST") return;
  if (new URL(request.url).pathname !== "/api/_report-test") return;
  const given = request.headers.get("x-report-test") ?? "";
  let diff = given.length ^ token.length;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ given.charCodeAt(i % Math.max(1, given.length));
  if (diff !== 0) return;
  throw new ReportTestError(`Multies API report test (${new Date().toISOString()})`);
}

/*
 * R42: the real entry points put the platform classes back first (a no-op unless a startup warm up is somehow
 * still holding its stand ins), so no real request or cron run ever sees them.
 */
// One line per isolate, on its first request: whether the startup warm up ran and how it went (MB-199 evidence in
// the tail; startup logs themselves are not delivered there). reportingClientBefore must stay false: nothing makes a
// reporting client before a real error (R42 incident, R43 lazy client).
let firstRequestSeen = false;
function noteFirstRequest(request: Request) {
  if (firstRequestSeen) return;
  firstRequestSeen = true;
  try { console.log("[isolate] first request", JSON.stringify({ path: new URL(request.url).pathname, warm: lastWarmReport, reportingClientBefore: reportingClientExists() || Boolean((globalThis as Record<string, unknown>).__SENTRY_CLOUDFLARE_CLIENT__), reporting: "lazy", v1: v1BuiltAtStartup ? "startup" : "lazy" })); } catch { /* never in the way */ }
}
export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    endWarmup(); noteFirstRequest(request);
    const e = env as WorkerEnv, c = ctx as ExecutionContext;
    configureReporting(reportingEnv(e));
    try {
      reportTest(request, e);
      return await handler.fetch(request, e, c);
    } catch (err) {
      const eventId = reportException(err, { method: request.method, path: new URL(request.url).pathname, where: "worker.fetch" });
      c.waitUntil(flushReporting());
      if (err instanceof ReportTestError) return Response.json({ error: { code: "report_test", message: "Test error sent to error reporting.", details: { eventId: eventId ?? null } } }, { status: 500 });
      throw err;
    } finally {
      if (reportingClientExists()) c.waitUntil(flushReporting());
    }
  },
  async scheduled(event: unknown, env: unknown, ctx: unknown) {
    endWarmup();
    const e = env as WorkerEnv, c = ctx as ExecutionContext;
    configureReporting(reportingEnv(e));
    try {
      await handler.scheduled(event, e, c);
    } catch (err) {
      reportException(err, { where: "worker.scheduled" });
      c.waitUntil(flushReporting());
      throw err;
    }
  },
};

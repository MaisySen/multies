/**
 * Cloudflare Workers entry: API on /api/*, the built SPA from the ASSETS binding
 * for everything else, D1 as the database. Housekeeping runs opportunistically
 * (at most every 10 minutes) and on a cron trigger when one is configured.
 */
import { drizzle } from "drizzle-orm/d1";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { migrate, schema, type DB } from "../server/db";
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
  const db = drizzle(env.DB as never, { schema }) as unknown as DB;
  await migrate(db);
  const vars: Record<string, string | undefined> = { ...(typeof __MYMAIL_BUILD_ENV__ === "object" ? __MYMAIL_BUILD_ENV__ : {}) };
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") vars[k] = v;
  if (!vars.APP_SECRET && vars.ALLOW_GENERATED_SECRET === "true") vars.APP_SECRET = await getOrCreateStoredSecret(db);
  const config = loadConfig(vars);
  const outbound = config.outbound.driver === "resend" ? new ResendOutbound(config.outbound.resendApiKey!) : new LogOutbound();
  const deps: Deps = { db, config, dns: new DohResolver(), outbound, now: () => new Date(), fetch: (input, init) => fetch(input, init) };
  return { app: createApp(deps), deps };
}

function getReady(env: WorkerEnv) {
  ready ??= boot(env).catch((err) => { ready = null; throw err; });
  return ready;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
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

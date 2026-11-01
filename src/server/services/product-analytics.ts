import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv, Deps } from "../context";
import { organizations } from "../db/schema";
import { isAnalyticsEvent, sanitizeProps, type AnalyticsAction, type AnalyticsEventName } from "@/shared/product-analytics";

/**
 * ANALYTICS-PH: server side of product usage analytics (see src/shared/product-analytics.ts for the rules).
 * Events go to the analytics project with its HTTP batch API, fire and forget (waitUntil), never blocking a request.
 */
export interface ProductAnalyticsConfig {
  key: string;
  host: string;
  hashKey: string;
  /** Workspaces that never send anything: matched against the workspace id, slug and name (lower case). */
  exclude: string[];
}

const on = (v: string | undefined) => ["1", "true", "on", "yes"].includes(String(v ?? "").trim().toLowerCase());

/** Null (off) unless ANALYTICS_PH is on and the project key, host and hash key are all set. */
export function productAnalyticsConfig(env: Record<string, string | undefined>): ProductAnalyticsConfig | null {
  if (!on(env.ANALYTICS_PH)) return null;
  const key = env.POSTHOG_KEY?.trim() ?? "";
  const hashKey = env.ANALYTICS_HASH_KEY?.trim() ?? "";
  let host = (env.POSTHOG_HOST?.trim() || "https://eu.i.posthog.com").replace(/\/+$/, "");
  try { if (new URL(host).protocol !== "https:") return null; } catch { return null; }
  if (!/^phc_[A-Za-z0-9]{20,}$/.test(key) || hashKey.length < 32) return null;
  const exclude = (env.ANALYTICS_EXCLUDE ?? "vv8k").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!exclude.includes("vv8k")) exclude.push("vv8k");
  host = host.replace(/^https:\/\/(eu|us)\.posthog\.com$/, "https://$1.i.posthog.com");
  return { key, host, hashKey, exclude };
}

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();
/** Keyed hash (HMAC SHA-256, first 32 hex characters) of an id, with a kind prefix so ids of different kinds never collide. */
export async function hashId(hashKey: string, kind: "user" | "workspace", id: string): Promise<string> {
  let k = keyCache.get(hashKey);
  if (!k) { k = crypto.subtle.importKey("raw", enc.encode(hashKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); keyCache.set(hashKey, k); }
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await k, enc.encode(`${kind}:${id}`)));
  return Array.from(sig.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isExcludedWorkspace(cfg: ProductAnalyticsConfig, org: { id: string; slug?: string | null; name?: string | null }): boolean {
  const hay = [org.id, org.slug ?? "", org.name ?? ""].map((s) => s.toLowerCase());
  return cfg.exclude.some((x) => hay.some((h) => h === x || h.includes(x)));
}

/** Do Not Track or Global Privacy Control on the request. */
export function requestOptedOut(header: (name: string) => string | undefined): boolean {
  return header("dnt") === "1" || header("sec-gpc") === "1";
}

type OrgFacts = { excluded: boolean; plan: string };
const orgCache = new Map<string, { at: number; facts: OrgFacts | null }>();
const ORG_TTL_MS = 10 * 60_000;
/** Plan and exclusion for a workspace, read once per isolate per 10 minutes (one small read, off the request path). */
export async function orgFacts(deps: Deps, cfg: ProductAnalyticsConfig, orgId: string): Promise<OrgFacts | null> {
  const hit = orgCache.get(orgId);
  if (hit && Date.now() - hit.at < ORG_TTL_MS) return hit.facts;
  const row = await deps.db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name, plan: organizations.plan })
    .from(organizations).where(eq(organizations.id, orgId)).get();
  const facts = row ? { excluded: isExcludedWorkspace(cfg, row), plan: row.plan } : null;
  if (orgCache.size > 5000) orgCache.clear();
  orgCache.set(orgId, { at: Date.now(), facts });
  return facts;
}
export function clearOrgFactsCache() { orgCache.clear(); }

export interface AnalyticsEventIn { name: AnalyticsEventName; props?: Record<string, unknown> }
type Transport = (url: string, body: string) => Promise<unknown>;
let transport: Transport = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
/** Tests replace the network call (no real requests in tests or CI). */
export function setAnalyticsTransport(t: Transport | null) {
  transport = t ?? ((url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body }));
}

/**
 * Sends events for one person (or, with no userId, for the workspace itself, as the billing webhook does).
 * Never throws; drops everything for excluded workspaces and for names outside the allow list.
 */
export async function captureEvents(deps: Deps, input: { orgId: string; userId?: string | null; events: AnalyticsEventIn[] }): Promise<number> {
  const cfg = deps.config.productAnalytics;
  if (!cfg || !input.orgId) return 0;
  try {
    const events = input.events.filter((e) => isAnalyticsEvent(e.name)).slice(0, 20);
    if (!events.length) return 0;
    const facts = await orgFacts(deps, cfg, input.orgId);
    if (!facts || facts.excluded) return 0;
    const workspace = await hashId(cfg.hashKey, "workspace", input.orgId);
    const distinct = input.userId ? await hashId(cfg.hashKey, "user", input.userId) : `ws_${workspace}`;
    const timestamp = new Date().toISOString();
    const batch = events.map((e) => ({
      event: e.name,
      distinct_id: distinct,
      timestamp,
      properties: {
        ...sanitizeProps(e.props),
        plan: facts.plan,
        workspace_hash: workspace,
        $groups: { workspace },
        $lib: "multies-server",
        $process_person_profile: false,
        $geoip_disable: true,
        $ip: null,
      },
    }));
    await transport(`${cfg.host}/batch/`, JSON.stringify({ api_key: cfg.key, historical_migration: false, batch }));
    return batch.length;
  } catch (err) {
    deps.log?.warn("analytics.capture_failed", { error: String(err).slice(0, 200) });
    return 0;
  }
}

/** Runs work after the response when the platform allows it (Workers waitUntil), else awaits it. */
export async function runAfterResponse(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, work: Promise<unknown>) {
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try { const ctx = c.executionCtx; waitUntil = ctx.waitUntil.bind(ctx); } catch { waitUntil = undefined; }
  if (waitUntil) waitUntil(work); else await work;
}

/** Key actions: a successful request to one of these routes is the action. Only the route is used, never the body. */
const ACTION_ROUTES: Array<{ method: string; re: RegExp; event: AnalyticsAction; ok?: (status: number, location: string | undefined) => boolean; source?: string }> = [
  { method: "POST", re: /^\/api\/mail\/send\/?$/, event: "mail_sent" },
  { method: "POST", re: /^\/api\/tasks\/?$/, event: "task_created" },
  { method: "POST", re: /^\/api\/docs\/?$/, event: "doc_created" },
  { method: "POST", re: /^\/api\/social\/posts\/?$/, event: "social_post_created" },
  { method: "POST", re: /^\/api\/(?:team|invites)\/invites\/?$/, event: "invite_sent" },
  { method: "POST", re: /^\/api\/invites\/?$/, event: "invite_sent" },
  { method: "POST", re: /^\/api\/billing\/checkout\/?$/, event: "upgrade_started" },
  { method: "POST", re: /^\/api\/connections\/?$/, event: "mail_account_connected", source: "password" },
  {
    method: "GET", re: /^\/api\/connections\/oauth\/[a-z0-9_-]+\/callback\/?$/, event: "mail_account_connected", source: "oauth",
    ok: (status, location) => status >= 300 && status < 400 && /[?&]connected=/.test(location ?? ""),
  },
  { method: "POST", re: /^\/api\/social\/connect\/?$/, event: "social_connect_started" },
];

export function actionFor(method: string, path: string, status: number, location?: string): { event: AnalyticsAction; source?: string } | null {
  for (const r of ACTION_ROUTES) {
    if (r.method !== method || !r.re.test(path)) continue;
    const ok = r.ok ? r.ok(status, location) : status >= 200 && status < 300;
    return ok ? { event: r.event, ...(r.source ? { source: r.source } : {}) } : null;
  }
  return null;
}

/** Middleware for /api/*: after a successful key action, records it (off unless ANALYTICS_PH is on). */
export const productAnalyticsActions: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const deps = c.var.deps;
  if (!deps?.config.productAnalytics) return;
  try {
    const hit = actionFor(c.req.method, c.req.path, c.res.status, c.res.headers.get("location") ?? undefined);
    const auth = c.var.auth;
    if (!hit || !auth?.orgId || requestOptedOut((n) => c.req.header(n))) return;
    await runAfterResponse(c, captureEvents(deps, { orgId: auth.orgId, userId: auth.userId, events: [{ name: hit.event, props: hit.source ? { source: hit.source } : {} }] }));
  } catch {
    /* analytics never breaks a request */
  }
};

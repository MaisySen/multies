/**
 * R80C: Connections. Each workspace connects its own outside accounts (social networks first, then the rest of the
 * integration catalog) through the integration platform's hosted connect page. The platform keeps the sign in tokens;
 * we keep nothing but the platform's account ids on social post targets. One platform user per workspace and host:
 * "<host>:<orgId>", so staging and production never see each other's accounts inside the one shared project.
 *
 * Everyone in the workspace can see what is connected; only owners and admins connect, reconnect, disconnect or post.
 * Every connect and disconnect is audited.
 */
import { and, desc, eq } from "drizzle-orm";
import { inIds } from "../../lib/sql-chunks";
import { socialPostTargets, socialPosts } from "../../db/schema";
import type { AuthContext, Deps } from "../../context";
import { audit } from "../audit";
import { HttpError, forbidden, tooMany } from "../../lib/errors";
import { RateLimiter } from "../../lib/rate-limit";
import { APP_NAME_OVERRIDES, canPostTo, type AccountStatus, type ConnectedAccountView } from "@/shared/integrations";
import { composioFrom, IntegrationError, type Composio, type CpAccount, type CpToolkit } from "./composio";

export const isAdmin = (a: Pick<AuthContext, "role">) => a.role === "owner" || a.role === "admin";

/** Connect, reconnect and disconnect per workspace: 20 a minute is far above a person and well below abuse. */
const writeLimiter = new RateLimiter(20, 60_000);
/** Reads per workspace (each is one platform call). */
const readLimiter = new RateLimiter(120, 60_000);

export function limitWrite(orgId: string) { if (!writeLimiter.take(orgId)) throw tooMany("Too many changes at once. Try again in a minute."); }
export function limitRead(orgId: string) { if (!readLimiter.take(orgId)) throw tooMany("Too many requests. Try again in a minute."); }

export function toHttp(err: unknown): never {
  if (err instanceof IntegrationError) {
    if (err.code === "not_found") throw new HttpError(404, "not_found", "That connection was not found.");
    if (err.code === "bad_request") throw new HttpError(422, "rejected", err.message);
    throw new HttpError(503, err.code, err.message);
  }
  throw err;
}

export function platform(deps: Deps): Composio {
  try { return composioFrom(deps); } catch (err) { return toHttp(err); }
}

/** For routes that name one connection: with Connections switched off there is no such connection (404, not 503). */
export function platformForId(deps: Deps): Composio {
  if (!deps.config.integrations.composio) throw new HttpError(404, "not_found", "That connection was not found.");
  return platform(deps);
}

export const platformUserId = (cp: Pick<Composio, "userPrefix">, orgId: string) => `${cp.userPrefix}:${orgId}`;

export function appLabel(slug: string): string {
  return APP_NAME_OVERRIDES[slug] ?? slug.split(/[_-]/).map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}

export function statusOf(s: string | undefined): AccountStatus {
  switch ((s ?? "").toUpperCase()) {
    case "ACTIVE": return "active";
    case "INITIALIZING": case "INITIATED": return "pending";
    case "EXPIRED": return "expired";
    case "INACTIVE": case "DISABLED": return "disabled";
    default: return "failed";
  }
}

export function viewOf(a: CpAccount): ConnectedAccountView {
  const app = a.toolkit?.slug ?? "unknown";
  return {
    id: a.id,
    app,
    appName: appLabel(app),
    logo: `/api/apps/logo/${encodeURIComponent(app)}`,
    status: statusOf(a.status),
    label: a.alias?.trim() || null,
    createdAt: a.created_at ?? new Date(0).toISOString(),
  };
}

function withProfile(v: ConnectedAccountView, p: { name: string | null; avatarUrl: string | null } | null | undefined): ConnectedAccountView {
  return { ...v, name: p?.name ?? null, avatarUrl: p?.avatarUrl ?? null };
}

/** The workspace's accounts. Pending ones older than an hour are left-over connect attempts and are not shown. */
export async function listAccounts(deps: Deps, auth: AuthContext): Promise<ConnectedAccountView[]> {
  const cp = platform(deps);
  limitRead(auth.orgId);
  let rows: CpAccount[];
  try { rows = await cp.accounts(platformUserId(cp, auth.orgId)); } catch (err) { return toHttp(err); }
  const staleBefore = deps.now().getTime() - 3_600_000;
  const userId = platformUserId(cp, auth.orgId);
  const mine = rows.filter((a) => a.user_id === undefined || a.user_id === userId);
  // SA1: names and pictures for social accounts, and one row per network account (older duplicates fold in).
  let profiles = new Map<string, { name: string | null; avatarUrl: string | null }>();
  let merged = new Set<string>();
  if (mine.some((a) => canPostTo(a.toolkit?.slug ?? ""))) {
    try {
      const { backfillProfiles } = await import("./account-profiles");
      ({ profiles, merged } = await backfillProfiles(deps, cp, auth.orgId, userId, mine, canPostTo));
    } catch (err) { deps.log?.warn("social.profiles_failed", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) }); }
  }
  // SOC1: whether LinkedIn granted organization access (company Pages), read from the login's granted scope.
  const soc1 = deps.config.socialMultiSoc1 === true;
  const orgScope = (a: CpAccount) => { const v = (a as unknown as { state?: { val?: { scope?: unknown; scopes?: unknown } } }).state?.val; const sc = v?.scope ?? v?.scopes; return /w_organization_social/.test(typeof sc === "string" ? sc : Array.isArray(sc) ? sc.join(",") : ""); };
  return mine
    .filter((a) => !merged.has(a.id))
    .map((a) => { const v = withProfile(viewOf(a), profiles.get(a.id)); return soc1 && v.app === "linkedin" ? { ...v, companyPages: orgScope(a) } : v; })
    .filter((v) => !(v.status === "pending" && Date.parse(v.createdAt) < staleBefore))
    .sort((a, b) => a.appName.localeCompare(b.appName) || a.createdAt.localeCompare(b.createdAt));
}

/** One account, only when it belongs to this workspace. */
export async function ownAccount(cp: Composio, orgId: string, id: string): Promise<CpAccount> {
  if (!/^[\w-]{3,64}$/.test(id)) throw new HttpError(404, "not_found", "That connection was not found.");
  let a: CpAccount;
  try { a = await cp.account(id); } catch (err) { return toHttp(err); }
  if (a.user_id !== platformUserId(cp, orgId)) throw new HttpError(404, "not_found", "That connection was not found.");
  return a;
}

type Scheme = { managed: true } | { scheme: string };

/** How an app connects: the platform's managed sign in, a self registering sign in, or the person's own key.
 * The toolkit list carries auth_schemes; the single toolkit read does not, it carries composio_managed_auth_schemes
 * and auth_config_details[].mode, so every source counts. */
export function schemeFor(t: Pick<CpToolkit, "auth_schemes" | "composio_managed_auth_schemes" | "no_auth" | "auth_config_details">): Scheme | null {
  if (t.no_auth) return null;
  const managed = (t.composio_managed_auth_schemes ?? []).filter((s) => s && s !== "NO_AUTH");
  if (managed.length) return { managed: true };
  const schemes = [...(t.auth_schemes ?? []), ...(t.auth_config_details ?? []).map((d) => d?.mode ?? "")].map((s) => s.toUpperCase());
  if (!schemes.length || schemes.every((s) => s === "NO_AUTH" || !s)) return null;
  for (const s of ["DCR_OAUTH", "API_KEY", "BEARER_TOKEN", "BASIC"]) if (schemes.includes(s)) return { scheme: s };
  return null;
}

/** Reuses the project's sign in setup for this app, or creates it the first time any workspace connects it. */
async function authConfigFor(cp: Composio, app: string, scheme: Scheme): Promise<string> {
  const existing = await cp.authConfigs(app);
  const fit = existing.find((c) => (c.status ?? "ENABLED").toUpperCase() !== "DISABLED"
    && ("managed" in scheme ? c.is_composio_managed === true : (c.auth_scheme ?? "").toUpperCase() === scheme.scheme));
  if (fit) return fit.id;
  return cp.createAuthConfig(app, scheme, `Multies ${appLabel(app)}`);
}

const APP_SLUG = /^[a-z0-9_]{1,64}$/;

export function callbackUrl(deps: Deps, app: string) {
  // P1 layout: a network you can post to comes back to Social, Accounts; every other app to Settings, Connections.
  const page = canPostTo(app) ? "/app/social/accounts" : "/app/settings/apps";
  return `${deps.config.appUrl}${page}?app=${encodeURIComponent(app)}`;
}

export async function startConnect(deps: Deps, auth: AuthContext, app: string, ip?: string | null): Promise<{ redirectUrl: string; accountId: string }> {
  if (!isAdmin(auth)) throw forbidden("Only owners and admins can connect apps.");
  if (!APP_SLUG.test(app)) throw new HttpError(404, "not_found", "That app was not found.");
  const cp = platform(deps);
  limitWrite(auth.orgId);
  try {
    const toolkit = await cp.toolkit(app);
    const scheme = schemeFor(toolkit);
    if (!scheme) throw new HttpError(409, "needs_setup", `${appLabel(app)} is not ready to connect yet. We are setting it up.`);
    const authConfigId = await authConfigFor(cp, app, scheme);
    const link = await cp.link(authConfigId, platformUserId(cp, auth.orgId), callbackUrl(deps, app));
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "integration.connect_started", targetType: "integration", targetId: link.accountId, metadata: { app }, ip: ip ?? null });
    return link;
  } catch (err) { return toHttp(err); }
}

/** The person came back from the connect page: read the account and record it. */
export async function confirmConnect(deps: Deps, auth: AuthContext, accountId: string, ip?: string | null): Promise<ConnectedAccountView> {
  // Confirming can fold an older connection into this one (and remove it), so it is an admin action like connect.
  if (!isAdmin(auth)) throw forbidden("Only owners and admins can connect apps.");
  const cp = platformForId(deps);
  limitWrite(auth.orgId);
  const a = await ownAccount(cp, auth.orgId, accountId);
  let view = viewOf(a);
  if (view.status === "active") {
    // The same outside account connected again refreshes the one row, for every app, not only social ones.
    // settleAccount writes its database changes as one unit and removes an older connection only after that, so a
    // failure leaves both connections as they were. The new one is live either way: it is reported connected, with a
    // note that it may show twice. For social apps the accounts list tries the fold again; for other apps a duplicate
    // stays until the same account is connected again or one is disconnected.
    try {
      const { settleAccount } = await import("./account-profiles");
      const r = await settleAccount(deps, cp, auth.orgId, platformUserId(cp, auth.orgId), a, { userId: auth.userId, email: auth.email, ip: ip ?? null });
      view = { ...withProfile(view, r.profile), refreshed: r.merged.length > 0 };
    } catch (err) {
      deps.log?.warn("integration.settle_failed", { app: view.app, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      view = { ...view, refreshed: false, warning: SETTLE_WARNING };
    }
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "integration.connected", targetType: "integration", targetId: a.id, metadata: { app: view.app, refreshed: view.refreshed === true, ...(view.warning ? { checked: false } : {}) }, ip: ip ?? null });
  }
  return view;
}

/** Said when a live connection could not be checked against the workspace's other connections. */
export const SETTLE_WARNING = "Connected. We could not check whether this account was already connected, so it may show twice. If it does, disconnect the older one.";

export async function reconnect(deps: Deps, auth: AuthContext, accountId: string, ip?: string | null): Promise<{ redirectUrl: string }> {
  if (!isAdmin(auth)) throw forbidden("Only owners and admins can reconnect apps.");
  const cp = platformForId(deps);
  limitWrite(auth.orgId);
  const a = await ownAccount(cp, auth.orgId, accountId);
  const app = a.toolkit?.slug ?? "";
  try {
    let redirectUrl: string | null = null;
    try { redirectUrl = (await cp.refresh(a.id, callbackUrl(deps, app))).redirectUrl; } catch (err) {
      if (!(err instanceof IntegrationError) || err.code === "not_configured") throw err;
    }
    if (!redirectUrl) {
      // No sign in to renew here (or the platform refused): start a fresh connection for the same app.
      if (!a.auth_config?.id) throw new HttpError(409, "needs_setup", "Disconnect this account and connect it again.");
      redirectUrl = (await cp.link(a.auth_config.id, platformUserId(cp, auth.orgId), callbackUrl(deps, app))).redirectUrl;
    }
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "integration.reconnect_started", targetType: "integration", targetId: a.id, metadata: { app }, ip: ip ?? null });
    return { redirectUrl };
  } catch (err) { return toHttp(err); }
}

export async function disconnect(deps: Deps, auth: AuthContext, accountId: string, ip?: string | null): Promise<{ ok: true }> {
  if (!isAdmin(auth)) throw forbidden("Only owners and admins can disconnect apps.");
  const cp = platformForId(deps);
  limitWrite(auth.orgId);
  const a = await ownAccount(cp, auth.orgId, accountId);
  try { await cp.remove(a.id); } catch (err) { return toHttp(err); }
  // SOC1: the Pages chosen through this login go with it.
  if (deps.config.socialMultiSoc1 === true) await (await import("./social-pages-soc1")).dropForAccount(deps, auth.orgId, a.id).catch(() => 0);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "integration.disconnected", targetType: "integration", targetId: a.id, metadata: { app: a.toolkit?.slug ?? null }, ip: ip ?? null });
  return { ok: true };
}

/* ---------------------------------------------------------------- targets (pages, boards) */

export interface TargetOption { id: string; name: string }

/** Digs a list out of a tool's answer: the platform wraps answers differently per network. */
export function findList(data: unknown, keys = ["data", "items", "pages", "boards", "response_data"]): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (!data || typeof data !== "object") return [];
  for (const k of keys) {
    const v = (data as Record<string, unknown>)[k];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
    if (v && typeof v === "object") { const inner = findList(v, keys); if (inner.length) return inner; }
  }
  return [];
}

/**
 * SOCFIX: the Page, board or community this workspace last chose for one account (newest of its last 50 posts), so the
 * composer can offer it again. Two small reads; nothing new is stored.
 */
export async function lastTarget(deps: Deps, auth: AuthContext, accountId: string): Promise<TargetOption | null> {
  const recent = await deps.db.select({ id: socialPosts.id }).from(socialPosts).where(eq(socialPosts.orgId, auth.orgId)).orderBy(desc(socialPosts.createdAt)).limit(50).all();
  if (!recent.length) return null;
  const rows = await deps.db.select({ postId: socialPostTargets.postId, target: socialPostTargets.target, targetName: socialPostTargets.targetName }).from(socialPostTargets)
    .where(and(eq(socialPostTargets.accountId, accountId), inIds(socialPostTargets.postId, recent.map((r) => r.id)))).all();
  const order = new Map(recent.map((r, i) => [r.id, i]));
  const best = rows.filter((r) => (r.target ?? "").trim()).sort((x, y) => order.get(x.postId)! - order.get(y.postId)!)[0];
  return best ? { id: best.target!, name: (best.targetName ?? best.target!).slice(0, 200) } : null;
}

export async function listTargets(deps: Deps, auth: AuthContext, accountId: string): Promise<TargetOption[]> {
  const cp = platformForId(deps);
  limitRead(auth.orgId);
  const a = await ownAccount(cp, auth.orgId, accountId);
  const app = a.toolkit?.slug ?? "";
  const uid = platformUserId(cp, auth.orgId);
  const pick = (rows: Record<string, unknown>[]) => rows
    .map((r) => ({ id: String(r.id ?? ""), name: String(r.name ?? r.title ?? r.id ?? "") }))
    .filter((r) => r.id).slice(0, 100);
  try {
    if (app === "facebook") {
      // SOC1: once an admin chose Pages for this login, only those are offered (the phone app uses this list too).
      if (deps.config.socialMultiSoc1 === true) {
        const chosen = await (await import("./social-pages-soc1")).chosenFor(deps, auth.orgId, a.id);
        if (chosen.length) return chosen;
      }
      const r = await cp.execute("FACEBOOK_GET_USER_PAGES", a.id, uid, { fields: "id,name" });
      return pick(findList(r.data));
    }
    if (app === "pinterest") {
      const r = await cp.execute("PINTEREST_LIST_BOARDS", a.id, uid, { page_size: 100 });
      // SOCFIX: a refused read is an error the picker can retry, never a silent "no boards".
      if (!r.ok) throw new IntegrationError("unavailable", "Pinterest didn't list the boards. Try again.");
      return pick(findList(r.data));
    }
    return [];
  } catch (err) { return toHttp(err); }
}

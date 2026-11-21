/**
 * SOC1: several Facebook Pages (and, only where LinkedIn already granted organization access, LinkedIn company Pages)
 * per workspace (flag SOCIAL_MULTI_SOC1). An admin picks Pages from a login's full, paged list; each chosen Page is one
 * row (deduped by the network's Page id across logins) and posts as its own account id (its key). No Page token is
 * stored: the Page's own token is asked through the login at send, check and delete time, as before.
 * Loaded only from handlers (dynamic import); nothing heavy at module top level.
 */
import { and, eq } from "drizzle-orm";
import { inIds } from "../../lib/sql-chunks";
import type { AuthContext, Deps } from "../../context";
import { socialPages } from "../../db/schema";
import { audit } from "../audit";
import { HttpError, forbidden } from "../../lib/errors";
import type { Composio, CpAccount } from "./composio";
import { isAdmin, limitRead, limitWrite, ownAccount, platform, platformForId, platformUserId, statusOf, toHttp } from "./service";
import { graph, linkedinGet, PublishError, type PublishCtx } from "./social";
import { SOC1_PAGE_KEY, soc1KeyOf, type Soc1AvailablePage, type Soc1AvailableView, type Soc1PageView } from "@/shared/social-soc1";
import { featureOn } from "../console/flags";

/** Graph answers at most 100 Pages a call; we follow the cursor up to this many calls (3,000 Pages). */
export const SOC1_MAX_PAGE_CALLS = 30;
/** A save names at most this many Pages. */
export const SOC1_MAX_SAVE = 500;
const ORG_SCOPE = /w_organization_social/;

export function soc1On(deps: Deps): boolean { return featureOn(deps, "socialMultiSoc1"); } // OPS1 feature flags: the platform wide value (a global switch)
function needOn(deps: Deps) { if (!soc1On(deps)) throw new HttpError(404, "not_found", "Not found."); }

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const https = (v: unknown) => { const s = str(v); return s && /^https:\/\//i.test(s) ? s.slice(0, 1000) : null; };

/** The scope a connection was granted (the platform keeps it on the account's state). */
export function scopeOf(a: CpAccount): string {
  const raw = a as unknown as { state?: { val?: { scope?: unknown; scopes?: unknown } } };
  const sc = raw.state?.val?.scope ?? raw.state?.val?.scopes;
  return typeof sc === "string" ? sc : Array.isArray(sc) ? sc.join(",") : "";
}
export const hasOrgScope = (a: CpAccount) => ORG_SCOPE.test(scopeOf(a));

function ctxOf(cp: Composio, orgId: string, accountId: string, now: Date): PublishCtx {
  return { cp, userId: platformUserId(cp, orgId), accountId, text: "", imageUrl: null, image: null, target: null, now };
}

/**
 * Every Facebook Page the login manages, following the cursor (never a URL the network hands back). Pages whose
 * tasks do not allow posting are kept with canPost false. truncated is true when the cap stopped the walk.
 */
export async function facebookPages(ctx: PublishCtx, maxCalls = SOC1_MAX_PAGE_CALLS): Promise<{ pages: Omit<Soc1AvailablePage, "added" | "addedElsewhere">[]; truncated: boolean }> {
  const pages: Omit<Soc1AvailablePage, "added" | "addedElsewhere">[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (let i = 0; i < maxCalls; i++) {
    const q: string = `me/accounts?fields=id,name,picture.width(96).height(96),tasks&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const r = await graph(ctx, "GET", q);
    const list = Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : [];
    for (const p of list) {
      const id = str(p.id);
      if (!id || !/^[\w.-]{1,64}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const tasks = Array.isArray(p.tasks) ? (p.tasks as unknown[]).map(String) : null;
      pages.push({
        id, name: (str(p.name) ?? id).slice(0, 200),
        pictureUrl: https((p.picture as { data?: { url?: unknown } } | undefined)?.data?.url),
        canPost: !tasks || tasks.includes("CREATE_CONTENT") || tasks.includes("MANAGE"),
      });
    }
    const paging = r.paging as { cursors?: { after?: unknown }; next?: unknown } | undefined;
    const next = str(paging?.cursors?.after);
    if (!paging?.next || !next || !list.length) return { pages, truncated: false };
    after = next;
  }
  return { pages, truncated: true };
}

/** LinkedIn company Pages the member administers (only asked when the organization scope is granted). */
export async function linkedinOrgs(ctx: PublishCtx, maxCalls = 10): Promise<{ pages: Omit<Soc1AvailablePage, "added" | "addedElsewhere">[]; truncated: boolean }> {
  const ids: string[] = [];
  let truncated = true;
  for (let i = 0; i < maxCalls; i++) {
    const r = (await linkedinGet(ctx, `https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=100&start=${i * 100}`)) as { elements?: { organization?: unknown }[] } | null;
    const els = r?.elements ?? [];
    for (const e of els) { const m = String(e.organization ?? "").match(/^urn:li:organization:(\d{1,20})$/); if (m && !ids.includes(m[1]!)) ids.push(m[1]!); }
    if (els.length < 100) { truncated = false; break; }
  }
  const pages: Omit<Soc1AvailablePage, "added" | "addedElsewhere">[] = [];
  for (const id of ids) {
    let name: string | null = null;
    try { name = str(((await linkedinGet(ctx, `https://api.linkedin.com/rest/organizations/${id}`)) as { localizedName?: unknown } | null)?.localizedName); } catch { /* name stays the id */ }
    pages.push({ id, name: (name ?? `Company ${id}`).slice(0, 200), pictureUrl: null, canPost: true });
  }
  return { pages, truncated };
}

function viewOf(r: typeof socialPages.$inferSelect): Soc1PageView {
  return { key: r.key, app: r.app as Soc1PageView["app"], pageId: r.pageId, name: r.name ?? r.pageId, pictureUrl: r.pictureUrl, viaAccountId: r.viaAccountId, state: r.state as Soc1PageView["state"] };
}

/** The Pages a workspace chose (anyone in the workspace may read them: the composer shows them). */
export async function listPages(deps: Deps, auth: AuthContext): Promise<Soc1PageView[]> {
  needOn(deps);
  const rows = await deps.db.select().from(socialPages).where(eq(socialPages.orgId, auth.orgId)).all();
  return rows.map(viewOf).sort((a, b) => a.app.localeCompare(b.app) || a.name.localeCompare(b.name));
}

async function available(deps: Deps, auth: AuthContext, a: CpAccount, cp: Composio) {
  const app = a.toolkit?.slug ?? "";
  const ctx = ctxOf(cp, auth.orgId, a.id, deps.now());
  if (app === "facebook") return { app: "facebook" as const, needsApproval: false, ...(await facebookPages(ctx)) };
  if (app === "linkedin") {
    if (!hasOrgScope(a)) return { app: "linkedin" as const, needsApproval: true, pages: [], truncated: false };
    return { app: "linkedin" as const, needsApproval: false, ...(await linkedinOrgs(ctx)) };
  }
  throw new HttpError(404, "not_found", "This account has no Pages to choose.");
}

/** Admin: every Page this login can reach, marked with what the workspace already added. */
export async function listAvailable(deps: Deps, auth: AuthContext, accountId: string): Promise<Soc1AvailableView> {
  needOn(deps);
  if (!isAdmin(auth)) throw forbidden("Only owners and admins can choose Pages.");
  const cp = platformForId(deps);
  limitRead(auth.orgId);
  const a = await ownAccount(cp, auth.orgId, accountId);
  let got: Awaited<ReturnType<typeof available>>;
  try { got = await available(deps, auth, a, cp); } catch (err) { if (err instanceof HttpError) throw err; return pagesError(err); }
  const rows = await deps.db.select().from(socialPages).where(and(eq(socialPages.orgId, auth.orgId), eq(socialPages.app, got.app))).all();
  const byPage = new Map(rows.map((r) => [r.pageId, r]));
  const ids = new Set(got.pages.map((p) => p.id));
  const lost = rows.filter((r) => r.viaAccountId === a.id && !ids.has(r.pageId)).map(viewOf);
  return {
    accountId: a.id, app: got.app, needsApproval: got.needsApproval, truncated: got.truncated, lost,
    pages: got.pages.map((p) => { const r = byPage.get(p.id); return { ...p, added: !!r, addedElsewhere: !!r && r.viaAccountId !== a.id }; }),
  };
}

function pagesError(err: unknown): never {
  if (err instanceof PublishError) {
    if (err.code === "reconnect" || err.code === "no_permission") throw new HttpError(409, "reconnect", "Facebook needs you to sign in again before it shows your Pages.");
    if (err.code === "rate_limited") throw new HttpError(429, "rate_limited", "The network is busy. Try again in a minute.");
    throw new HttpError(502, "pages_unavailable", "The network didn't send your Pages. Try again.");
  }
  return toHttp(err);
}

/**
 * Admin: the Pages of this login the workspace uses. Ids are checked against the login's own list (never trusted from
 * the request); names and pictures come from the network. Pages of this login left out are removed; Pages added
 * through another login are kept (the login only moves here when the other one is gone).
 */
export async function savePages(deps: Deps, auth: AuthContext, accountId: string, pageIds: string[], ip?: string | null): Promise<Soc1PageView[]> {
  needOn(deps);
  if (!isAdmin(auth)) throw forbidden("Only owners and admins can choose Pages.");
  if (pageIds.length > SOC1_MAX_SAVE) throw new HttpError(422, "too_many", `Choose ${SOC1_MAX_SAVE} Pages at most.`);
  const cp = platformForId(deps);
  limitWrite(auth.orgId);
  const a = await ownAccount(cp, auth.orgId, accountId);
  if (statusOf(a.status) !== "active") throw new HttpError(409, "reconnect", "Sign in to this account again first.");
  let got: Awaited<ReturnType<typeof available>>;
  try { got = await available(deps, auth, a, cp); } catch (err) { if (err instanceof HttpError) throw err; return pagesError(err); }
  if (got.needsApproval) throw new HttpError(409, "needs_approval", "Company Pages need LinkedIn approval.");
  const wanted = new Set(pageIds);
  const pick = got.pages.filter((p) => wanted.has(p.id) && p.canPost);
  if (pick.length < wanted.size) throw new HttpError(422, "unknown_page", "Some of those Pages can't be posted to from this login. Refresh the list and try again.");
  const now = deps.now();
  const existing = await deps.db.select().from(socialPages).where(and(eq(socialPages.orgId, auth.orgId), eq(socialPages.app, got.app))).all();
  const byPage = new Map(existing.map((r) => [r.pageId, r]));
  // A Page already added through another login stays with it while that login is still here and live.
  let live = new Set<string>();
  if (existing.some((r) => r.viaAccountId !== a.id && wanted.has(r.pageId))) {
    const all = await platform(deps).accounts(platformUserId(cp, auth.orgId)).catch(() => [] as CpAccount[]);
    live = new Set(all.filter((x) => x.user_id === platformUserId(cp, auth.orgId) && statusOf(x.status) === "active").map((x) => x.id));
  }
  const added: string[] = [];
  for (const p of pick) {
    const r = byPage.get(p.id);
    const via = r && r.viaAccountId !== a.id && live.has(r.viaAccountId) && r.state === "ok" ? r.viaAccountId : a.id;
    if (!r) added.push(p.id);
    await deps.db.insert(socialPages).values({ orgId: auth.orgId, app: got.app, pageId: p.id, key: soc1KeyOf(got.app, p.id), viaAccountId: via, name: p.name, pictureUrl: p.pictureUrl, state: "ok", addedBy: auth.userId, addedAt: now, checkedAt: now })
      .onConflictDoUpdate({ target: [socialPages.orgId, socialPages.app, socialPages.pageId], set: { viaAccountId: via, name: p.name, pictureUrl: p.pictureUrl, state: "ok", checkedAt: now } });
  }
  const drop = existing.filter((r) => r.viaAccountId === a.id && !wanted.has(r.pageId)).map((r) => r.pageId);
  if (drop.length) await deps.db.delete(socialPages).where(and(eq(socialPages.orgId, auth.orgId), eq(socialPages.app, got.app), inIds(socialPages.pageId, drop)));
  if (added.length || drop.length) {
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "social.pages_chosen", targetType: "integration", targetId: a.id, metadata: { app: got.app, added: added.length, removed: drop.length }, ip: ip ?? null });
  }
  return listPages(deps, auth);
}

/** Admin: stop using one Page. */
export async function removePage(deps: Deps, auth: AuthContext, key: string, ip?: string | null): Promise<{ ok: true }> {
  needOn(deps);
  if (!isAdmin(auth)) throw forbidden("Only owners and admins can remove Pages.");
  if (!SOC1_PAGE_KEY.test(key)) throw new HttpError(404, "not_found", "That Page was not found.");
  limitWrite(auth.orgId);
  const r = await deps.db.select().from(socialPages).where(and(eq(socialPages.orgId, auth.orgId), eq(socialPages.key, key))).get();
  if (!r) throw new HttpError(404, "not_found", "That Page was not found.");
  await deps.db.delete(socialPages).where(and(eq(socialPages.orgId, auth.orgId), eq(socialPages.key, key)));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "social.page_removed", targetType: "integration", targetId: r.viaAccountId, metadata: { app: r.app }, ip: ip ?? null });
  return { ok: true };
}

/** Page keys of a workspace resolved to their rows (one bounded read; only keys of this workspace resolve). */
export async function resolveKeys(deps: Deps, orgId: string, ids: string[]): Promise<Map<string, typeof socialPages.$inferSelect>> {
  const keys = [...new Set(ids.filter((id) => SOC1_PAGE_KEY.test(id)))].slice(0, 200);
  if (!keys.length) return new Map();
  const rows = await deps.db.select().from(socialPages).where(and(eq(socialPages.orgId, orgId), inIds(socialPages.key, keys))).all();
  return new Map(rows.map((r) => [r.key, r]));
}

/** A login's chosen Pages, for the older per login Page list (the phone app). Empty = none chosen yet. */
export async function chosenFor(deps: Deps, orgId: string, accountId: string): Promise<{ id: string; name: string }[]> {
  const rows = await deps.db.select().from(socialPages).where(and(eq(socialPages.orgId, orgId), eq(socialPages.viaAccountId, accountId))).all();
  return rows.map((r) => ({ id: r.pageId, name: r.name ?? r.pageId }));
}

/** A login was disconnected: its Pages go with it. */
export async function dropForAccount(deps: Deps, orgId: string, accountId: string): Promise<number> {
  const rows = await deps.db.select({ key: socialPages.key }).from(socialPages).where(and(eq(socialPages.orgId, orgId), eq(socialPages.viaAccountId, accountId))).all();
  if (rows.length) await deps.db.delete(socialPages).where(and(eq(socialPages.orgId, orgId), eq(socialPages.viaAccountId, accountId)));
  return rows.length;
}

/**
 * Health rows for chosen Pages: a Page the login no longer lists, or can no longer post to, is lost (and stored so,
 * written only when it changes). reachable maps a login to the Page ids it can post to, null = the login's check failed.
 */
export async function pageHealthRows(deps: Deps, orgId: string, reachable: Map<string, Set<string> | null>, loginCodes: Map<string, string | null>) {
  const rows = await deps.db.select().from(socialPages).where(eq(socialPages.orgId, orgId)).all();
  const out: { accountId: string; app: string; ok: boolean; code: string | null; text: string | null }[] = [];
  for (const r of rows) {
    const set = reachable.get(r.viaAccountId);
    const loginCode = loginCodes.has(r.viaAccountId) ? loginCodes.get(r.viaAccountId)! : "account_gone";
    let code: string | null = null;
    if (loginCode && loginCode !== "not_page_admin") code = loginCode;
    else if (set && !set.has(r.pageId)) code = "page_lost";
    else if (loginCode === "not_page_admin") code = "page_lost";
    const state = code === "page_lost" || code === "account_gone" ? "lost" : "ok";
    if (set !== null && state !== r.state) await deps.db.update(socialPages).set({ state, checkedAt: deps.now() }).where(and(eq(socialPages.orgId, orgId), eq(socialPages.key, r.key)));
    out.push({ accountId: r.key, app: r.app, ok: !code, code, text: null });
  }
  return out;
}

/** Health for a Facebook login: permissions, then the whole paged Page list; the Page ids it can post to. */
export async function facebookHealthAll(ctx: PublishCtx): Promise<{ code: string | null; reachable: Set<string> }> {
  const perms = await graph(ctx, "GET", "me/permissions");
  const granted = new Set(((perms.data as { permission?: string; status?: string }[] | undefined) ?? []).filter((p) => p.status === "granted").map((p) => p.permission));
  if (!granted.has("pages_manage_posts") || !granted.has("pages_show_list")) return { code: "no_permission", reachable: new Set() };
  const { pages } = await facebookPages(ctx);
  const reachable = new Set(pages.filter((p) => p.canPost).map((p) => p.id));
  return { code: reachable.size ? null : "not_page_admin", reachable };
}

/** Every Page token of each login, read with the paged Page list (at most 5 calls a login); misses fall back to one read per Page. */
export async function pageTokensFor(base: { cp: Composio; userId: string; now: Date }, viaIds: string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  for (const via of [...new Set(viaIds)]) {
    const ctx: PublishCtx = { cp: base.cp, userId: base.userId, accountId: via, text: "", imageUrl: null, image: null, target: null, now: base.now };
    const m = new Map<string, string>();
    try {
      let after: string | null = null;
      for (let i = 0; i < 5; i++) {
        const q: string = `me/accounts?fields=id,access_token&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
        const r = await graph(ctx, "GET", q);
        const list = Array.isArray(r.data) ? (r.data as { id?: unknown; access_token?: unknown }[]) : [];
        for (const p of list) if (typeof p.id === "string" && typeof p.access_token === "string" && p.access_token) m.set(p.id, p.access_token);
        const paging = r.paging as { cursors?: { after?: unknown }; next?: unknown } | undefined;
        const next = typeof paging?.cursors?.after === "string" ? paging.cursors.after : null;
        if (!paging?.next || !next || !list.length) break;
        after = next;
      }
    } catch { /* each Page asks for its own token instead */ }
    out.set(via, m);
  }
  return out;
}

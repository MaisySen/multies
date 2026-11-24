/**
 * SA1 (Nov 1): who each connected social account is, and one connection per network account.
 *
 * The integration platform keeps the connections and their sign in tokens; it happily makes a second connection when
 * the same LinkedIn profile signs in again from Connect. Here we ask each network who the account is (its own id, the
 * name and picture people know it by), using the account's existing sign in through the platform's proxy (free reads,
 * nothing posted), and keep that in social_account_profiles. The unique index on workspace + network + network id is
 * the server side guard: when a new connection turns out to be an account the workspace already has, the newest
 * connection (the freshest sign in) is kept, everything that pointed at the older one (planned and past posts, time
 * slots, inbox items, stats) is moved to it, and the older connection is removed. That runs when a connect finishes and
 * when the social accounts are listed (which also backfills names for connections made before this existed).
 *
 * The database side of a merge (moving pointers, dropping the older profile row, writing the kept one) is one atomic
 * unit: a D1 batch on Workers, a SQLite transaction on Node. The older connection is removed on the platform only
 * after that unit is written, so a failure part way never leaves posts pointing at a removed connection or the
 * workspace without the account's identity.
 */
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { socialAccountProfiles } from "../../db/schema";
import { audit } from "../audit";
import { IntegrationError, type Composio, type CpAccount } from "./composio";
import { clearHealthCache, dig, graph, linkedinGet, proxyCall, runTool, type PublishCtx } from "./social";

export interface AccountProfile { externalId: string | null; name: string | null; avatarUrl: string | null }
export interface ProfileRow { accountId: string; app: string; externalId: string | null; name: string | null; avatarUrl: string | null; checkedAt: Date }

/** A profile read that worked is asked again after a week (pictures from the networks expire); one that failed after an hour. */
export const PROFILE_TTL_MS = 7 * 86_400_000;
export const PROFILE_RETRY_MS = 3_600_000;
/** At most this many networks are asked per list, so a big workspace never makes one slow page. */
export const PROFILE_READS_PER_LIST = 6;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : typeof v === "number" ? String(v) : null);
const httpsUrl = (v: unknown): string | null => {
  const s = str(typeof v === "string" ? v.replace(/&amp;/g, "&") : v);
  if (!s || s.length > 2000) return null;
  try { return new URL(s).protocol === "https:" ? s : null; } catch { return null; }
};

async function proxyJson(ctx: PublishCtx, endpoint: string): Promise<Record<string, unknown> | null> {
  const r = await proxyCall(ctx, { endpoint, method: "GET" });
  if (r.status >= 400) return null;
  return (r.data && typeof r.data === "object" ? r.data : null) as Record<string, unknown> | null;
}

/** Asks the network who this account is. Null when it cannot say (the caller keeps the connection as it is). */
export async function readProfile(ctx: PublishCtx, app: string): Promise<AccountProfile | null> {
  switch (app) {
    case "linkedin": {
      const me = (await linkedinGet(ctx, "https://api.linkedin.com/v2/userinfo")) as Record<string, unknown> | null;
      const sub = str(me?.sub);
      if (!sub) return null;
      const name = str(me?.name) ?? ([str(me?.given_name), str(me?.family_name)].filter(Boolean).join(" ") || null);
      return { externalId: `person:${sub}`, name, avatarUrl: httpsUrl(me?.picture) };
    }
    case "facebook": {
      const me = await graph(ctx, "GET", "me?fields=id,name,picture.width(96).height(96)");
      const id = str(me.id);
      if (!id) return null;
      return { externalId: id, name: str(me.name), avatarUrl: httpsUrl((me.picture as { data?: { url?: unknown } } | undefined)?.data?.url) };
    }
    case "instagram": {
      const me = await runTool(ctx, "INSTAGRAM_GET_USER_INFO", {});
      const id = dig(me, ["id"]);
      if (!id) return null;
      const user = dig(me, ["username"]);
      return { externalId: id, name: user ? `@${user}` : dig(me, ["name"]), avatarUrl: httpsUrl(dig(me, ["profile_picture_url"])) };
    }
    case "pinterest": {
      const me = await proxyJson(ctx, "https://api.pinterest.com/v5/user_account");
      const id = str(me?.id) ?? str(me?.username);
      if (!id) return null;
      return { externalId: id, name: str(me?.business_name) ?? str(me?.username), avatarUrl: httpsUrl(me?.profile_image) };
    }
    case "reddit": {
      const me = await proxyJson(ctx, "https://oauth.reddit.com/api/v1/me");
      const id = str(me?.id) ?? str(me?.name);
      if (!id) return null;
      return { externalId: id, name: str(me?.name) ? `u/${str(me?.name)}` : null, avatarUrl: httpsUrl(me?.icon_img) };
    }
    case "twitter": {
      const me = (await proxyJson(ctx, "https://api.twitter.com/2/users/me?user.fields=profile_image_url"))?.data as Record<string, unknown> | undefined;
      const id = str(me?.id);
      if (!id) return null;
      return { externalId: id, name: str(me?.username) ? `@${str(me?.username)}` : str(me?.name), avatarUrl: httpsUrl(me?.profile_image_url) };
    }
    case "threads": {
      const me = await proxyJson(ctx, "https://graph.threads.net/v1.0/me?fields=id,username,threads_profile_picture_url");
      const id = str(me?.id);
      if (!id) return null;
      return { externalId: id, name: str(me?.username) ? `@${str(me?.username)}` : null, avatarUrl: httpsUrl(me?.threads_profile_picture_url) };
    }
    default: return null;
  }
}

/** The claims of an OpenID Connect id_token (payload only). Null for anything that is not one with an issuer and subject. */
function idTokenClaims(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "string" || v.length > 8000) return null;
  const parts = v.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "="));
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (ch) => ch.charCodeAt(0)))) as unknown;
    if (!c || typeof c !== "object") return null;
    const o = c as Record<string, unknown>;
    return str(o.iss) && str(o.sub) ? o : null;
  } catch { return null; }
}

/**
 * An identity the platform already returned with the account, for apps that have no profile read of their own (or
 * whose read failed). Only an OpenID Connect id_token in the stored connection counts: its issuer and subject name the
 * outside account and are never reused for another one (OpenID Connect Core, section 2). The token came from the
 * platform's own store over its authenticated API, the same trust as the connection itself, so its signature is not
 * checked here. A bare id, username, email or sub in the platform's data is not provably the outside account (it can
 * be the platform's own id, or a field another app uses differently), so it never merges two connections: null.
 */
export function identityFromAccount(a: CpAccount): AccountProfile | null {
  for (const bag of [a.state?.val, a.data]) {
    const c = idTokenClaims(bag?.id_token);
    if (!c) continue;
    return { externalId: `oidc:${str(c.iss)}|${str(c.sub)}`.slice(0, 300), name: str(c.name) ?? str(c.email), avatarUrl: httpsUrl(c.picture) };
  }
  return null;
}

export async function profilesFor(deps: Deps, orgId: string): Promise<Map<string, ProfileRow>> {
  const rows = await deps.db.select().from(socialAccountProfiles).where(eq(socialAccountProfiles.orgId, orgId)).all();
  return new Map(rows.map((r) => [r.accountId, { accountId: r.accountId, app: r.app, externalId: r.externalId, name: r.name, avatarUrl: r.avatarUrl, checkedAt: r.checkedAt }]));
}

/** Everything that pointed at the older connection now points at the kept one, and the older profile row goes. */
export function pointerSteps(orgId: string, from: string, to: string): SQL[] {
  const posts = sql`(select id from social_posts where org_id = ${orgId})`;
  return [
    sql`update or ignore social_post_targets set account_id = ${to} where account_id = ${from} and post_id in ${posts}`,
    sql`delete from social_post_targets where account_id = ${from} and post_id in ${posts}`,
    sql`update social_slots set account_id = ${to} where org_id = ${orgId} and account_id = ${from}`,
    sql`update or ignore social_inbox_items set account_id = ${to} where org_id = ${orgId} and account_id = ${from}`,
    sql`delete from social_inbox_items where org_id = ${orgId} and account_id = ${from}`,
    sql`update or ignore social_post_stats set account_id = ${to} where org_id = ${orgId} and account_id = ${from}`,
    sql`delete from social_post_stats where org_id = ${orgId} and account_id = ${from}`,
    sql`delete from social_account_state where org_id = ${orgId} and account_id = ${from}`,
    sql`delete from social_account_profiles where org_id = ${orgId} and account_id = ${from}`,
  ];
}

/** Runs the statements as one unit: a D1 batch (atomic) on Workers, a SQLite transaction on Node. */
async function atomically(deps: Deps, steps: SQL[]) {
  const db = deps.db as unknown as { batch?: (q: unknown[]) => Promise<unknown>; $client?: { transaction?: (fn: () => void) => () => void } };
  if (typeof db.batch === "function") { await db.batch(steps.map((s) => deps.db.run(s))); return; }
  const client = db.$client;
  if (client && typeof client.transaction === "function") {
    // better-sqlite3 runs each statement at once (no await), so the whole unit commits or rolls back together.
    client.transaction(() => { for (const s of steps) void deps.db.run(s); })();
    return;
  }
  for (const s of steps) await deps.db.run(s);
}

export interface SettleResult { profile: ProfileRow | null; merged: string[] }

/**
 * Reads who this connection is, stores it, and folds any older connection to the same network account into it.
 * Only a working (active) connection is asked; a read that fails leaves everything as it was.
 */
export async function settleAccount(deps: Deps, cp: Composio, orgId: string, userId: string, a: CpAccount, actor?: { userId: string | null; email: string | null; ip?: string | null }): Promise<SettleResult> {
  const app = a.toolkit?.slug ?? "";
  const now = deps.now();
  const ctx: PublishCtx = { cp, userId, accountId: a.id, text: "", imageUrl: null, image: null, target: null, now };
  let p: AccountProfile | null = null;
  try { p = await readProfile(ctx, app); } catch (err) {
    deps.log?.warn("social.profile_failed", { app, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
  }
  if (!p) p = identityFromAccount(a);
  const row: ProfileRow = { accountId: a.id, app, externalId: p?.externalId ?? null, name: p?.name ?? null, avatarUrl: p?.avatarUrl ?? null, checkedAt: now };
  if (!p) {
    // Keep a name we already had; only the time of the try changes.
    const had = (await profilesFor(deps, orgId)).get(a.id);
    const keep = had ? { ...had, checkedAt: now } : row;
    await upsert(deps, orgId, keep);
    return { profile: keep, merged: [] };
  }
  // Unique (org, app, externalId): at most one other connection holds this identity.
  const same = p.externalId ? await deps.db.select({ accountId: socialAccountProfiles.accountId }).from(socialAccountProfiles)
    .where(and(eq(socialAccountProfiles.orgId, orgId), eq(socialAccountProfiles.app, app), eq(socialAccountProfiles.externalId, p.externalId), ne(socialAccountProfiles.accountId, a.id))).all() : [];
  const merged = same.map((o) => o.accountId);
  // One unit: pointers move, the older profile rows go, the kept row is written. If any of it fails nothing changes
  // and the older connection is untouched (still on the platform, still holding its identity and its posts).
  await atomically(deps, [...merged.flatMap((old) => pointerSteps(orgId, old, a.id)), upsertSql(deps, orgId, row)]);
  // Only now, with the kept connection holding the identity and everything that pointed at the older one, remove it.
  for (const old of merged) {
    try { await cp.remove(old); } catch (err) {
      if (!(err instanceof IntegrationError && err.code === "not_found")) deps.log?.warn("social.merge_remove_failed", { app, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
    try {
      await audit(deps.db, { orgId, actorUserId: actor?.userId ?? null, actorEmail: actor?.email ?? null, action: "integration.merged", targetType: "integration", targetId: a.id, metadata: { app, replaced: old }, ip: actor?.ip ?? null });
    } catch (err) {
      deps.log?.warn("social.merge_audit_failed", { app, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }
  if (merged.length) clearHealthCache(orgId);
  return { profile: row, merged };
}

function upsertSql(deps: Deps, orgId: string, r: ProfileRow): SQL {
  return deps.db.insert(socialAccountProfiles).values({ orgId, accountId: r.accountId, app: r.app, externalId: r.externalId, name: r.name, avatarUrl: r.avatarUrl, checkedAt: r.checkedAt })
    .onConflictDoUpdate({ target: [socialAccountProfiles.orgId, socialAccountProfiles.accountId], set: { app: r.app, externalId: r.externalId, name: r.name, avatarUrl: r.avatarUrl, checkedAt: r.checkedAt } })
    .getSQL();
}

async function upsert(deps: Deps, orgId: string, r: ProfileRow) {
  await deps.db.run(upsertSql(deps, orgId, r));
}

/**
 * For the accounts list: asks about active social connections we know nothing about (or not lately), oldest first so
 * the newest connection of a pair is the one kept, then drops profile rows of connections that are gone.
 * Returns the profiles and the ids that were folded into another connection (the caller leaves them out).
 */
export async function backfillProfiles(deps: Deps, cp: Composio, orgId: string, userId: string, accounts: CpAccount[], isSocial: (app: string) => boolean): Promise<{ profiles: Map<string, ProfileRow>; merged: Set<string> }> {
  const profiles = await profilesFor(deps, orgId);
  const now = deps.now().getTime();
  const due = accounts
    .filter((a) => isSocial(a.toolkit?.slug ?? "") && (a.status ?? "").toUpperCase() === "ACTIVE")
    .filter((a) => { const p = profiles.get(a.id); return !p || now - p.checkedAt.getTime() > (p.externalId ? PROFILE_TTL_MS : PROFILE_RETRY_MS); })
    .sort((x, y) => (x.created_at ?? "").localeCompare(y.created_at ?? ""))
    .slice(0, PROFILE_READS_PER_LIST);
  const merged = new Set<string>();
  // One at a time, in age order, so a pair always folds into its newest connection.
  for (const a of due) {
    if (merged.has(a.id)) continue;
    try {
      const r = await settleAccount(deps, cp, orgId, userId, a);
      if (r.profile) profiles.set(a.id, r.profile);
      for (const m of r.merged) { merged.add(m); profiles.delete(m); }
    } catch (err) {
      deps.log?.warn("social.profile_settle_failed", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }
  const live = new Set(accounts.map((a) => a.id));
  const gone = [...profiles.keys()].filter((id) => !live.has(id));
  if (gone.length) {
    await deps.db.delete(socialAccountProfiles).where(and(eq(socialAccountProfiles.orgId, orgId), inArray(socialAccountProfiles.accountId, gone.slice(0, 50)))); // D1: at most 50 ids
    for (const id of gone) profiles.delete(id);
  }
  return { profiles, merged };
}

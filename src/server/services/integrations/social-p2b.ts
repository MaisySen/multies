/**
 * R118: Social P2b. The inbox pulls comments, messages and mentions from each account into one list the team works
 * through (assign, done, notes, saved replies, contact link, task); replies go back through the network. Results
 * per post come from each network that shares them. A broken account rings the bell once. The test network is a
 * stand in network for staging only: every path into it checks deps.config.socialTestNetwork first.
 */
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import {
  contacts, directSocialLinks, members, socialAccountState, socialInboxItems, socialInboxNotes, socialPostStats, socialPostTargets, socialPosts,
  socialSavedReplies, socialTestAccounts, users,
} from "../../db/schema";
import { newId } from "../../lib/crypto";
import { inIds } from "../../lib/sql-chunks";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { audit } from "../audit";
import { SOCIAL_ERROR_COPY, SOCIAL_NETWORKS } from "@/shared/integrations";
import { networkLabel } from "@/shared/social-p2";
import {
  ANALYTICS_APPS, ANALYTICS_ROWS, INBOX_PAGE, INBOX_STALE_MS, INBOX_TEXT_MAX, NOTE_MAX, REPLY_MAX, SAVED_REPLIES_MAX, SAVED_TITLE_MAX,
  TEST_ACCOUNT_ID, TEST_NETWORK, TEST_NETWORK_LABEL, capsOf, hasInbox, parseInboxQuery, replyWindow,
  type AnalyticsResponse, type InboxCounts, type InboxItemView, type InboxKind, type InboxListResponse, type InboxNoteView, type InboxSourceView,
  type InboxThreadResponse, type PostStatRow, type SavedReplyView,
} from "@/shared/social-p2b";
import { appLabel, platform, platformUserId, statusOf } from "./service";
import type { Composio } from "./composio";
import { PublishError, dig, graph, proxyCall, type PublishCtx } from "./social";

type ItemRow = typeof socialInboxItems.$inferSelect;
type Role = AuthContext["role"];

/** A workspace pulls again from the networks at most this often when someone asks. */
const SYNC_GAP_MS = 30_000;
/** The cron pass pulls each used inbox this often, and results this often. */
const CRON_INBOX_MS = 15 * 60_000;
const STATS_TTL_MS = 6 * 3_600_000;
const STATS_DAYS = 30;
const STATS_PER_PASS = 40;
const lastAsk = new Map<string, number>();

export function requireP2b(deps: Deps) {
  if (deps.config.socialP2b === false) throw new HttpError(404, "not_found", "Not found.");
}
const isManager = (role: Role) => role === "owner" || role === "admin";
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const clip = (s: string | null | undefined, n: number) => (s ?? "").split(String.fromCharCode(0)).join("").trim().slice(0, n);

/* ---------------------------------------------------------------- accounts */

interface SourceAccount { id: string; app: string; label: string; cp?: Composio; userId?: string }

export async function testAccount(deps: Deps, orgId: string) {
  if (deps.config.socialTestNetwork !== true) return null;
  return (await deps.db.select().from(socialTestAccounts).where(eq(socialTestAccounts.orgId, orgId)).get()) ?? null;
}

async function sourceAccounts(deps: Deps, orgId: string): Promise<SourceAccount[]> {
  const out: SourceAccount[] = [];
  if (deps.config.integrations.composio) {
    try {
      const cp = platform(deps);
      const userId = platformUserId(cp, orgId);
      for (const a of await cp.accounts(userId)) {
        const app = a.toolkit?.slug ?? "";
        if ((a.user_id === undefined || a.user_id === userId) && app in SOCIAL_NETWORKS && app !== TEST_NETWORK && statusOf(a.status) === "active") {
          out.push({ id: a.id, app, label: a.alias?.trim() || appLabel(app), cp, userId });
        }
      }
    } catch (err) { deps.log?.warn("social.inbox_accounts_failed", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) }); }
  }
  const links = await deps.db.select({ provider: directSocialLinks.provider, username: directSocialLinks.username }).from(directSocialLinks).where(eq(directSocialLinks.orgId, orgId)).all();
  for (const l of links) out.push({ id: `direct:${l.provider}`, app: l.provider, label: l.username ? `@${l.username}` : networkLabel(l.provider) });
  const test = await testAccount(deps, orgId);
  if (test) out.push({ id: TEST_ACCOUNT_ID, app: TEST_NETWORK, label: test.name });
  return out;
}

/* ---------------------------------------------------------------- pulling from the networks */

interface Incoming {
  remoteId: string; kind: InboxKind; target?: string | null; authorId?: string | null; authorName?: string | null; authorHandle?: string | null;
  text: string; postUrl?: string | null; postText?: string | null; receivedAt: Date; inbound: boolean;
}

const asArr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const asStr = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const when = (v: unknown, fallback: Date): Date => { const t = typeof v === "number" ? v * 1000 : Date.parse(String(v ?? "")); return Number.isFinite(t) ? new Date(t) : fallback; };

function ctxOf(deps: Deps, a: SourceAccount): PublishCtx {
  return { cp: a.cp as Composio, userId: a.userId ?? "", accountId: a.id, text: "", imageUrl: null, image: null, target: null, now: deps.now() };
}

/** Facebook Pages: the newest message of each conversation and the newest comments on recent Page posts. */
async function pullFacebook(deps: Deps, a: SourceAccount): Promise<Incoming[]> {
  const ctx = ctxOf(deps, a);
  const now = deps.now();
  const pages = asArr((await graph(ctx, "GET", "me/accounts?fields=id,name,access_token&limit=5")).data).slice(0, 3);
  const out: Incoming[] = [];
  for (const p of pages) {
    const pageId = asStr(p.id); const tok = asStr(p.access_token);
    if (!pageId || !tok) continue;
    const t = encodeURIComponent(tok);
    const conv = await graph(ctx, "GET", `${pageId}/conversations?fields=id,participants,messages.limit(1){id,message,from,created_time}&limit=20&access_token=${t}`).catch(() => null);
    for (const c of asArr(conv?.data)) {
      const m = asArr(asObj(c.messages).data)[0];
      const text = asStr(m?.message);
      if (!m || !text) continue;
      const other = asArr(asObj(c.participants).data).find((x) => asStr(x.id) !== pageId);
      const from = asObj(m.from);
      out.push({ remoteId: `conv:${asStr(c.id)}`, kind: "message", target: pageId, authorId: asStr(other?.id), authorName: asStr(other?.name), text, receivedAt: when(m.created_time, now), inbound: asStr(from.id) !== pageId });
    }
    const feed = await graph(ctx, "GET", `${pageId}/published_posts?fields=id,message,permalink_url,comments.order(reverse_chronological).limit(20){id,message,from,created_time}&limit=10&access_token=${t}`).catch(() => null);
    for (const post of asArr(feed?.data)) {
      for (const cm of asArr(asObj(post.comments).data)) {
        const from = asObj(cm.from);
        if (asStr(from.id) === pageId || !asStr(cm.message)) continue;
        out.push({ remoteId: asStr(cm.id)!, kind: "comment", target: pageId, authorId: asStr(from.id), authorName: asStr(from.name), text: asStr(cm.message)!, postUrl: asStr(post.permalink_url), postText: asStr(post.message), receivedAt: when(cm.created_time, now), inbound: true });
      }
    }
  }
  return out.filter((x) => x.remoteId);
}

/** Instagram: comments on recent media, mentions (tags) and, where Meta allows it, messages. */
async function pullInstagram(deps: Deps, a: SourceAccount): Promise<Incoming[]> {
  const ctx = ctxOf(deps, a);
  const now = deps.now();
  const me = await ctx.cp.execute("INSTAGRAM_GET_USER_INFO", a.id, ctx.userId, {});
  const igId = me.ok ? dig(me.data, ["id"]) : null;
  if (!igId) throw new PublishError("reconnect", "no account id");
  const out: Incoming[] = [];
  const media = await graph(ctx, "GET", `${igId}/media?fields=id,caption,permalink,comments.limit(20){id,text,username,timestamp}&limit=10`).catch(() => null);
  for (const m of asArr(media?.data)) {
    for (const cm of asArr(asObj(m.comments).data)) {
      if (!asStr(cm.id) || !asStr(cm.text)) continue;
      out.push({ remoteId: asStr(cm.id)!, kind: "comment", target: igId, authorHandle: asStr(cm.username), authorName: asStr(cm.username), text: asStr(cm.text)!, postUrl: asStr(m.permalink), postText: asStr(m.caption), receivedAt: when(cm.timestamp, now), inbound: true });
    }
  }
  const tags = await graph(ctx, "GET", `${igId}/tags?fields=id,caption,permalink,username,timestamp&limit=10`).catch(() => null);
  for (const m of asArr(tags?.data)) {
    if (!asStr(m.id)) continue;
    out.push({ remoteId: `tag:${asStr(m.id)}`, kind: "mention", target: igId, authorHandle: asStr(m.username), authorName: asStr(m.username), text: asStr(m.caption) ?? "Mentioned you in a post", postUrl: asStr(m.permalink), receivedAt: when(m.timestamp, now), inbound: true });
  }
  const conv = await graph(ctx, "GET", `${igId}/conversations?platform=instagram&fields=id,participants,messages.limit(1){id,message,from,created_time}&limit=20`).catch(() => null);
  for (const c of asArr(conv?.data)) {
    const m = asArr(asObj(c.messages).data)[0];
    if (!m || !asStr(m.message)) continue;
    const other = asArr(asObj(c.participants).data).find((x) => asStr(x.id) !== igId);
    out.push({ remoteId: `conv:${asStr(c.id)}`, kind: "message", target: igId, authorId: asStr(other?.id), authorName: asStr(other?.username) ?? asStr(other?.name), authorHandle: asStr(other?.username), text: asStr(m.message)!, receivedAt: when(m.created_time, now), inbound: asStr(asObj(m.from).id) !== igId });
  }
  return out;
}

/** Reddit: the account's inbox (replies to its posts and comments, mentions and messages). */
async function pullReddit(deps: Deps, a: SourceAccount): Promise<Incoming[]> {
  const ctx = ctxOf(deps, a);
  const now = deps.now();
  const r = await proxyCall(ctx, { endpoint: "https://oauth.reddit.com/message/inbox?limit=25&raw_json=1", method: "GET" });
  if (r.status >= 400) throw new PublishError(r.status === 401 || r.status === 403 ? "reconnect" : "unavailable", `reddit ${r.status}`);
  const out: Incoming[] = [];
  for (const ch of asArr(asObj(asObj(r.data).data).children)) {
    const d = asObj(ch.data);
    const id = asStr(d.name); const body = asStr(d.body);
    if (!id || !body) continue;
    const kind: InboxKind = d.was_comment ? (asStr(d.subject) === "username mention" ? "mention" : "comment") : "message";
    const ctxUrl = asStr(d.context);
    out.push({ remoteId: id, kind, authorName: asStr(d.author), authorHandle: asStr(d.author) ? `u/${asStr(d.author)}` : null, text: body, postUrl: ctxUrl ? `https://www.reddit.com${ctxUrl}` : null, postText: asStr(d.link_title) ?? asStr(d.subject), receivedAt: when(d.created_utc, now), inbound: true });
  }
  return out;
}

const TEST_PEOPLE = [
  { id: "t-c1", kind: "comment" as const, name: "Mia Chen", handle: "@miachen", text: "Love the new look! When does the spring range land?", post: "Spring range teaser", ago: 40 * 60_000 },
  { id: "t-m1", kind: "message" as const, name: "Jordan Lee", handle: "@jordanlee", text: "Hi, is the Saturday workshop still on? I'd like to book two spots.", post: null, ago: 2 * 3_600_000 },
  { id: "t-m2", kind: "message" as const, name: "Priya Patel", handle: "@priyap", text: "Could you send me your price list please?", post: null, ago: 30 * 3_600_000 },
  { id: "t-n1", kind: "mention" as const, name: "Sam Taylor", handle: "@samtaylor", text: "Big thanks to the Multies team for the help today", post: null, ago: 5 * 3_600_000 },
];

/** The test network: four starter conversations, then one comment on each post sent to it. */
async function pullTest(deps: Deps, orgId: string): Promise<Incoming[]> {
  const now = deps.now().getTime();
  const out: Incoming[] = TEST_PEOPLE.map((p) => ({ remoteId: p.id, kind: p.kind, authorName: p.name, authorHandle: p.handle, text: p.text, postText: p.post, receivedAt: new Date(now - p.ago), inbound: true }));
  const sent = await deps.db.select({ postId: socialPostTargets.postId, sentAt: socialPostTargets.sentAt, url: socialPostTargets.url, text: socialPosts.text })
    .from(socialPostTargets).innerJoin(socialPosts, eq(socialPosts.id, socialPostTargets.postId))
    .where(and(eq(socialPosts.orgId, orgId), eq(socialPostTargets.accountId, TEST_ACCOUNT_ID), eq(socialPostTargets.status, "sent")))
    .orderBy(desc(socialPostTargets.sentAt)).limit(10).all();
  const fans = [["Alex Kim", "@alexkim", "Nice one! Saving this for later."], ["Noah Brown", "@noahb", "Do you ship to New Zealand?"], ["Ella Wright", "@ellaw", "This made my day, thank you."]] as const;
  for (const [i, s] of sent.entries()) {
    const [name, handle, words] = fans[i % fans.length]!;
    out.push({ remoteId: `t-pc-${s.postId}`, kind: "comment", authorName: name, authorHandle: handle, text: words, postUrl: s.url, postText: s.text, receivedAt: new Date(Math.min(now, (s.sentAt?.getTime() ?? now) + 5 * 60_000)), inbound: true });
  }
  return out;
}

async function pull(deps: Deps, orgId: string, a: SourceAccount): Promise<Incoming[]> {
  if (a.id === TEST_ACCOUNT_ID) return deps.config.socialTestNetwork === true ? pullTest(deps, orgId) : [];
  if (!a.cp) return [];
  if (a.app === "facebook") return pullFacebook(deps, a);
  if (a.app === "instagram") return pullInstagram(deps, a);
  if (a.app === "reddit") return pullReddit(deps, a);
  return [];
}

async function admins(deps: Deps, orgId: string): Promise<string[]> {
  const rows = await deps.db.select({ userId: members.userId }).from(members)
    .where(and(eq(members.organizationId, orgId), inArray(members.role, ["owner", "admin"]), eq(members.kind, "human"))).all();
  return rows.map((r) => r.userId);
}

async function tell(deps: Deps, orgId: string, userIds: string[], n: { type: string; entityType: string; entityId: string; title: string }) {
  if (!userIds.length) return;
  const { notify } = await import("../suite/notify");
  await Promise.all(userIds.map((u) => notify(deps, orgId, u, n).catch(() => undefined)));
}

async function saveState(deps: Deps, orgId: string, accountId: string, app: string, set: Partial<typeof socialAccountState.$inferInsert>) {
  const now = deps.now();
  await deps.db.insert(socialAccountState).values({ orgId, accountId, app, updatedAt: now, ...set })
    .onConflictDoUpdate({ target: [socialAccountState.orgId, socialAccountState.accountId], set: { ...set, updatedAt: now } });
}

/** Writes what one account gave: new rows, and a newer message reopens its conversation. Answers the new rows. */
async function store(deps: Deps, orgId: string, a: SourceAccount, incoming: Incoming[]): Promise<ItemRow[]> {
  const seen = new Map<string, Incoming>();
  for (const x of incoming) if (x.remoteId && !seen.has(x.remoteId)) seen.set(x.remoteId, x);
  const list = [...seen.values()].slice(0, 200);
  if (!list.length) return [];
  const existing = await deps.db.select({ id: socialInboxItems.id, remoteId: socialInboxItems.remoteId, lastInboundAt: socialInboxItems.lastInboundAt })
    .from(socialInboxItems).where(and(eq(socialInboxItems.orgId, orgId), eq(socialInboxItems.accountId, a.id), inIds(socialInboxItems.remoteId, list.map((x) => x.remoteId)))).all();
  const byRemote = new Map(existing.map((e) => [e.remoteId, e]));
  const now = deps.now();
  const fresh: ItemRow[] = [];
  for (const x of list) {
    const old = byRemote.get(x.remoteId);
    if (!old) {
      const row: ItemRow = {
        id: newId("si"), orgId, accountId: a.id, app: a.app, kind: x.kind, remoteId: x.remoteId.slice(0, 200), target: x.target ?? null,
        authorId: x.authorId ?? null, authorName: clip(x.authorName, 120) || null, authorHandle: clip(x.authorHandle, 120) || null,
        text: clip(x.text, INBOX_TEXT_MAX), postUrl: x.postUrl?.startsWith("https://") ? x.postUrl.slice(0, 500) : null, postText: clip(x.postText, 300) || null,
        receivedAt: x.receivedAt, lastInboundAt: x.inbound ? x.receivedAt : null, status: "open", assigneeId: null, contactId: null, taskId: null,
        repliedAt: null, createdAt: now, updatedAt: now,
      };
      fresh.push(row);
    } else if (x.kind === "message" && x.inbound && (!old.lastInboundAt || x.receivedAt.getTime() > old.lastInboundAt.getTime())) {
      await deps.db.update(socialInboxItems).set({ text: clip(x.text, INBOX_TEXT_MAX), receivedAt: x.receivedAt, lastInboundAt: x.receivedAt, status: "open", updatedAt: now })
        .where(eq(socialInboxItems.id, old.id));
    }
  }
  for (let i = 0; i < fresh.length; i += 10) await deps.db.insert(socialInboxItems).values(fresh.slice(i, i + 10)).onConflictDoNothing();
  return fresh;
}

/** Pulls every account of a workspace. Never throws for one account: its error is kept and shown on the inbox. */
export async function syncInbox(deps: Deps, orgId: string, opts: { alerts?: boolean } = {}) {
  const accounts = (await sourceAccounts(deps, orgId)).filter((a) => hasInbox(a.app));
  const states = accounts.length ? await deps.db.select({ accountId: socialAccountState.accountId, inboxSyncedAt: socialAccountState.inboxSyncedAt })
    .from(socialAccountState).where(and(eq(socialAccountState.orgId, orgId), inIds(socialAccountState.accountId, accounts.map((a) => a.id)))).all() : [];
  let added = 0;
  await Promise.all(accounts.map(async (a) => {
    const firstPull = !states.find((s) => s.accountId === a.id)?.inboxSyncedAt;
    try {
      const fresh = await store(deps, orgId, a, await pull(deps, orgId, a));
      added += fresh.length;
      await saveState(deps, orgId, a.id, a.app, { inboxSyncedAt: deps.now(), inboxError: null });
      // The first pull brings in history: no bell for that, only for what arrives after.
      if (opts.alerts !== false && !firstPull && fresh.length) {
        const name = networkLabel(a.app);
        await tell(deps, orgId, await admins(deps, orgId), { type: "social.inbox_new", entityType: "social_inbox", entityId: fresh[0]!.id, title: fresh.length === 1 ? `New ${fresh[0]!.kind} on ${name}: ${clip(fresh[0]!.text, 60)}` : `${fresh.length} new in the Social inbox from ${name}` });
      }
    } catch (err) {
      const code = err instanceof PublishError ? err.code : "unavailable";
      deps.log?.warn("social.inbox_pull_failed", { app: a.app, code, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      await saveState(deps, orgId, a.id, a.app, { inboxSyncedAt: deps.now(), inboxError: code.slice(0, 60) });
    }
  }));
  return { accounts: accounts.length, added };
}

/** The Refresh button and opening a stale inbox: held back 30 seconds per workspace. */
export async function syncNow(deps: Deps, auth: AuthContext) {
  requireP2b(deps);
  const now = deps.now().getTime();
  const last = lastAsk.get(auth.orgId) ?? 0;
  if (now - last < SYNC_GAP_MS) return { accounts: 0, added: 0, skipped: true };
  lastAsk.set(auth.orgId, now);
  return { ...(await syncInbox(deps, auth.orgId)), skipped: false };
}

/* ---------------------------------------------------------------- the list and a thread */

async function namesFor(deps: Deps, orgId: string, rows: ItemRow[]) {
  const userIds = [...new Set(rows.map((r) => r.assigneeId).filter((x): x is string => !!x))];
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter((x): x is string => !!x))];
  const [u, c] = await Promise.all([
    userIds.length ? deps.db.select({ id: users.id, name: users.name }).from(users).where(inIds(users.id, userIds)).all() : Promise.resolve([]),
    contactIds.length ? deps.db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts).where(and(eq(contacts.orgId, orgId), inIds(contacts.id, contactIds))).all() : Promise.resolve([]),
  ]);
  return { users: new Map(u.map((x) => [x.id, x.name])), contacts: new Map(c.map((x) => [x.id, x.name || x.email])) };
}

function viewOf(r: ItemRow, labels: Map<string, string>, names: Awaited<ReturnType<typeof namesFor>>): InboxItemView {
  return {
    id: r.id, accountId: r.accountId, app: r.app, accountLabel: labels.get(r.accountId) ?? (r.app === TEST_NETWORK ? TEST_NETWORK_LABEL : networkLabel(r.app)),
    kind: r.kind, status: r.status, authorName: r.authorName, authorHandle: r.authorHandle, text: r.text, postUrl: r.postUrl, postText: r.postText,
    receivedAt: r.receivedAt.toISOString(), lastInboundAt: iso(r.lastInboundAt), repliedAt: iso(r.repliedAt),
    assigneeId: r.assigneeId, assigneeName: r.assigneeId ? names.users.get(r.assigneeId) ?? null : null,
    contactId: r.contactId, contactName: r.contactId ? names.contacts.get(r.contactId) ?? null : null, taskId: r.taskId,
  };
}

/** Rows of other environments' test network never show unless this one allows it. */
const testFilter = (deps: Deps) => (deps.config.socialTestNetwork === true ? undefined : sql`${socialInboxItems.app} <> ${TEST_NETWORK}`);

export async function listInbox(deps: Deps, auth: AuthContext, q: Record<string, string | undefined>): Promise<InboxListResponse> {
  requireP2b(deps);
  const { status, view, app, search } = parseInboxQuery(q);
  const where = and(
    eq(socialInboxItems.orgId, auth.orgId), eq(socialInboxItems.status, status), testFilter(deps),
    view === "mine" ? eq(socialInboxItems.assigneeId, auth.userId) : view === "unassigned" ? isNull(socialInboxItems.assigneeId) : undefined,
    app ? eq(socialInboxItems.app, app) : undefined,
    search ? or(sql`instr(lower(${socialInboxItems.text}), ${search.toLowerCase()}) > 0`, sql`instr(lower(coalesce(${socialInboxItems.authorName}, '')), ${search.toLowerCase()}) > 0`) : undefined,
  );
  const [rows, countRows, states, test, people] = await Promise.all([
    deps.db.select().from(socialInboxItems).where(where).orderBy(desc(socialInboxItems.receivedAt)).limit(INBOX_PAGE).all(),
    deps.db.select({
      status: socialInboxItems.status,
      n: sql<number>`count(*)`,
      mine: sql<number>`sum(case when ${socialInboxItems.assigneeId} = ${auth.userId} then 1 else 0 end)`,
      none: sql<number>`sum(case when ${socialInboxItems.assigneeId} is null then 1 else 0 end)`,
    }).from(socialInboxItems).where(and(eq(socialInboxItems.orgId, auth.orgId), testFilter(deps))).groupBy(socialInboxItems.status).all(),
    deps.db.select().from(socialAccountState).where(eq(socialAccountState.orgId, auth.orgId)).limit(50).all(),
    testAccount(deps, auth.orgId),
    deps.db.select({ id: users.id, name: users.name }).from(members).innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.organizationId, auth.orgId), eq(members.kind, "human"))).orderBy(users.name).limit(100).all(),
  ]);
  const open = countRows.find((c) => c.status === "open");
  const counts: InboxCounts = { open: Number(open?.n ?? 0), mine: Number(open?.mine ?? 0), unassigned: Number(open?.none ?? 0), done: Number(countRows.find((c) => c.status === "done")?.n ?? 0) };
  const visibleStates = states.filter((s) => s.app !== TEST_NETWORK || deps.config.socialTestNetwork === true);
  const labels = new Map<string, string>(test ? [[TEST_ACCOUNT_ID, test.name]] : []);
  const sources: InboxSourceView[] = visibleStates.map((s) => ({
    accountId: s.accountId, app: s.app, label: labels.get(s.accountId) ?? networkLabel(s.app),
    state: !hasInbox(s.app) ? "posting_only" : s.inboxError ? "error" : s.inboxSyncedAt ? "ok" : "waiting",
    text: !hasInbox(s.app) ? capsOf(s.app).note : s.inboxError ? (SOCIAL_ERROR_COPY[s.inboxError] ?? "The network did not answer. Multies tries again in a few minutes.") : null,
    syncedAt: iso(s.inboxSyncedAt),
  }));
  const syncedAt = visibleStates.reduce<Date | null>((m, s) => (s.inboxSyncedAt && (!m || s.inboxSyncedAt > m) ? s.inboxSyncedAt : m), null);
  const names = await namesFor(deps, auth.orgId, rows);
  return {
    items: rows.map((r) => viewOf(r, labels, names)), counts, sources, syncedAt: iso(syncedAt),
    stale: !syncedAt || deps.now().getTime() - syncedAt.getTime() > INBOX_STALE_MS, canManage: isManager(auth.role), test: !!test,
    me: auth.userId, people,
  };
}

async function itemOrThrow(deps: Deps, auth: AuthContext, id: string): Promise<ItemRow> {
  const r = await deps.db.select().from(socialInboxItems).where(and(eq(socialInboxItems.id, id), eq(socialInboxItems.orgId, auth.orgId))).get();
  if (!r || (r.app === TEST_NETWORK && deps.config.socialTestNetwork !== true)) throw notFound("Conversation");
  return r;
}

async function itemView(deps: Deps, auth: AuthContext, r: ItemRow): Promise<InboxItemView> {
  const test = r.app === TEST_NETWORK ? await testAccount(deps, auth.orgId) : null;
  return viewOf(r, new Map(test ? [[TEST_ACCOUNT_ID, test.name]] : []), await namesFor(deps, auth.orgId, [r]));
}

export async function getThread(deps: Deps, auth: AuthContext, id: string): Promise<InboxThreadResponse> {
  requireP2b(deps);
  const r = await itemOrThrow(deps, auth, id);
  const notes = await deps.db.select({ n: socialInboxNotes, name: users.name }).from(socialInboxNotes).leftJoin(users, eq(users.id, socialInboxNotes.authorId))
    .where(eq(socialInboxNotes.itemId, r.id)).orderBy(socialInboxNotes.createdAt).limit(200).all();
  return {
    item: await itemView(deps, auth, r),
    notes: notes.map(({ n, name }): InboxNoteView => ({ id: n.id, kind: n.kind, text: n.text, authorId: n.authorId, authorName: name ?? null, status: n.status, error: n.error, createdAt: n.createdAt.toISOString() })),
  };
}

export interface ItemPatch { status?: "open" | "done"; assigneeId?: string | null; contactId?: string | null }

export async function updateItem(deps: Deps, auth: AuthContext, id: string, patch: ItemPatch): Promise<InboxItemView> {
  requireP2b(deps);
  const r = await itemOrThrow(deps, auth, id);
  const set: Partial<ItemRow> = { updatedAt: deps.now() };
  if (patch.status) set.status = patch.status;
  if (patch.assigneeId !== undefined) {
    const to = patch.assigneeId;
    // Members take a conversation or let go of their own; owners and admins hand it to anyone.
    if (!isManager(auth.role) && !(to === auth.userId || (to === null && r.assigneeId === auth.userId))) throw forbidden("Only owners and admins can assign a conversation to someone else.");
    if (to) {
      const m = await deps.db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, auth.orgId), eq(members.userId, to), eq(members.kind, "human"))).get();
      if (!m) throw new HttpError(422, "not_member", "That person isn't in this workspace.");
    }
    set.assigneeId = to;
  }
  if (patch.contactId !== undefined) {
    if (patch.contactId) {
      const c = await deps.db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, patch.contactId), eq(contacts.orgId, auth.orgId))).get();
      if (!c) throw notFound("Contact");
    }
    set.contactId = patch.contactId;
  }
  await deps.db.update(socialInboxItems).set(set).where(eq(socialInboxItems.id, r.id));
  if (patch.assigneeId && patch.assigneeId !== auth.userId && patch.assigneeId !== r.assigneeId) {
    await tell(deps, auth.orgId, [patch.assigneeId], { type: "social.inbox_assigned", entityType: "social_inbox", entityId: r.id, title: `${auth.name || "A teammate"} gave you a ${networkLabel(r.app)} ${r.kind}: ${clip(r.text, 60)}` });
  }
  return itemView(deps, auth, { ...r, ...set } as ItemRow);
}

export async function addNote(deps: Deps, auth: AuthContext, id: string, text: string): Promise<InboxNoteView> {
  requireP2b(deps);
  const r = await itemOrThrow(deps, auth, id);
  const body = clip(text, NOTE_MAX);
  if (!body) throw new HttpError(400, "empty", "Write a note first.");
  const row = { id: newId("sn"), itemId: r.id, orgId: auth.orgId, authorId: auth.userId, kind: "note" as const, text: body, status: "sent" as const, error: null, createdAt: deps.now() };
  await deps.db.insert(socialInboxNotes).values(row);
  return { id: row.id, kind: "note", text: body, authorId: auth.userId, authorName: auth.name ?? null, status: "sent", error: null, createdAt: row.createdAt.toISOString() };
}

/* ---------------------------------------------------------------- replies */

async function pageToken(ctx: PublishCtx, pageId: string): Promise<string> {
  const tok = asStr((await graph(ctx, "GET", `${encodeURIComponent(pageId)}?fields=access_token`)).access_token);
  if (!tok) throw new PublishError("not_page_admin", "no page token");
  return tok;
}

async function sendReply(deps: Deps, auth: AuthContext, r: ItemRow, text: string): Promise<void> {
  if (r.app === TEST_NETWORK) {
    if (deps.config.socialTestNetwork !== true) throw new PublishError("account_gone", "test network off");
    const test = await testAccount(deps, auth.orgId);
    if (!test) throw new PublishError("account_gone", "no test account");
    if (test.broken) throw new PublishError("reconnect", "test account signed out");
    if (/FAIL/.test(text)) throw new PublishError("rejected", "The test network turned this reply down");
    return;
  }
  const accounts = await sourceAccounts(deps, auth.orgId);
  const a = accounts.find((x) => x.id === r.accountId);
  if (!a?.cp) throw new PublishError("account_gone", "account gone");
  const ctx = ctxOf(deps, a);
  if (r.app === "facebook") {
    if (!r.target) throw new PublishError("needs_target", "no page");
    const tok = await pageToken(ctx, r.target);
    if (r.kind === "message") {
      if (!r.authorId) throw new PublishError("not_supported", "no recipient");
      await graph(ctx, "POST", `${encodeURIComponent(r.target)}/messages`, { recipient: { id: r.authorId }, messaging_type: "RESPONSE", message: { text }, access_token: tok });
    } else {
      await graph(ctx, "POST", `${encodeURIComponent(r.remoteId)}/comments`, { message: text, access_token: tok });
    }
    return;
  }
  if (r.app === "instagram") {
    if (r.kind === "message") {
      if (!r.target || !r.authorId) throw new PublishError("not_supported", "no recipient");
      await graph(ctx, "POST", `${encodeURIComponent(r.target)}/messages`, { recipient: { id: r.authorId }, message: { text } });
    } else if (r.kind === "comment") {
      await graph(ctx, "POST", `${encodeURIComponent(r.remoteId)}/replies`, { message: text });
    } else throw new PublishError("not_supported", "mention");
    return;
  }
  if (r.app === "reddit") {
    const res = await proxyCall(ctx, { endpoint: "https://oauth.reddit.com/api/comment", method: "POST", body: { thing_id: r.remoteId, text, api_type: "json" } });
    if (res.status >= 400) throw new PublishError(res.status === 401 || res.status === 403 ? "reconnect" : "rejected", `reddit ${res.status}`);
    return;
  }
  throw new PublishError("not_supported", r.app);
}

export const REPLY_COPY: Record<string, string> = {
  not_supported: "This network doesn't take replies from Multies for this kind of item. Open it on the network to reply.",
  window_closed: "The reply window has closed. The network only takes replies within 24 hours of their last message.",
};

export async function reply(deps: Deps, auth: AuthContext, id: string, text: string): Promise<{ note: InboxNoteView; item: InboxItemView }> {
  requireP2b(deps);
  const r = await itemOrThrow(deps, auth, id);
  const body = clip(text, REPLY_MAX);
  if (!body) throw new HttpError(400, "empty", "Write a reply first.");
  const w = replyWindow(r.app, r.kind, r.lastInboundAt, deps.now().getTime());
  if (w.state === "closed") throw new HttpError(422, "window_closed", REPLY_COPY.window_closed!);
  let status: "sent" | "failed" = "sent";
  let error: string | null = null;
  try { await sendReply(deps, auth, r, body); } catch (err) {
    status = "failed";
    const code = err instanceof PublishError ? err.code : "unavailable";
    const name = r.app === TEST_NETWORK ? TEST_NETWORK_LABEL : networkLabel(r.app);
    error = code === "rejected" ? `${name} turned the reply down${err instanceof PublishError && err.message && err.message !== "rejected" ? `: ${err.message.slice(0, 200)}` : ""}.`
      : REPLY_COPY[code] ?? SOCIAL_ERROR_COPY[code] ?? "The network did not answer. Try again in a minute.";
    deps.log?.warn("social.inbox_reply_failed", { app: r.app, code });
  }
  const now = deps.now();
  const row = { id: newId("sn"), itemId: r.id, orgId: auth.orgId, authorId: auth.userId, kind: "reply" as const, text: body, status, error, createdAt: now };
  await deps.db.insert(socialInboxNotes).values(row);
  const set: Partial<ItemRow> = { updatedAt: now };
  if (status === "sent") { set.repliedAt = now; if (!r.assigneeId) set.assigneeId = auth.userId; }
  await deps.db.update(socialInboxItems).set(set).where(eq(socialInboxItems.id, r.id));
  if (status === "sent") await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "social.inbox_replied", targetType: "social_inbox", targetId: r.id, metadata: { app: r.app, kind: r.kind } }).catch(() => undefined);
  return {
    note: { id: row.id, kind: "reply", text: body, authorId: auth.userId, authorName: auth.name ?? null, status, error, createdAt: now.toISOString() },
    item: await itemView(deps, auth, { ...r, ...set } as ItemRow),
  };
}

/** Makes a task from a conversation (once; a second ask answers the same task). */
export async function makeTask(deps: Deps, auth: AuthContext, id: string): Promise<{ taskId: string; item: InboxItemView }> {
  requireP2b(deps);
  const r = await itemOrThrow(deps, auth, id);
  if (r.taskId) return { taskId: r.taskId, item: await itemView(deps, auth, r) };
  const { createTask } = await import("../suite/tasks");
  const who = r.authorName ?? r.authorHandle ?? "someone";
  const link = `${deps.config.appUrl}/app/social/inbox?item=${encodeURIComponent(r.id)}`;
  const task = await createTask(deps, { orgId: auth.orgId, userId: auth.userId, email: auth.email, name: auth.name, role: auth.role }, {
    title: clip(`Follow up with ${who} on ${networkLabel(r.app)}`, 200), notes: `${clip(r.text, 1500)}\n\nIn the Social inbox: ${link}`,
  });
  const taskId = (task as { id: string }).id;
  await deps.db.update(socialInboxItems).set({ taskId, updatedAt: deps.now() }).where(eq(socialInboxItems.id, r.id));
  return { taskId, item: await itemView(deps, auth, { ...r, taskId }) };
}

/* ---------------------------------------------------------------- saved replies */

export async function listSavedReplies(deps: Deps, auth: AuthContext): Promise<SavedReplyView[]> {
  requireP2b(deps);
  const rows = await deps.db.select().from(socialSavedReplies).where(eq(socialSavedReplies.orgId, auth.orgId)).orderBy(socialSavedReplies.title).limit(SAVED_REPLIES_MAX).all();
  return rows.map((r) => ({ id: r.id, title: r.title, body: r.body }));
}

function cleanSaved(input: { title?: string; body?: string }) {
  const title = clip(input.title, SAVED_TITLE_MAX);
  const body = clip(input.body, REPLY_MAX);
  if (!title) throw new HttpError(400, "empty", "Give the saved reply a name.");
  if (!body) throw new HttpError(400, "empty", "Write the reply text.");
  return { title, body };
}

export async function saveReply(deps: Deps, auth: AuthContext, input: { title?: string; body?: string }, id?: string): Promise<SavedReplyView> {
  requireP2b(deps);
  if (!isManager(auth.role)) throw forbidden("Only owners and admins can change saved replies.");
  const v = cleanSaved(input);
  const now = deps.now();
  if (id) {
    const r = await deps.db.update(socialSavedReplies).set({ ...v, updatedAt: now }).where(and(eq(socialSavedReplies.id, id), eq(socialSavedReplies.orgId, auth.orgId))).returning({ id: socialSavedReplies.id });
    if (!r.length) throw notFound("Saved reply");
    return { id, ...v };
  }
  const n = await deps.db.select({ n: sql<number>`count(*)` }).from(socialSavedReplies).where(eq(socialSavedReplies.orgId, auth.orgId)).get();
  if (Number(n?.n ?? 0) >= SAVED_REPLIES_MAX) throw new HttpError(422, "limit", `A workspace keeps up to ${SAVED_REPLIES_MAX} saved replies. Remove one first.`);
  const row = { id: newId("sr"), orgId: auth.orgId, ...v, createdBy: auth.userId, createdAt: now, updatedAt: now };
  await deps.db.insert(socialSavedReplies).values(row);
  return { id: row.id, ...v };
}

export async function removeSavedReply(deps: Deps, auth: AuthContext, id: string) {
  requireP2b(deps);
  if (!isManager(auth.role)) throw forbidden("Only owners and admins can change saved replies.");
  const r = await deps.db.delete(socialSavedReplies).where(and(eq(socialSavedReplies.id, id), eq(socialSavedReplies.orgId, auth.orgId))).returning({ id: socialSavedReplies.id });
  if (!r.length) throw notFound("Saved reply");
  return { ok: true as const };
}

/* ---------------------------------------------------------------- account health in the bell */

/** Rings the bell for owners and admins once when an account breaks; clears when it works again. */
export async function noteHealth(deps: Deps, orgId: string, rows: { accountId: string; app: string; code: string | null }[]) {
  if (deps.config.socialP2b === false || !rows.length) return;
  const states = await deps.db.select().from(socialAccountState).where(and(eq(socialAccountState.orgId, orgId), inIds(socialAccountState.accountId, rows.map((r) => r.accountId)))).all();
  const broken = rows.filter((r) => r.code && r.code !== "check_failed");
  let who: string[] | null = null;
  for (const r of rows) {
    const s = states.find((x) => x.accountId === r.accountId);
    const code = r.code && r.code !== "check_failed" ? r.code : null;
    if ((s?.healthCode ?? null) === code) continue;
    if (code) {
      who ??= await admins(deps, orgId);
      const name = r.app === TEST_NETWORK ? TEST_NETWORK_LABEL : networkLabel(r.app);
      await tell(deps, orgId, who, { type: "social.account_broken", entityType: "social_account", entityId: r.accountId, title: `${name} needs you to sign in again. Planned posts to it won't go out until you reconnect.` });
    }
    await saveState(deps, orgId, r.accountId, r.app, { healthCode: code, healthToldAt: code ? deps.now() : null });
  }
  return { broken: broken.length };
}

/** The test network's health row: broken when an admin turned on "Act signed out". */
export async function testHealthRows(deps: Deps, orgId: string) {
  const t = await testAccount(deps, orgId);
  if (!t) return [];
  return [{ accountId: TEST_ACCOUNT_ID, app: TEST_NETWORK, ok: !t.broken, code: t.broken ? "reconnect" : null, text: t.broken ? "The sign in has expired. Sign in again to keep posting." : null }];
}

/* ---------------------------------------------------------------- the test network (staging only) */

function requireTest(deps: Deps) {
  if (deps.config.socialTestNetwork !== true) throw new HttpError(404, "not_found", "Not found.");
}

export async function testStatus(deps: Deps, auth: AuthContext) {
  if (deps.config.socialTestNetwork !== true) return { available: false, account: null };
  const t = await testAccount(deps, auth.orgId);
  return { available: true, account: t ? { id: TEST_ACCOUNT_ID, name: t.name, broken: t.broken } : null };
}

export async function connectTest(deps: Deps, auth: AuthContext) {
  requireTest(deps);
  if (!isManager(auth.role)) throw forbidden("Only owners and admins can add accounts.");
  await deps.db.insert(socialTestAccounts).values({ orgId: auth.orgId, name: TEST_NETWORK_LABEL, broken: false, createdBy: auth.userId, createdAt: deps.now() }).onConflictDoNothing();
  (await import("./social")).clearHealthCache(auth.orgId);
  return testStatus(deps, auth);
}

export async function setTestBroken(deps: Deps, auth: AuthContext, broken: boolean) {
  requireTest(deps);
  if (!isManager(auth.role)) throw forbidden("Only owners and admins can change accounts.");
  const r = await deps.db.update(socialTestAccounts).set({ broken }).where(eq(socialTestAccounts.orgId, auth.orgId)).returning({ orgId: socialTestAccounts.orgId });
  if (!r.length) throw notFound("Test network account");
  (await import("./social")).clearHealthCache(auth.orgId);
  return testStatus(deps, auth);
}

export async function removeTest(deps: Deps, auth: AuthContext) {
  requireTest(deps);
  if (!isManager(auth.role)) throw forbidden("Only owners and admins can remove accounts.");
  await deps.db.delete(socialTestAccounts).where(eq(socialTestAccounts.orgId, auth.orgId));
  (await import("./social")).clearHealthCache(auth.orgId);
  return testStatus(deps, auth);
}

/** Publishing to the test network: refused when signed out, a text with FAIL is turned down, else it is "live". */
export async function publishTest(deps: Deps, orgId: string, postId: string, text: string): Promise<{ status: "sent" | "failed"; url?: string | null; error?: string | null; remoteId?: string | null }> {
  const t = await testAccount(deps, orgId);
  if (!t) return { status: "failed", error: "account_gone" };
  if (t.broken) return { status: "failed", error: "reconnect" };
  if (/FAIL/.test(text)) return { status: "failed", error: "rejected:The test network turned this post down" };
  return { status: "sent", url: `${deps.config.appUrl}/app/social/posts#post-${encodeURIComponent(postId)}`, remoteId: `test-${postId}` };
}

/* ---------------------------------------------------------------- analytics */

/** Stable made up results for a test network post, growing for its first two days. */
export function testStats(postId: string, sentAt: Date, now: Date) {
  let h = 2166136261;
  for (const ch of postId) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const grow = Math.min(1, Math.max(0.1, (now.getTime() - sentAt.getTime()) / (2 * 86_400_000)));
  const hour = sentAt.getUTCHours();
  const boost = hour >= 8 && hour <= 11 ? 1.6 : hour >= 18 && hour <= 21 ? 1.3 : 1;
  const reach = Math.round((300 + (h % 1700)) * grow);
  const engagement = Math.round(reach * (0.03 + ((h >>> 8) % 70) / 1000) * boost);
  const clicks = Math.round(reach * (0.005 + ((h >>> 16) % 20) / 1000));
  return { reach, engagement, clicks };
}

async function fetchStats(deps: Deps, orgId: string, a: SourceAccount, t: { postId: string; remoteId: string | null; target: string | null; sentAt: Date | null }, cache: Map<string, string>) {
  if (a.id === TEST_ACCOUNT_ID) return testStats(t.postId, t.sentAt ?? deps.now(), deps.now());
  if (!t.remoteId) return null;
  if (a.app === "threads") return (await import("../direct-social/threads")).threadsInsights(deps, orgId, t.remoteId);
  if (!a.cp) return null;
  const ctx = ctxOf(deps, a);
  const id = encodeURIComponent(t.remoteId);
  if (a.app === "facebook") {
    if (!t.target) return null;
    const tok = cache.get(t.target) ?? await pageToken(ctx, t.target);
    cache.set(t.target, tok);
    const q = encodeURIComponent(tok);
    const base = await graph(ctx, "GET", `${id}?fields=shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)&access_token=${q}`);
    const engagement = Number(asObj(asObj(base.reactions).summary).total_count ?? 0) + Number(asObj(asObj(base.comments).summary).total_count ?? 0) + Number(asObj(base.shares).count ?? 0);
    const ins = await graph(ctx, "GET", `${id}/insights?metric=post_impressions_unique,post_clicks&access_token=${q}`).catch(() => null);
    const metric = (name: string) => { const m = asArr(ins?.data).find((x) => x.name === name); const v = asArr(m?.values)[0]?.value; return typeof v === "number" ? v : null; };
    return { reach: metric("post_impressions_unique"), engagement, clicks: metric("post_clicks") };
  }
  if (a.app === "instagram") {
    const ins = await graph(ctx, "GET", `${id}/insights?metric=reach,total_interactions`);
    const metric = (name: string) => { const m = asArr(ins.data).find((x) => x.name === name); const v = asArr(m?.values)[0]?.value ?? asObj(m?.total_value).value; return typeof v === "number" ? v : null; };
    return { reach: metric("reach"), engagement: metric("total_interactions"), clicks: null };
  }
  if (a.app === "pinterest") {
    const end = deps.now().toISOString().slice(0, 10);
    const start = new Date(deps.now().getTime() - 89 * 86_400_000).toISOString().slice(0, 10);
    const r = await proxyCall(ctx, { endpoint: `https://api.pinterest.com/v5/pins/${id}/analytics?start_date=${start}&end_date=${end}&metric_types=IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK`, method: "GET" });
    if (r.status >= 400) throw new PublishError(r.status === 401 ? "reconnect" : "unavailable", `pinterest ${r.status}`);
    const s = asObj(asObj(asObj(r.data).all).summary_metrics);
    const n = (k: string) => (typeof s[k] === "number" ? (s[k] as number) : null);
    return { reach: n("IMPRESSION"), engagement: (n("SAVE") ?? 0) + (n("PIN_CLICK") ?? 0), clicks: n("OUTBOUND_CLICK") };
  }
  return null;
}

/** Asks each network for the results of posts sent in the last 30 days (bounded per pass, 6 hours between asks). */
export async function syncStats(deps: Deps, orgId: string) {
  const now = deps.now();
  const since = new Date(now.getTime() - STATS_DAYS * 86_400_000);
  const apps = ANALYTICS_APPS.filter((a) => a !== TEST_NETWORK || deps.config.socialTestNetwork === true);
  const targets = await deps.db.select({ postId: socialPostTargets.postId, accountId: socialPostTargets.accountId, app: socialPostTargets.app, remoteId: socialPostTargets.remoteId, target: socialPostTargets.target, sentAt: socialPostTargets.sentAt, fetchedAt: socialPostStats.fetchedAt })
    .from(socialPostTargets).innerJoin(socialPosts, eq(socialPosts.id, socialPostTargets.postId))
    .leftJoin(socialPostStats, and(eq(socialPostStats.postId, socialPostTargets.postId), eq(socialPostStats.accountId, socialPostTargets.accountId)))
    .where(and(eq(socialPosts.orgId, orgId), eq(socialPostTargets.status, "sent"), gte(socialPostTargets.sentAt, since), inArray(socialPostTargets.app, apps), // D1: a fixed list of at most 5 networks
     
      or(isNull(socialPostStats.fetchedAt), lt(socialPostStats.fetchedAt, new Date(now.getTime() - STATS_TTL_MS)))))
    .orderBy(desc(socialPostTargets.sentAt)).limit(STATS_PER_PASS).all();
  if (!targets.length) return { fetched: 0 };
  const accounts = await sourceAccounts(deps, orgId);
  const cache = new Map<string, string>();
  let fetched = 0;
  const touched = new Map<string, string>();
  for (const t of targets) {
    const a = accounts.find((x) => x.id === t.accountId);
    if (!a) continue;
    try {
      const s = await fetchStats(deps, orgId, a, t, cache);
      touched.set(a.id, a.app);
      if (!s) continue;
      const v = { reach: s.reach == null ? null : Math.round(s.reach), engagement: s.engagement == null ? null : Math.round(s.engagement), clicks: s.clicks == null ? null : Math.round(s.clicks), fetchedAt: now };
      await deps.db.insert(socialPostStats).values({ postId: t.postId, accountId: t.accountId, orgId, app: t.app, ...v })
        .onConflictDoUpdate({ target: [socialPostStats.postId, socialPostStats.accountId], set: v });
      fetched += 1;
    } catch (err) {
      touched.set(a.id, a.app);
      deps.log?.warn("social.stats_failed", { app: a.app, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }
  for (const [id, app] of touched) await saveState(deps, orgId, id, app, { statsSyncedAt: now });
  return { fetched };
}

export async function syncStatsNow(deps: Deps, auth: AuthContext) {
  requireP2b(deps);
  const key = `stats:${auth.orgId}`;
  const now = deps.now().getTime();
  if (now - (lastAsk.get(key) ?? 0) < SYNC_GAP_MS) return { fetched: 0, skipped: true };
  lastAsk.set(key, now);
  return { ...(await syncStats(deps, auth.orgId)), skipped: false };
}

export async function analytics(deps: Deps, auth: AuthContext, rangeRaw: string | undefined): Promise<AnalyticsResponse> {
  requireP2b(deps);
  const range = [7, 30, 90].includes(Number(rangeRaw)) ? Number(rangeRaw) : 30;
  const since = new Date(deps.now().getTime() - range * 86_400_000);
  const rows = await deps.db.select({ postId: socialPostTargets.postId, accountId: socialPostTargets.accountId, app: socialPostTargets.app, label: socialPostTargets.label, url: socialPostTargets.url, sentAt: socialPostTargets.sentAt, text: socialPosts.text, reach: socialPostStats.reach, engagement: socialPostStats.engagement, clicks: socialPostStats.clicks, fetchedAt: socialPostStats.fetchedAt })
    .from(socialPostTargets).innerJoin(socialPosts, eq(socialPosts.id, socialPostTargets.postId))
    .leftJoin(socialPostStats, and(eq(socialPostStats.postId, socialPostTargets.postId), eq(socialPostStats.accountId, socialPostTargets.accountId)))
    .where(and(eq(socialPosts.orgId, auth.orgId), eq(socialPostTargets.status, "sent"), gte(socialPostTargets.sentAt, since),
      deps.config.socialTestNetwork === true ? undefined : sql`${socialPostTargets.app} <> ${TEST_NETWORK}`))
    .orderBy(desc(socialPostTargets.sentAt)).limit(ANALYTICS_ROWS).all();
  const test = await testAccount(deps, auth.orgId);
  const out: PostStatRow[] = rows.map((r) => ({
    postId: r.postId, accountId: r.accountId, app: r.app, label: r.app === TEST_NETWORK ? (test?.name ?? TEST_NETWORK_LABEL) : r.label ?? networkLabel(r.app),
    text: clip(r.text, 160), url: r.url, sentAt: (r.sentAt ?? deps.now()).toISOString(), reach: r.reach ?? null, engagement: r.engagement ?? null, clicks: r.clicks ?? null,
  }));
  const accounts = new Map<string, { accountId: string; app: string; label: string; supported: boolean }>();
  for (const r of out) if (!accounts.has(r.accountId)) accounts.set(r.accountId, { accountId: r.accountId, app: r.app, label: r.label, supported: ANALYTICS_APPS.includes(r.app) });
  const fetched = rows.map((r) => r.fetchedAt).filter((x): x is Date => !!x);
  const syncedAt = fetched.length ? new Date(Math.max(...fetched.map((d) => d.getTime()))) : null;
  const needs = rows.some((r) => ANALYTICS_APPS.includes(r.app) && (!r.fetchedAt || deps.now().getTime() - r.fetchedAt.getTime() > STATS_TTL_MS));
  return { range, rows: out, sent: new Set(out.map((r) => r.postId)).size, syncedAt: iso(syncedAt), stale: needs, accounts: [...accounts.values()], test: !!test };
}

/* ---------------------------------------------------------------- the cron pass */

/** Every 15 minutes: pulls up to 3 workspaces whose inbox is used and is due, and results for up to 2. One read when none. */
export async function runSocialP2bPass(deps: Deps) {
  if (deps.config.socialP2b === false) return { inbox: 0, stats: 0 };
  const now = deps.now().getTime();
  const due = await deps.db.selectDistinct({ orgId: socialAccountState.orgId }).from(socialAccountState)
    .where(lt(socialAccountState.inboxSyncedAt, new Date(now - CRON_INBOX_MS))).limit(3).all();
  for (const d of due) await syncInbox(deps, d.orgId).catch((err) => deps.log?.warn("social.inbox_pass_failed", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) }));
  const statsDue = await deps.db.selectDistinct({ orgId: socialAccountState.orgId }).from(socialAccountState)
    .where(and(inArray(socialAccountState.app, ANALYTICS_APPS) /* D1: fixed list of 5 networks */, lt(socialAccountState.statsSyncedAt, new Date(now - STATS_TTL_MS)))).limit(2).all();
  for (const d of statsDue) await syncStats(deps, d.orgId).catch(() => undefined);
  return { inbox: due.length, stats: statsDue.length };
}

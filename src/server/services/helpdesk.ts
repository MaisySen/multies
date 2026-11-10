/**
 * R119: helpdesk mode on the shared inbox and the website chat (shared/helpdesk.ts holds the pure rules).
 * Mail threads and chat conversations become tickets through a bounded sync (cursor on hd_settings, at most every
 * 15 s per workspace, 200 rows a pass), run from the ticket list; existing hot routes are untouched.
 */
import { and, asc, desc, eq, gt, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { inIds } from "@/server/lib/sql-chunks";
import type { AuthContext, Deps } from "../context";
import {
  contacts, hdMacros, hdSettings, hdTickets, hdWebMessages, mailboxes, mailSnippets, members, messages, msgConversations, organizations, users,
} from "../db/schema";
import { newId, sha256Hex } from "../lib/crypto";
import { badRequest, forbidden, HttpError, notFound, tooMany } from "../lib/errors";
import {
  CSAT_LABEL, HelpdeskSettings, MacroInput, TICKET_PRIORITIES, TICKET_STATUSES, bestAnswer, changePriority, cleanVisitorText, emailOk, isBreaching,
  isOpenAt, newClock, nextOpening, normalizeDomain, onCustomerMessage, onTeamReply, originAllowed, planMacro, readSettings, slaView, transition,
  validTimezone, WIDGET_NAME_MAX, type CsatRating, type HelpdeskSettings as Settings, type SlaClock, type SlaConfig, type SlaView, type TicketKind,
  type TicketPriority, type TicketStatus, type TicketView,
} from "@/shared/helpdesk";
import { mailboxScope } from "./team";
import { assignThread, setThreadStatus } from "./mail/thread-state";
import { addComment } from "./mail/thread-comments";
import { addNote as addChatNote, patchConversation } from "./channels/service";
import { sendMessage as sendMail } from "./mail/send";
import { getBrand } from "../routes/branding";

type TicketRow = typeof hdTickets.$inferSelect;
type SettingsRow = typeof hdSettings.$inferSelect;
const isAdmin = (a: Pick<AuthContext, "role">) => a.role === "owner" || a.role === "admin";
const SYNC_EVERY_MS = 15_000;
const SYNC_BATCH = 200;
export const LIST_MAX = 100;
const WEB_DAILY_NEW_MAX = 300;
const VISITOR_WINDOW_MS = 5 * 60_000;
const VISITOR_WINDOW_MAX = 20;
const TYPING_FRESH_MS = 6_000;
const SEEN_FRESH_MS = 60_000;

function randomToken(bytes = 24): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------- settings ----------

async function orgTimezone(deps: Deps, orgId: string) {
  const o = await deps.db.select({ tz: organizations.timezone, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).get();
  return { tz: o?.tz || "Australia/Sydney", name: o?.name ?? "" };
}

async function loadRow(deps: Deps, orgId: string): Promise<SettingsRow | undefined> {
  return deps.db.select().from(hdSettings).where(eq(hdSettings.orgId, orgId)).get();
}

/** The workspace's row, made on first use (helpdesk off, a fresh website chat key). */
async function ensureRow(deps: Deps, orgId: string): Promise<SettingsRow> {
  const cur = await loadRow(deps, orgId);
  if (cur) return cur;
  await deps.db.insert(hdSettings).values({ orgId, widgetKey: `w${randomToken(12)}`, updatedAt: deps.now() }).onConflictDoNothing();
  return (await loadRow(deps, orgId))!;
}

export interface HelpdeskContext { row: SettingsRow | undefined; settings: Settings; cfg: SlaConfig; on: boolean }
export async function contextFor(deps: Deps, orgId: string): Promise<HelpdeskContext> {
  const [row, tz] = await Promise.all([loadRow(deps, orgId), orgTimezone(deps, orgId)]);
  const settings = readSettings(row?.settings, tz.tz);
  return { row, settings, cfg: { hours: settings.hours, sla: settings.sla }, on: settings.mailboxIds.length > 0 || settings.chats || settings.widget.on };
}

export async function getSettings(deps: Deps, a: AuthContext) {
  const row = await ensureRow(deps, a.orgId);
  const tz = await orgTimezone(deps, a.orgId);
  const settings = readSettings(row.settings, tz.tz);
  return {
    settings, widgetKey: row.widgetKey, canManage: isAdmin(a), on: settings.mailboxIds.length > 0 || settings.chats || settings.widget.on,
    snippet: widgetSnippet(deps.config.appUrl, row.widgetKey),
  };
}

export function widgetSnippet(appUrl: string, key: string) {
  const base = appUrl.replace(/\/$/, "");
  return `<script src="${base}/widget.js" data-key="${key}" async></script>`;
}

export async function saveSettings(deps: Deps, a: AuthContext, patch: Partial<Settings>) {
  if (!isAdmin(a)) throw forbidden("Only workspace admins can change the helpdesk settings.");
  const row = await ensureRow(deps, a.orgId);
  const tz = await orgTimezone(deps, a.orgId);
  const cur = readSettings(row.settings, tz.tz);
  const next = { ...cur, ...patch };
  if (patch.widget) {
    const domains: string[] = [];
    for (const d of patch.widget.domains ?? []) {
      const n = normalizeDomain(d);
      if (!n) throw badRequest(`"${d.slice(0, 60)}" is not a website address. Use a domain like shop.com.`);
      if (!domains.includes(n)) domains.push(n);
    }
    next.widget = { ...cur.widget, ...patch.widget, domains };
    if (next.widget.on && !next.widget.domains.length) throw badRequest("Add the website domain the chat will run on first.");
  }
  if (patch.hours && !validTimezone(patch.hours.timezone)) throw badRequest("Pick a time zone from the list.");
  const parsed = HelpdeskSettings.safeParse(next);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Those settings are not valid.");
  const ids = [...new Set([...parsed.data.mailboxIds, ...(parsed.data.widget.mailboxId ? [parsed.data.widget.mailboxId] : [])])];
  if (ids.length) {
    const found = await deps.db.select({ id: mailboxes.id, personal: mailboxes.personal }).from(mailboxes).where(and(eq(mailboxes.orgId, a.orgId), inIds(mailboxes.id, ids))).all();
    if (found.length !== ids.length) throw badRequest("One of those mailboxes is not in this workspace.");
    // PRIV1b (P22): a personal mailbox is private to its owner; its mail never becomes team tickets.
    if (found.some((m) => m.personal)) throw badRequest("A personal mailbox can't be a helpdesk mailbox. Pick a team mailbox.");
  }
  const wasOn = cur.mailboxIds.length > 0 || cur.chats;
  const nowOn = parsed.data.mailboxIds.length > 0 || parsed.data.chats;
  const now = deps.now();
  // Turning it on starts the tickets from now: old mail stays as it is, so nothing shows as late on day one.
  const set: Partial<SettingsRow> = { settings: JSON.stringify(parsed.data), updatedAt: now };
  if (nowOn && (!wasOn || !row.syncCursor)) set.syncCursor = now.getTime();
  const added = parsed.data.mailboxIds.filter((m) => !cur.mailboxIds.includes(m));
  if (wasOn && (added.length || (parsed.data.chats && !cur.chats))) set.syncCursor = Math.max(row.syncCursor, now.getTime() - 1000);
  await deps.db.update(hdSettings).set(set).where(eq(hdSettings.orgId, a.orgId));
  return getSettings(deps, a);
}

export async function rotateWidgetKey(deps: Deps, a: AuthContext) {
  if (!isAdmin(a)) throw forbidden("Only workspace admins can change the website chat.");
  await ensureRow(deps, a.orgId);
  await deps.db.update(hdSettings).set({ widgetKey: `w${randomToken(12)}`, updatedAt: deps.now() }).where(eq(hdSettings.orgId, a.orgId));
  return getSettings(deps, a);
}

// ---------- tickets: create and sync ----------

const clockOf = (t: TicketRow): SlaClock => ({
  status: t.status, priority: t.priority, createdAt: t.createdAt, firstReplyAt: t.firstReplyAt, firstReplyDueAt: t.firstReplyDueAt,
  resolveDueAt: t.resolveDueAt, resolveUsedMin: t.resolveUsedMin, runningSince: t.runningSince, solvedAt: t.solvedAt,
});
const clockCols = (c: SlaClock) => ({
  status: c.status, priority: c.priority, firstReplyAt: c.firstReplyAt, firstReplyDueAt: c.firstReplyDueAt, resolveDueAt: c.resolveDueAt,
  resolveUsedMin: Math.round(c.resolveUsedMin), runningSince: c.runningSince, solvedAt: c.solvedAt,
});

async function nextNumber(deps: Deps, orgId: string): Promise<number> {
  await ensureRow(deps, orgId);
  const r = await deps.db.update(hdSettings).set({ ticketSeq: sql`${hdSettings.ticketSeq} + 1` }).where(eq(hdSettings.orgId, orgId)).returning({ n: hdSettings.ticketSeq });
  return r[0]?.n ?? 1001;
}

async function contactIdFor(deps: Deps, orgId: string, email: string | null | undefined) {
  if (!email) return null;
  const c = await deps.db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.email, email.toLowerCase()))).get();
  return c?.id ?? null;
}

interface NewTicket {
  kind: TicketKind; refId?: string; mailboxId?: string | null; subject: string; snippet: string; requesterName: string; requesterEmail?: string | null;
  at: number; offline?: boolean; pageUrl?: string | null; visitorTokenHash?: string | null; unread?: number;
}
export async function createTicket(deps: Deps, orgId: string, cfg: SlaConfig, n: NewTicket): Promise<TicketRow> {
  const id = newId("tkt");
  const clock = newClock(n.at, "normal", cfg);
  const row: TicketRow = {
    id, orgId, number: await nextNumber(deps, orgId), kind: n.kind, refId: n.refId ?? id, mailboxId: n.mailboxId ?? null,
    subject: n.subject.slice(0, 300), snippet: n.snippet.slice(0, 200), requesterName: n.requesterName.slice(0, 120), requesterEmail: n.requesterEmail?.toLowerCase() ?? null,
    contactId: await contactIdFor(deps, orgId, n.requesterEmail), assigneeUserId: null, createdAt: n.at, lastMessageAt: n.at, unread: n.unread ?? 1,
    csatTokenHash: null, csatRating: null, csatComment: null, csatAt: null, visitorTokenHash: n.visitorTokenHash ?? null, visitorTypingAt: null, agentTypingAt: null,
    visitorSeenAt: n.kind === "web" ? n.at : null, offline: !!n.offline, pageUrl: n.pageUrl ?? null, windowStart: n.at, windowCount: 1, updatedAt: n.at,
    ...clockCols(clock),
  } as TicketRow;
  await deps.db.insert(hdTickets).values(row).onConflictDoNothing();
  const saved = await deps.db.select().from(hdTickets).where(and(eq(hdTickets.orgId, orgId), eq(hdTickets.kind, n.kind), eq(hdTickets.refId, row.refId))).get();
  return saved ?? row;
}

/**
 * Brings tickets up to date with mail and chat activity since the cursor. Returns quickly when it ran in the last
 * 15 s. A thread first seen with only our own outgoing mail is not a ticket (we started it).
 */
export async function syncTickets(deps: Deps, orgId: string, ctx?: HelpdeskContext, force = false): Promise<{ ran: boolean; created: number; updated: number }> {
  const c = ctx ?? await contextFor(deps, orgId);
  const row = c.row;
  const s = c.settings;
  const nowMs = deps.now().getTime();
  if (!row || (!s.mailboxIds.length && !s.chats)) return { ran: false, created: 0, updated: 0 };
  if (!force && nowMs - row.syncedAt < SYNC_EVERY_MS) return { ran: false, created: 0, updated: 0 };
  // Claim this pass (another isolate that read the same synced_at loses the race and skips).
  const claimed = await deps.db.update(hdSettings).set({ syncedAt: nowMs }).where(and(eq(hdSettings.orgId, orgId), eq(hdSettings.syncedAt, row.syncedAt))).returning({ o: hdSettings.orgId });
  if (!claimed.length) return { ran: false, created: 0, updated: 0 };
  const cursor = row.syncCursor;
  let created = 0, updated = 0, newCursor = nowMs - 2000;
  if (s.mailboxIds.length) {
    const boxes = await deps.db.select({ id: mailboxes.id, address: mailboxes.address }).from(mailboxes).where(and(eq(mailboxes.orgId, orgId), inIds(mailboxes.id, s.mailboxIds))).all();
    const own = new Set(boxes.map((b) => b.address.toLowerCase()));
    const rows = await deps.db.select({
      threadId: messages.threadId, mailboxId: messages.mailboxId, folder: messages.folder, fromAddress: messages.fromAddress, fromName: messages.fromName,
      subject: messages.subject, snippet: messages.snippet, date: messages.date,
    }).from(messages).where(and(eq(messages.orgId, orgId), inIds(messages.mailboxId, boxes.map((b) => b.id)), gt(messages.date, new Date(cursor)),
      sql`${messages.folder} not in ('trash', 'drafts', 'spam')`)).orderBy(asc(messages.date)).limit(SYNC_BATCH).all();
    if (rows.length === SYNC_BATCH) newCursor = Math.min(newCursor, rows[rows.length - 1].date.getTime());
    const threadIds = [...new Set(rows.map((r) => r.threadId))];
    const existing = new Map<string, TicketRow>();
    for (let i = 0; i < threadIds.length; i += 50) {
      const part = await deps.db.select().from(hdTickets).where(and(eq(hdTickets.orgId, orgId), eq(hdTickets.kind, "mail"), inIds(hdTickets.refId, threadIds.slice(i, i + 50)))).all();
      for (const t of part) existing.set(t.refId, t);
    }
    const touched = new Map<string, TicketRow>();
    for (const m of rows) {
      const at = m.date.getTime();
      const inbound = m.folder !== "sent" && !own.has(m.fromAddress.toLowerCase());
      let t = touched.get(m.threadId) ?? existing.get(m.threadId);
      if (!t) {
        if (!inbound) continue;
        t = await createTicket(deps, orgId, c.cfg, { kind: "mail", refId: m.threadId, mailboxId: m.mailboxId, subject: m.subject || "(no subject)", snippet: m.snippet, requesterName: m.fromName || m.fromAddress, requesterEmail: m.fromAddress, at });
        created++;
        touched.set(m.threadId, t); // the create counted this message
        continue;
      }
      const clock = inbound ? onCustomerMessage(clockOf(t), at, c.cfg) : onTeamReply(clockOf(t), at);
      t = { ...t, ...clockCols(clock), lastMessageAt: Math.max(t.lastMessageAt, at), snippet: (m.snippet || t.snippet).slice(0, 200), unread: inbound ? t.unread + 1 : 0 };
      touched.set(m.threadId, t);
    }
    for (const t of touched.values()) {
      if (existing.has(t.refId)) updated++;
      await deps.db.update(hdTickets).set({ ...clockCols(clockOf(t)), lastMessageAt: t.lastMessageAt, snippet: t.snippet, unread: t.unread, updatedAt: nowMs }).where(eq(hdTickets.id, t.id));
    }
  }
  if (s.chats) {
    const convs = await deps.db.select().from(msgConversations).where(and(eq(msgConversations.orgId, orgId), gt(msgConversations.lastMessageAt, new Date(cursor))))
      .orderBy(asc(msgConversations.lastMessageAt)).limit(SYNC_BATCH).all();
    if (convs.length === SYNC_BATCH) newCursor = Math.min(newCursor, convs[convs.length - 1].lastMessageAt.getTime());
    if (convs.length) {
      const have = new Map((await deps.db.select().from(hdTickets).where(and(eq(hdTickets.orgId, orgId), eq(hdTickets.kind, "chat"), inIds(hdTickets.refId, convs.map((x) => x.id)))).all()).map((t) => [t.refId, t]));
      for (const cv of convs) {
        const at = cv.lastMessageAt.getTime();
        const inbound = !!cv.lastInboundAt && cv.lastInboundAt.getTime() >= at;
        const t = have.get(cv.id);
        if (!t) {
          if (!inbound) continue;
          await createTicket(deps, orgId, c.cfg, { kind: "chat", refId: cv.id, subject: cv.contactName || "Chat", snippet: cv.snippet, requesterName: cv.contactName || cv.contactExternalId, at, unread: cv.unreadCount });
          created++;
          continue;
        }
        if (at <= t.lastMessageAt) continue;
        const clock = inbound ? onCustomerMessage(clockOf(t), at, c.cfg) : onTeamReply(clockOf(t), at);
        await deps.db.update(hdTickets).set({ ...clockCols(clock), lastMessageAt: at, snippet: cv.snippet.slice(0, 200), unread: cv.unreadCount, updatedAt: nowMs }).where(eq(hdTickets.id, t.id));
        updated++;
      }
    }
  }
  await deps.db.update(hdSettings).set({ syncCursor: Math.max(cursor, newCursor) }).where(eq(hdSettings.orgId, orgId));
  return { ran: true, created, updated };
}

/** Cron: every workspace with helpdesk mode on gets a pass (bounded). */
export async function syncAll(deps: Deps, max = 50) {
  const rows = await deps.db.select({ orgId: hdSettings.orgId }).from(hdSettings).where(gt(hdSettings.syncCursor, 0)).orderBy(asc(hdSettings.syncedAt)).limit(max).all();
  let ran = 0;
  for (const r of rows) {
    try { if ((await syncTickets(deps, r.orgId)).ran) ran++; } catch (e) { deps.reportError?.(e, { where: "helpdesk.sync", orgId: r.orgId }); }
  }
  return { ran };
}

// ---------- tickets: read ----------

export interface TicketSummary {
  id: string; number: number; kind: TicketKind; refId: string; mailboxId: string | null; subject: string; snippet: string;
  requester: { name: string; email: string | null }; contactId: string | null; status: TicketStatus; priority: TicketPriority;
  assignee: { id: string; name: string } | null; createdAt: string; lastMessageAt: string; unread: number; sla: SlaView;
  csat: { rating: CsatRating; comment: string | null; at: string } | null; offline: boolean;
}
const iso = (ms: number) => new Date(ms).toISOString();
async function names(deps: Deps, ids: (string | null)[]) {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map<string, string>();
  const rows = await deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inIds(users.id, want)).all();
  return new Map(rows.map((u) => [u.id, u.name || u.email]));
}
function summarize(t: TicketRow, cfg: SlaConfig, now: number, who: Map<string, string>): TicketSummary {
  return {
    id: t.id, number: t.number, kind: t.kind, refId: t.refId, mailboxId: t.mailboxId, subject: t.subject, snippet: t.snippet,
    requester: { name: t.requesterName, email: t.requesterEmail }, contactId: t.contactId, status: t.status, priority: t.priority,
    assignee: t.assigneeUserId ? { id: t.assigneeUserId, name: who.get(t.assigneeUserId) ?? "Teammate" } : null,
    createdAt: iso(t.createdAt), lastMessageAt: iso(t.lastMessageAt), unread: t.unread, sla: slaView(clockOf(t), now, cfg),
    csat: t.csatRating && t.csatAt ? { rating: t.csatRating, comment: t.csatComment, at: iso(t.csatAt) } : null, offline: t.offline,
  };
}

/** Members limited to some mailboxes see mail tickets of those mailboxes only (chats and website chats are shared). */
async function scopeCond(deps: Deps, a: AuthContext): Promise<SQL | undefined> {
  const scope = await mailboxScope(deps.db, a);
  if (!scope) return undefined;
  return or(ne(hdTickets.kind, "mail"), scope.length ? inIds(hdTickets.mailboxId, scope) : sql`0`);
}

export interface ListQuery { view?: TicketView; priority?: TicketPriority; kind?: TicketKind; limit?: number }
export async function listTickets(deps: Deps, a: AuthContext, q: ListQuery) {
  const ctx = await contextFor(deps, a.orgId);
  if (!ctx.on) return { on: false, tickets: [] as TicketSummary[], counts: { open: 0, mine: 0, unassigned: 0, breaching: 0 } };
  await syncTickets(deps, a.orgId, ctx);
  const now = deps.now().getTime();
  const scope = await scopeCond(deps, a);
  const base = [eq(hdTickets.orgId, a.orgId), scope].filter(Boolean) as SQL[];
  const live = inIds(hdTickets.status, ["open", "pending", "on_hold"]);
  const view = q.view ?? "open";
  const conds = [...base];
  if (q.priority) conds.push(eq(hdTickets.priority, q.priority));
  if (q.kind) conds.push(eq(hdTickets.kind, q.kind));
  if (view === "open") conds.push(live);
  else if (view === "mine") conds.push(live, eq(hdTickets.assigneeUserId, a.userId));
  else if (view === "unassigned") conds.push(live, isNull(hdTickets.assigneeUserId));
  else if (view === "solved") conds.push(eq(hdTickets.status, "solved"));
  const limit = Math.min(q.limit ?? 50, LIST_MAX);
  const horizon = now + breachHorizonMin(ctx.cfg) * 60_000;
  const breachCond = and(eq(hdTickets.status, "open"), or(and(isNull(hdTickets.firstReplyAt), lte(hdTickets.firstReplyDueAt, horizon)), lte(hdTickets.resolveDueAt, horizon)))!;
  let rows: TicketRow[];
  if (view === "breaching") {
    rows = await deps.db.select().from(hdTickets).where(and(...conds, breachCond)).orderBy(asc(hdTickets.lastMessageAt)).limit(200).all();
  } else {
    const order = view === "solved" ? desc(hdTickets.solvedAt) : desc(hdTickets.lastMessageAt);
    rows = await deps.db.select().from(hdTickets).where(and(...conds)).orderBy(order).limit(limit).all();
  }
  const who = await names(deps, rows.map((r) => r.assigneeUserId));
  let tickets = rows.map((r) => summarize(r, ctx.cfg, now, who));
  if (view === "breaching") tickets = tickets.filter((t) => isBreaching(t.sla)).sort((x, y) => dueOf(x) - dueOf(y)).slice(0, limit);
  const [cnt] = await deps.db.select({
    open: sql<number>`count(*)`,
    mine: sql<number>`sum(case when ${hdTickets.assigneeUserId} = ${a.userId} then 1 else 0 end)`,
    unassigned: sql<number>`sum(case when ${hdTickets.assigneeUserId} is null then 1 else 0 end)`,
  }).from(hdTickets).where(and(...base, live)).all();
  const breachRows = view === "breaching" ? tickets.length
    : (await deps.db.select().from(hdTickets).where(and(...base, breachCond)).limit(200).all()).filter((r) => isBreaching(slaView(clockOf(r), now, ctx.cfg))).length;
  return { on: true, tickets, counts: { open: Number(cnt?.open ?? 0), mine: Number(cnt?.mine ?? 0), unassigned: Number(cnt?.unassigned ?? 0), breaching: breachRows } };
}
const dueOf = (t: TicketSummary) => Math.min(t.sla.first.level === "warn" || t.sla.first.level === "breached" ? Date.parse(String(t.sla.first.dueAt ? iso(t.sla.first.dueAt) : "")) || Infinity : Infinity,
  t.sla.resolve.dueAt ?? Infinity);
/** Wall clock look ahead that surely covers every ticket within a quarter of its target (business time runs no faster). */
function breachHorizonMin(cfg: SlaConfig) {
  const all = TICKET_PRIORITIES.flatMap((p) => [cfg.sla[p].first, cfg.sla[p].resolve]);
  // A quarter of the longest target in working minutes can span nights and weekends: allow 4x on the wall clock.
  return Math.max(...all) * 0.25 * 4;
}

async function openTicket(deps: Deps, a: AuthContext, id: string): Promise<TicketRow> {
  const scope = await scopeCond(deps, a);
  const t = await deps.db.select().from(hdTickets).where(and(eq(hdTickets.orgId, a.orgId), eq(hdTickets.id, id), ...(scope ? [scope] : []))).get();
  if (!t) throw notFound("Ticket");
  return t;
}

export async function getTicket(deps: Deps, a: AuthContext, id: string) {
  const ctx = await contextFor(deps, a.orgId);
  const t = await openTicket(deps, a, id);
  return detail(deps, a, t, ctx);
}
export async function ticketByRef(deps: Deps, a: AuthContext, kind: TicketKind, refId: string) {
  const ctx = await contextFor(deps, a.orgId);
  if (!ctx.on) return { ticket: null };
  await syncTickets(deps, a.orgId, ctx);
  const scope = await scopeCond(deps, a);
  const t = await deps.db.select().from(hdTickets).where(and(eq(hdTickets.orgId, a.orgId), eq(hdTickets.kind, kind), eq(hdTickets.refId, refId), ...(scope ? [scope] : []))).get();
  return t ? detail(deps, a, t, ctx) : { ticket: null };
}
async function detail(deps: Deps, a: AuthContext, t: TicketRow, ctx: HelpdeskContext) {
  const now = deps.now().getTime();
  const who = await names(deps, [t.assigneeUserId]);
  const [contact, history] = await Promise.all([
    t.contactId ? deps.db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts).where(and(eq(contacts.orgId, a.orgId), eq(contacts.id, t.contactId))).get() : undefined,
    t.requesterEmail ? deps.db.select({ id: hdTickets.id, number: hdTickets.number, subject: hdTickets.subject, status: hdTickets.status, createdAt: hdTickets.createdAt })
      // PRIV1b (P22): only earlier tickets this person can open (mailbox scope), like the ticket list.
      .from(hdTickets).where(and(eq(hdTickets.orgId, a.orgId), eq(hdTickets.requesterEmail, t.requesterEmail), ne(hdTickets.id, t.id), await scopeCond(deps, a))).orderBy(desc(hdTickets.createdAt)).limit(5).all() : [],
  ]);
  return {
    ticket: summarize(t, ctx.cfg, now, who),
    contact: contact ?? null,
    history: history.map((h) => ({ ...h, createdAt: iso(h.createdAt) })),
    csatOn: ctx.settings.csat.on,
  };
}

// ---------- tickets: change ----------

export interface TicketPatch { status?: TicketStatus; priority?: TicketPriority; assigneeUserId?: string | null }

async function assertMember(deps: Deps, orgId: string, userId: string) {
  const m = await deps.db.select({ u: members.userId }).from(members).where(and(eq(members.organizationId, orgId), eq(members.userId, userId))).get();
  if (!m) throw badRequest("That person is not in this workspace.");
}

export async function patchTicket(deps: Deps, a: AuthContext, id: string, p: TicketPatch) {
  const ctx = await contextFor(deps, a.orgId);
  let t = await openTicket(deps, a, id);
  const now = deps.now().getTime();
  if (p.status && !TICKET_STATUSES.includes(p.status)) throw badRequest("Pick a status from the list.");
  if (p.priority && !TICKET_PRIORITIES.includes(p.priority)) throw badRequest("Pick a priority from the list.");
  let clock = clockOf(t);
  if (p.priority) clock = changePriority(clock, p.priority, now, ctx.cfg);
  const solving = p.status === "solved" && t.status !== "solved";
  if (p.status) clock = transition(clock, p.status, now, ctx.cfg);
  const set: Partial<TicketRow> = { ...clockCols(clock), updatedAt: now };
  if (p.assigneeUserId !== undefined && p.assigneeUserId !== t.assigneeUserId) {
    if (p.assigneeUserId) await assertMember(deps, a.orgId, p.assigneeUserId);
    set.assigneeUserId = p.assigneeUserId;
  }
  // Mirror to the thread or chat so the classic inbox views stay right (they check access themselves).
  const mirrorStatus = p.status ? (p.status === "solved" ? "done" : p.status === "open" ? "open" : "waiting") : undefined;
  if (t.kind === "mail") {
    if (set.assigneeUserId !== undefined) await assignThread(deps, a, t.refId, set.assigneeUserId ?? null);
    if (mirrorStatus) await setThreadStatus(deps, a, t.refId, mirrorStatus);
  } else if (t.kind === "chat" && (set.assigneeUserId !== undefined || mirrorStatus)) {
    await patchConversation(deps, a, t.refId, { ...(set.assigneeUserId !== undefined ? { assigneeUserId: set.assigneeUserId ?? null } : {}), ...(mirrorStatus ? { status: mirrorStatus } : {}) });
  }
  if (solving && ctx.settings.csat.on) Object.assign(set, await sendSurvey(deps, a, t, ctx));
  await deps.db.update(hdTickets).set(set).where(eq(hdTickets.id, t.id));
  t = { ...t, ...set } as TicketRow;
  return detail(deps, a, t, ctx);
}

export async function markTicketRead(deps: Deps, a: AuthContext, id: string) {
  const t = await openTicket(deps, a, id);
  if (t.unread) await deps.db.update(hdTickets).set({ unread: 0 }).where(eq(hdTickets.id, t.id));
  return { ok: true };
}

export async function addToContacts(deps: Deps, a: AuthContext, id: string) {
  const t = await openTicket(deps, a, id);
  if (!t.requesterEmail) throw badRequest("This customer has not left an email yet.");
  let cid = await contactIdFor(deps, a.orgId, t.requesterEmail);
  if (!cid) {
    cid = newId("ct");
    const now = deps.now();
    await deps.db.insert(contacts).values({ id: cid, orgId: a.orgId, name: t.requesterName === t.requesterEmail ? "" : t.requesterName, email: t.requesterEmail, source: "manual", firstContactAt: new Date(t.createdAt), lastContactAt: new Date(t.lastMessageAt), createdBy: a.userId, createdAt: now, updatedAt: now } as typeof contacts.$inferInsert).onConflictDoNothing();
    cid = (await contactIdFor(deps, a.orgId, t.requesterEmail)) ?? cid;
  }
  await deps.db.update(hdTickets).set({ contactId: cid }).where(and(eq(hdTickets.orgId, a.orgId), eq(hdTickets.requesterEmail, t.requesterEmail)));
  return { contactId: cid };
}

async function addTicketNote(deps: Deps, a: AuthContext, t: TicketRow, text: string) {
  if (t.kind === "mail") await addComment(deps, a, t.refId, { body: text });
  else if (t.kind === "chat") await addChatNote(deps, a, t.refId, text);
  else await deps.db.insert(hdWebMessages).values({ id: newId("hwm"), orgId: a.orgId, ticketId: t.id, author: "note", authorUserId: a.userId, text, createdAt: deps.now().getTime() });
}

// ---------- survey ----------

async function sendSurvey(deps: Deps, a: AuthContext, t: TicketRow, ctx: HelpdeskContext): Promise<Partial<TicketRow>> {
  if (t.csatRating) return {};
  const token = randomToken(24);
  const set: Partial<TicketRow> = { csatTokenHash: await sha256Hex(token) };
  const url = `${deps.config.appUrl.replace(/\/$/, "")}/csat/${token}`;
  if (t.kind === "web") {
    await deps.db.insert(hdWebMessages).values({ id: newId("hwm"), orgId: a.orgId, ticketId: t.id, author: "system", text: "csat", createdAt: deps.now().getTime() });
  } else if (t.kind === "mail" && t.requesterEmail && t.mailboxId) {
    const links = (["great", "okay", "bad"] as const).map((r) => `${CSAT_LABEL[r]}: ${url}?r=${r}`).join("\n");
    try {
      await sendMail(deps, a, {
        mailboxId: t.mailboxId, to: [t.requesterEmail], subject: `How did we do? (#${t.number})`,
        text: `Hi${t.requesterName && t.requesterName !== t.requesterEmail ? ` ${t.requesterName.split(" ")[0]}` : ""},\n\nWe marked your request "${t.subject}" as solved. One tap tells us how we did:\n\n${links}\n\nIf it is not solved, just reply to this mail and it opens again.\n`,
      } as Parameters<typeof sendMail>[2], { noQueue: true });
    } catch (e) {
      deps.reportError?.(e, { where: "helpdesk.survey" });
    }
  }
  void ctx;
  return set;
}

export async function surveyByToken(deps: Deps, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const t = await deps.db.select().from(hdTickets).where(eq(hdTickets.csatTokenHash, await sha256Hex(token))).get();
  if (!t) return null;
  const org = await orgTimezone(deps, t.orgId);
  return { ticket: t, workspace: org.name };
}
export async function rateSurvey(deps: Deps, token: string, rating: CsatRating, comment?: string | null) {
  const found = await surveyByToken(deps, token);
  if (!found) throw notFound("Survey");
  if (!["great", "okay", "bad"].includes(rating)) throw badRequest("Pick a rating.");
  const set: Partial<TicketRow> = { csatRating: rating, csatAt: deps.now().getTime() };
  if (comment != null) set.csatComment = cleanVisitorText(comment, 1000) || null;
  await deps.db.update(hdTickets).set(set).where(eq(hdTickets.id, found.ticket.id));
  return { ok: true, workspace: found.workspace };
}

// ---------- macros ----------

const macroOut = (m: typeof hdMacros.$inferSelect) => ({ id: m.id, name: m.name, steps: MacroInput.shape.steps.safeParse(JSON.parse(m.steps)).data ?? [], updatedAt: iso(m.updatedAt) });
export async function listMacros(deps: Deps, a: AuthContext) {
  const rows = await deps.db.select().from(hdMacros).where(eq(hdMacros.orgId, a.orgId)).orderBy(asc(hdMacros.name)).limit(200).all();
  return rows.map(macroOut);
}
export async function saveMacro(deps: Deps, a: AuthContext, input: MacroInput, id?: string) {
  if (!isAdmin(a)) throw forbidden("Only workspace admins can change macros.");
  const now = deps.now().getTime();
  if (id) {
    const cur = await deps.db.select().from(hdMacros).where(and(eq(hdMacros.orgId, a.orgId), eq(hdMacros.id, id))).get();
    if (!cur) throw notFound("Macro");
    await deps.db.update(hdMacros).set({ name: input.name, steps: JSON.stringify(input.steps), updatedAt: now }).where(eq(hdMacros.id, id));
  } else {
    const n = await deps.db.select({ n: sql<number>`count(*)` }).from(hdMacros).where(eq(hdMacros.orgId, a.orgId)).get();
    if (Number(n?.n ?? 0) >= 200) throw badRequest("A workspace can keep up to 200 macros.");
    id = newId("mac");
    await deps.db.insert(hdMacros).values({ id, orgId: a.orgId, name: input.name, steps: JSON.stringify(input.steps), createdBy: a.userId, createdAt: now, updatedAt: now });
  }
  return macroOut((await deps.db.select().from(hdMacros).where(eq(hdMacros.id, id)).get())!);
}
export async function deleteMacro(deps: Deps, a: AuthContext, id: string) {
  if (!isAdmin(a)) throw forbidden("Only workspace admins can change macros.");
  const found = await deps.db.select({ id: hdMacros.id }).from(hdMacros).where(and(eq(hdMacros.orgId, a.orgId), eq(hdMacros.id, id))).get();
  if (!found) throw notFound("Macro");
  await deps.db.delete(hdMacros).where(and(eq(hdMacros.orgId, a.orgId), eq(hdMacros.id, id)));
  return { ok: true };
}
/** Runs a macro on a ticket: field changes and notes happen now; a reply step comes back as text for the composer. */
export async function runMacro(deps: Deps, a: AuthContext, ticketId: string, macroId: string) {
  const m = await deps.db.select().from(hdMacros).where(and(eq(hdMacros.orgId, a.orgId), eq(hdMacros.id, macroId))).get();
  if (!m) throw notFound("Macro");
  const t = await openTicket(deps, a, ticketId);
  const plan = planMacro(macroOut(m).steps, a.userId);
  for (const n of plan.notes) await addTicketNote(deps, a, t, n);
  const res = await patchTicket(deps, a, t.id, { status: plan.status, priority: plan.priority, assigneeUserId: plan.assignee });
  let reply: string | null = null;
  if (plan.reply) {
    if (plan.reply.snippetId) {
      const s = await deps.db.select({ body: mailSnippets.body, shared: mailSnippets.shared, createdBy: mailSnippets.createdBy }).from(mailSnippets)
        .where(and(eq(mailSnippets.orgId, a.orgId), eq(mailSnippets.id, plan.reply.snippetId))).get();
      if (s && (s.shared || s.createdBy === a.userId)) reply = s.body;
    }
    reply = reply ?? plan.reply.text;
  }
  return { ...res, reply, ran: { name: m.name, notes: plan.notes.length } };
}

// ---------- website chat: agent side ----------

const webOut = (m: typeof hdWebMessages.$inferSelect, who: Map<string, string>) => ({
  id: m.id, author: m.author, name: m.author === "agent" || m.author === "note" ? (m.authorUserId ? who.get(m.authorUserId) ?? "Teammate" : "Teammate") : null,
  text: m.text, via: m.via, at: iso(m.createdAt),
});
export async function webThread(deps: Deps, a: AuthContext, id: string) {
  const t = await openTicket(deps, a, id);
  if (t.kind !== "web") throw notFound("Website chat");
  const rows = await deps.db.select().from(hdWebMessages).where(eq(hdWebMessages.ticketId, t.id)).orderBy(asc(hdWebMessages.createdAt)).limit(500).all();
  const who = await names(deps, rows.map((r) => r.authorUserId));
  const now = deps.now().getTime();
  return {
    messages: rows.map((r) => webOut(r, who)), visitorTyping: !!t.visitorTypingAt && now - t.visitorTypingAt < TYPING_FRESH_MS,
    visitorOnline: !!t.visitorSeenAt && now - t.visitorSeenAt < SEEN_FRESH_MS, page: t.pageUrl, email: t.requesterEmail, offline: t.offline,
  };
}
export async function webReply(deps: Deps, a: AuthContext, id: string, text: string, note = false) {
  const ctx = await contextFor(deps, a.orgId);
  const t = await openTicket(deps, a, id);
  if (t.kind !== "web") throw notFound("Website chat");
  const body = cleanVisitorText(text, 4000);
  if (!body) throw badRequest("Write a message first.");
  const now = deps.now().getTime();
  if (note) {
    await addTicketNote(deps, a, t, body);
    return webThread(deps, a, id);
  }
  // A visitor who left an email and is gone gets the reply by mail too.
  let via: string | null = null;
  const away = !t.visitorSeenAt || now - t.visitorSeenAt > 2 * 60_000;
  if (away && t.requesterEmail && ctx.settings.widget.mailboxId) {
    try {
      await sendMail(deps, a, { mailboxId: ctx.settings.widget.mailboxId, to: [t.requesterEmail], subject: `Re: ${t.subject}`, text: `${body}\n\n(Reply to this mail to continue the conversation.)` } as Parameters<typeof sendMail>[2], { noQueue: true });
      via = "mail";
    } catch (e) {
      if (e instanceof HttpError) throw new HttpError(e.status as 400, e.code, `Saved in the chat, but the mail did not go out: ${e.message}`);
      throw e;
    }
  }
  await deps.db.insert(hdWebMessages).values({ id: newId("hwm"), orgId: a.orgId, ticketId: t.id, author: "agent", authorUserId: a.userId, text: body, via, createdAt: now });
  const clock = onTeamReply(clockOf(t), now);
  await deps.db.update(hdTickets).set({ ...clockCols(clock), lastMessageAt: now, snippet: body.slice(0, 200), unread: 0, agentTypingAt: null, updatedAt: now }).where(eq(hdTickets.id, t.id));
  return webThread(deps, a, id);
}
export async function agentTyping(deps: Deps, a: AuthContext, id: string) {
  const t = await openTicket(deps, a, id);
  if (t.kind === "web") await deps.db.update(hdTickets).set({ agentTypingAt: deps.now().getTime() }).where(eq(hdTickets.id, t.id));
  return { ok: true };
}

// ---------- website chat: visitor side (public) ----------

export interface WidgetCtx { row: SettingsRow; settings: Settings; cfg: SlaConfig; orgName: string }
export async function widgetContext(deps: Deps, key: string, origin: string | null | undefined): Promise<WidgetCtx> {
  if (!/^w[A-Za-z0-9_-]{8,40}$/.test(key)) throw notFound("Chat");
  const row = await deps.db.select().from(hdSettings).where(eq(hdSettings.widgetKey, key)).get();
  if (!row) throw notFound("Chat");
  const tz = await orgTimezone(deps, row.orgId);
  const settings = readSettings(row.settings, tz.tz);
  if (!settings.widget.on) throw notFound("Chat");
  if (!originAllowed(origin, settings.widget.domains, [deps.config.appUrl])) throw forbidden("This chat is not set up for this website.");
  return { row, settings, cfg: { hours: settings.hours, sla: settings.sla }, orgName: tz.name };
}

export async function widgetConfig(deps: Deps, w: WidgetCtx) {
  const brand = await getBrand(deps.db, w.row.orgId);
  const now = deps.now().getTime();
  const online = isOpenAt(now, w.settings.hours);
  const next = online ? null : nextOpening(now, w.settings.hours);
  return {
    title: w.settings.widget.title, greeting: w.settings.widget.greeting, color: w.settings.widget.color ?? brand.primary ?? "#4f46e5",
    workspace: w.orgName, online, nextOpenAt: next ? iso(next) : null, timezone: w.settings.hours.timezone, askEmail: w.settings.widget.askEmail,
  };
}

async function visitorTicket(deps: Deps, w: WidgetCtx, token: string | undefined | null): Promise<TicketRow> {
  if (!token || token.length < 20 || token.length > 80) throw new HttpError(401, "unauthorized", "Start a new chat.");
  const t = await deps.db.select().from(hdTickets).where(and(eq(hdTickets.visitorTokenHash, await sha256Hex(token)), eq(hdTickets.orgId, w.row.orgId))).get();
  if (!t) throw new HttpError(401, "unauthorized", "Start a new chat.");
  return t;
}

async function botAnswer(deps: Deps, w: WidgetCtx, t: TicketRow, question: string, at: number) {
  if (!w.settings.widget.botAnswers) return;
  const snips = await deps.db.select({ id: mailSnippets.id, name: mailSnippets.name, body: mailSnippets.body }).from(mailSnippets)
    .where(and(eq(mailSnippets.orgId, w.row.orgId), eq(mailSnippets.shared, true))).limit(300).all();
  const best = bestAnswer(question, snips);
  if (!best) return;
  const body = snips.find((s) => s.id === best.id)!.body.slice(0, 1500);
  await deps.db.insert(hdWebMessages).values({ id: newId("hwm"), orgId: w.row.orgId, ticketId: t.id, author: "bot", text: body, createdAt: at + 1 });
}

export interface StartChat { name?: string; email?: string; text: string; page?: string; hp?: string; offline?: boolean }
export async function startChat(deps: Deps, w: WidgetCtx, b: StartChat) {
  if (b.hp) throw badRequest("Message not sent."); // the hidden field a person never fills
  const text = cleanVisitorText(b.text ?? "");
  if (!text) throw badRequest("Write a message first.");
  const email = b.email?.trim().toLowerCase() || null;
  if (email && !emailOk(email)) throw badRequest("That email does not look right.");
  const now = deps.now().getTime();
  const online = isOpenAt(now, w.settings.hours);
  const offline = !!b.offline || !online;
  if (offline && !email) throw badRequest("Leave your email so we can reply.");
  if (w.settings.widget.askEmail === "before" && !email) throw badRequest("Leave your email to start the chat.");
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const today = await deps.db.select({ n: sql<number>`count(*)` }).from(hdTickets).where(and(eq(hdTickets.orgId, w.row.orgId), eq(hdTickets.kind, "web"), gt(hdTickets.createdAt, dayStart))).get();
  if (Number(today?.n ?? 0) >= WEB_DAILY_NEW_MAX) throw tooMany("We are getting a lot of messages right now. Please try again later or send us an email.");
  const token = randomToken(24);
  const name = cleanVisitorText(b.name ?? "", WIDGET_NAME_MAX);
  let page: string | null = null;
  try { if (b.page) { const u = new URL(b.page); page = `${u.origin}${u.pathname}`.slice(0, 300); } } catch { page = null; }
  const t = await createTicket(deps, w.row.orgId, w.cfg, {
    kind: "web", subject: text.split("\n")[0].slice(0, 80), snippet: text, requesterName: name || email || "Website visitor", requesterEmail: email,
    at: now, offline, pageUrl: page, visitorTokenHash: await sha256Hex(token),
  });
  await deps.db.insert(hdWebMessages).values({ id: newId("hwm"), orgId: w.row.orgId, ticketId: t.id, author: "visitor", text, createdAt: now });
  if (!offline) await botAnswer(deps, w, t, text, now);
  return { token, ...(await visitorView(deps, w, t, 0)) };
}

async function visitorView(deps: Deps, _w: WidgetCtx, t: TicketRow, after: number) {
  const rows = await deps.db.select().from(hdWebMessages).where(and(eq(hdWebMessages.ticketId, t.id), gt(hdWebMessages.createdAt, after), ne(hdWebMessages.author, "note")))
    .orderBy(asc(hdWebMessages.createdAt)).limit(200).all();
  const who = await names(deps, rows.map((r) => r.authorUserId));
  const now = deps.now().getTime();
  return {
    status: t.status, offline: t.offline, hasEmail: !!t.requesterEmail, csat: t.csatRating ?? null,
    agentTyping: !!t.agentTypingAt && now - t.agentTypingAt < TYPING_FRESH_MS,
    messages: rows.map((r) => ({ id: r.id, author: r.author, name: r.author === "agent" ? (who.get(r.authorUserId ?? "")?.split(" ")[0] ?? "Team") : null, text: r.text, at: r.createdAt })),
  };
}

export async function visitorPoll(deps: Deps, w: WidgetCtx, token: string | undefined, after: number) {
  const t = await visitorTicket(deps, w, token);
  const now = deps.now().getTime();
  // Seen marks are written at most every 30 s, so polling costs reads, not writes.
  if (!t.visitorSeenAt || now - t.visitorSeenAt > 30_000) await deps.db.update(hdTickets).set({ visitorSeenAt: now }).where(eq(hdTickets.id, t.id));
  return visitorView(deps, w, t, after);
}

export async function visitorSend(deps: Deps, w: WidgetCtx, token: string | undefined, text: string) {
  const t = await visitorTicket(deps, w, token);
  const body = cleanVisitorText(text ?? "");
  if (!body) throw badRequest("Write a message first.");
  const now = deps.now().getTime();
  const fresh = now - t.windowStart > VISITOR_WINDOW_MS;
  if (!fresh && t.windowCount >= VISITOR_WINDOW_MAX) throw tooMany("You are sending messages very fast. Wait a moment and try again.");
  await deps.db.insert(hdWebMessages).values({ id: newId("hwm"), orgId: w.row.orgId, ticketId: t.id, author: "visitor", text: body, createdAt: now });
  const clock = onCustomerMessage(clockOf(t), now, w.cfg);
  await deps.db.update(hdTickets).set({
    ...clockCols(clock), lastMessageAt: now, snippet: body.slice(0, 200), unread: t.unread + 1, visitorTypingAt: null, visitorSeenAt: now,
    windowStart: fresh ? now : t.windowStart, windowCount: fresh ? 1 : t.windowCount + 1, updatedAt: now,
  }).where(eq(hdTickets.id, t.id));
  return visitorView(deps, w, { ...t, status: clock.status }, now - 1);
}

export async function visitorTyping(deps: Deps, w: WidgetCtx, token: string | undefined) {
  const t = await visitorTicket(deps, w, token);
  await deps.db.update(hdTickets).set({ visitorTypingAt: deps.now().getTime() }).where(eq(hdTickets.id, t.id));
  return { ok: true };
}

export async function visitorEmail(deps: Deps, w: WidgetCtx, token: string | undefined, email: string, name?: string) {
  const t = await visitorTicket(deps, w, token);
  const e = email.trim().toLowerCase();
  if (!emailOk(e)) throw badRequest("That email does not look right.");
  const n = cleanVisitorText(name ?? "", WIDGET_NAME_MAX);
  await deps.db.update(hdTickets).set({ requesterEmail: e, requesterName: n || (t.requesterName === "Website visitor" ? e : t.requesterName), contactId: await contactIdFor(deps, w.row.orgId, e) }).where(eq(hdTickets.id, t.id));
  return { ok: true };
}

export async function visitorRate(deps: Deps, w: WidgetCtx, token: string | undefined, rating: CsatRating) {
  const t = await visitorTicket(deps, w, token);
  if (!["great", "okay", "bad"].includes(rating)) throw badRequest("Pick a rating.");
  await deps.db.update(hdTickets).set({ csatRating: rating, csatAt: deps.now().getTime() }).where(eq(hdTickets.id, t.id));
  return { ok: true };
}

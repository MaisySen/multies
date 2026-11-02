/**
 * TD6 One inbox (flag INBOX_TD6): notifications, recent Inbox mail from mailboxes the person can read and assistant
 * replies (agent runs the person started) in one list, sorted Important or Noise by rules (src/shared/inbox-td6.ts).
 * Reads only through the existing checks: notifications by owner, mail by workspace and mailbox scope, runs by workspace,
 * creator and a live task. Stores only ids and state (inbox_item_state_td6) and the person's remembered choices
 * (inbox_lane_rules_td6). Never logs titles, subjects, addresses or bodies. No AI and no provider call.
 */
import { and, asc, desc, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Deps, AuthContext } from "../context";
import { agentRuns, inboxItemStateTd6, inboxLaneRulesTd6, messages, notifications, tasks, users } from "../db/schema";
import { HttpError } from "../lib/errors";
import { inIds } from "../lib/sql-chunks";
import { mailboxScope } from "./team";
import { importantBaseCond, notBulkCond } from "./mail/splits";
import { PENDING_FROM } from "./mail/pending-from";
import { linkFor } from "./suite/notify";
import { markDone, markManyDone, markUndone, presetTime, snooze, validZone, viewWhere, VIEW_ORDER, SNOOZE_MAX_MS, SNOOZE_PRESETS, type SnoozePreset } from "./suite/notify-triage";
import { markNotificationsRead, markNotificationUnread } from "./suite/notify";
import { isPeopleExcluded } from "./people-r126";
import {
  BULK_MAX, INBOX_SOURCES, INBOX_VIEWS, RULES_MAX, mailRead, ruleKey, ruleLabel, sortItem, sourceOfNote, viewOf,
  type InboxKind, type InboxLane, type InboxSource, type InboxView,
} from "@/shared/inbox-td6";

type A = Pick<AuthContext, "userId" | "orgId" | "role">;
export const MAIL_DAYS = 14;
export const MAIL_MAX = 100;
export const NOTE_MAX = 150;
export const RUN_DAYS = 30;
export const RUN_MAX = 30;

const notFound = () => new HttpError(404, "not_found", "Not found.");
const bad = (m: string) => new HttpError(422, "validation_failed", m);

/** AI gate for any later ranking hint: points at the workspace AI switch once it is on main. TD6 calls no provider. */
export function inboxAiAllowed(_deps: Deps, _orgId: string): boolean {
  return false;
}

export async function assertInboxOpen(deps: Deps, a: Partial<A>): Promise<void> {
  if (!deps.config.inboxTd6) throw notFound();
  if (!a.userId || !a.orgId || !a.role) throw notFound();
  const [o] = await deps.db.all<{ id: string; slug: string | null; name: string | null }>(sql`select id, slug, name from organizations where id = ${a.orgId} limit 1`);
  if (!o || isPeopleExcluded(o, "")) throw notFound();
}

export interface InboxItem {
  kind: InboxKind; id: string; source: InboxSource; lane: InboxLane; reason: string; remembered: boolean;
  title: string; who: string | null; at: string; read: boolean; view: InboxView; snoozedUntil: string | null; link: string;
}

type StateRow = typeof inboxItemStateTd6.$inferSelect;

async function rulesMap(deps: Deps, a: A) {
  const rows = await deps.db.select({ key: inboxLaneRulesTd6.key, lane: inboxLaneRulesTd6.lane }).from(inboxLaneRulesTd6)
    .where(and(eq(inboxLaneRulesTd6.orgId, a.orgId), eq(inboxLaneRulesTd6.userId, a.userId))).limit(RULES_MAX);
  return new Map(rows.map((r) => [r.key, r.lane as InboxLane]));
}

function scopeCond(scope: string[] | null): SQL | undefined {
  return scope ? inIds(messages.mailboxId, scope) : undefined;
}

async function loadNotes(deps: Deps, a: A, view: InboxView, now: Date) {
  const rows = await deps.db.select().from(notifications)
    .where(and(eq(notifications.orgId, a.orgId), eq(notifications.userId, a.userId), viewWhere(view, now)))
    .orderBy(...VIEW_ORDER[view]).limit(NOTE_MAX);
  const chatIds = rows.filter((r) => r.entityType === "chat_message").map((r) => r.entityId);
  const channelOf = new Map<string, string>();
  if (chatIds.length) {
    const { chatMessages } = await import("../db/schema");
    for (const m of await deps.db.select({ id: chatMessages.id, channelId: chatMessages.channelId }).from(chatMessages)
      .where(and(eq(chatMessages.orgId, a.orgId), inIds(chatMessages.id, chatIds)))) channelOf.set(m.id, m.channelId);
  }
  return rows.map((r) => ({ r, channelId: channelOf.get(r.entityId) ?? null }));
}

async function loadMail(deps: Deps, a: A, now: Date) {
  const scope = await mailboxScope(deps.db, a);
  if (scope && !scope.length) return [];
  const since = new Date(now.getTime() - MAIL_DAYS * 86_400_000);
  return deps.db.select({
    id: messages.id, fromAddress: messages.fromAddress, fromName: messages.fromName, subject: messages.subject, date: messages.date, isRead: messages.isRead,
    important: sql<number>`case when ${importantBaseCond(a.orgId)} then 1 else 0 end`,
    bulk: sql<number>`case when ${notBulkCond()} then 0 else 1 end`,
  }).from(messages)
    .where(and(eq(messages.orgId, a.orgId), eq(messages.folder, "inbox"), gt(messages.date, since), sql`${messages.fromAddress} <> ${PENDING_FROM}`, scopeCond(scope)))
    .orderBy(desc(messages.date), desc(messages.id)).limit(MAIL_MAX);
}

async function loadRuns(deps: Deps, a: A, now: Date) {
  const since = new Date(now.getTime() - RUN_DAYS * 86_400_000);
  return deps.db.select({
    id: agentRuns.id, status: agentRuns.status, finishedAt: agentRuns.finishedAt, triggerId: agentRuns.triggerId, agentUserId: agentRuns.agentUserId,
    taskId: agentRuns.taskId, title: tasks.title, agentName: users.name,
  }).from(agentRuns)
    .innerJoin(tasks, and(eq(tasks.id, agentRuns.taskId), eq(tasks.orgId, a.orgId), isNull(tasks.deletedAt)))
    .leftJoin(users, eq(users.id, agentRuns.agentUserId))
    .where(and(eq(agentRuns.orgId, a.orgId), eq(agentRuns.createdByUserId, a.userId), gt(agentRuns.finishedAt, since), inArray(agentRuns.status, ["succeeded", "failed"])))
    .orderBy(desc(agentRuns.finishedAt)).limit(RUN_MAX);
}

async function statesFor(deps: Deps, a: A, kind: "mail" | "run", ids: string[]) {
  const m = new Map<string, StateRow>();
  if (!ids.length) return m;
  for (const s of await deps.db.select().from(inboxItemStateTd6)
    .where(and(eq(inboxItemStateTd6.orgId, a.orgId), eq(inboxItemStateTd6.userId, a.userId), eq(inboxItemStateTd6.kind, kind), inIds(inboxItemStateTd6.refId, ids)))) m.set(s.refId, s);
  return m;
}

/** Every item the person can see right now (bounded), sorted and with its view. */
export async function collect(deps: Deps, a: A, view: InboxView): Promise<InboxItem[]> {
  const now = deps.now();
  const [rules, inboxNotes, otherNotes, mail, runs] = await Promise.all([
    rulesMap(deps, a),
    loadNotes(deps, a, "inbox", now),
    view === "inbox" ? Promise.resolve([]) : loadNotes(deps, a, view, now),
    loadMail(deps, a, now),
    loadRuns(deps, a, now),
  ]);
  const [mailState, runState] = await Promise.all([statesFor(deps, a, "mail", mail.map((m) => m.id)), statesFor(deps, a, "run", runs.map((r) => r.id))]);
  const out: InboxItem[] = [];
  for (const { r, channelId } of [...inboxNotes, ...otherNotes]) {
    const key = ruleKey({ kind: "note", type: r.type, entityType: r.entityType, entityId: r.entityId, channelId });
    const s = sortItem({ kind: "note", type: r.type }, key ? rules.get(key) : null);
    const v = viewOf({ doneAt: r.doneAt, snoozedUntil: r.snoozedUntil }, now);
    out.push({ kind: "note", id: r.id, source: sourceOfNote(r.type), ...s, title: r.title, who: r.actorName ?? null,
      at: (v === "inbox" && r.snoozedUntil ? r.snoozedUntil : r.createdAt).toISOString(), read: !!r.readAt, view: v,
      snoozedUntil: v === "later" && r.snoozedUntil ? r.snoozedUntil.toISOString() : null, link: linkFor(r, channelId) });
  }
  for (const m of mail) {
    const st = mailState.get(m.id);
    const key = ruleKey({ kind: "mail", sender: m.fromAddress });
    const s = sortItem({ kind: "mail", mailImportant: Number(m.important) === 1, mailBulk: Number(m.bulk) === 1 }, key ? rules.get(key) : null);
    const v = viewOf({ doneAt: st?.doneAt, snoozedUntil: st?.snoozedUntil }, now);
    out.push({ kind: "mail", id: m.id, source: "mail", ...s, title: m.subject || "(no subject)", who: m.fromName || m.fromAddress,
      at: (v === "inbox" && st?.snoozedUntil ? st.snoozedUntil : m.date).toISOString(), read: mailRead(st?.read, !!m.isRead), view: v,
      snoozedUntil: v === "later" && st?.snoozedUntil ? st.snoozedUntil.toISOString() : null, link: `/app/mail?m=${encodeURIComponent(m.id)}` });
  }
  for (const r of runs) {
    const st = runState.get(r.id);
    const key = ruleKey({ kind: "run", agentId: r.agentUserId });
    const s = sortItem({ kind: "run", type: r.status, runAutomated: !!r.triggerId }, key ? rules.get(key) : null);
    const v = viewOf({ doneAt: st?.doneAt, snoozedUntil: st?.snoozedUntil }, now);
    const at = v === "inbox" && st?.snoozedUntil ? st.snoozedUntil : (r.finishedAt ?? now);
    out.push({ kind: "run", id: r.id, source: "assistant", ...s, title: r.title, who: r.agentName ?? "Assistant", at: at.toISOString(),
      read: st?.read === true, view: v, snoozedUntil: v === "later" && st?.snoozedUntil ? st.snoozedUntil.toISOString() : null,
      link: `/app/tasks?task=${encodeURIComponent(r.taskId)}` });
  }
  return out;
}

export interface ListQuery { lane?: string; view?: string; source?: string }

export async function listInbox(deps: Deps, a: A, q: ListQuery) {
  const lane = (q.lane ?? "important") as InboxLane;
  if (lane !== "important" && lane !== "noise") throw bad("lane must be important or noise.");
  const view = (q.view ?? "inbox") as InboxView;
  if (!(INBOX_VIEWS as readonly string[]).includes(view)) throw bad("view must be inbox, later or done.");
  const source = q.source ?? "all";
  if (source !== "all" && !(INBOX_SOURCES as string[]).includes(source)) throw bad("Unknown source.");
  const all = await collect(deps, a, view);
  const inbox = all.filter((i) => i.view === "inbox");
  const counts = {
    important: inbox.filter((i) => i.lane === "important").length, noise: inbox.filter((i) => i.lane === "noise").length,
    importantUnread: inbox.filter((i) => i.lane === "important" && !i.read).length, noiseUnread: inbox.filter((i) => i.lane === "noise" && !i.read).length,
  };
  const inLane = all.filter((i) => i.view === view && i.lane === lane);
  const sources = Object.fromEntries(INBOX_SOURCES.map((s) => [s, inLane.filter((i) => i.source === s).length]));
  const items = inLane.filter((i) => source === "all" || i.source === source)
    .sort((x, y) => (view === "later" ? x.at.localeCompare(y.at) : y.at.localeCompare(x.at)));
  return { items, counts, sources, lane, view, source, ai: false };
}

export async function inboxCount(deps: Deps, a: A) {
  const all = await collect(deps, a, "inbox");
  return { unread: all.filter((i) => i.view === "inbox" && i.lane === "important" && !i.read).length };
}

/** Checks the person can reach a mail or assistant item; anything else is 404 (another workspace, another mailbox, missing). */
async function reach(deps: Deps, a: A, kind: "mail" | "run", id: string) {
  if (kind === "mail") {
    const scope = await mailboxScope(deps.db, a);
    const m = await deps.db.select({ id: messages.id, fromAddress: messages.fromAddress }).from(messages)
      .where(and(eq(messages.orgId, a.orgId), eq(messages.id, id), scopeCond(scope))).get();
    if (!m) throw notFound();
    return { sender: m.fromAddress, agentId: undefined as string | undefined };
  }
  const r = await deps.db.select({ id: agentRuns.id, agentUserId: agentRuns.agentUserId }).from(agentRuns)
    .innerJoin(tasks, and(eq(tasks.id, agentRuns.taskId), eq(tasks.orgId, a.orgId), isNull(tasks.deletedAt)))
    .where(and(eq(agentRuns.orgId, a.orgId), eq(agentRuns.id, id), eq(agentRuns.createdByUserId, a.userId))).get();
  if (!r) throw notFound();
  return { sender: undefined as string | undefined, agentId: r.agentUserId };
}

async function upsertState(deps: Deps, a: A, kind: "mail" | "run", id: string, set: Partial<Pick<StateRow, "read" | "doneAt" | "snoozedUntil">>) {
  const now = deps.now();
  await deps.db.insert(inboxItemStateTd6).values({ orgId: a.orgId, userId: a.userId, kind, refId: id, read: null, doneAt: null, snoozedUntil: null, ...set, updatedAt: now })
    .onConflictDoUpdate({ target: [inboxItemStateTd6.orgId, inboxItemStateTd6.userId, inboxItemStateTd6.kind, inboxItemStateTd6.refId], set: { ...set, updatedAt: now } });
}

async function snoozeTime(deps: Deps, a: A, input: { preset?: unknown; until?: unknown }): Promise<Date> {
  const now = deps.now();
  let until: Date;
  if (typeof input.preset === "string") {
    if (!(SNOOZE_PRESETS as readonly string[]).includes(input.preset)) throw bad("Unknown snooze preset.");
    const u = await deps.db.select({ timezone: users.timezone }).from(users).where(eq(users.id, a.userId)).get();
    until = presetTime(input.preset as SnoozePreset, now, validZone(u?.timezone));
  } else if (typeof input.until === "string" && input.until.length <= 40) {
    until = new Date(input.until);
    if (Number.isNaN(until.getTime())) throw bad("until must be an ISO date and time.");
  } else throw bad("Send a preset (later_today, tomorrow, next_week) or until.");
  if (until.getTime() <= now.getTime()) throw bad("Pick a time in the future.");
  if (until.getTime() - now.getTime() > SNOOZE_MAX_MS) throw bad("A snooze can be up to 90 days.");
  return until;
}

const ACTIONS = ["done", "undone", "read", "unread", "snooze"] as const;
type Action = (typeof ACTIONS)[number];
type Ref = { kind: InboxKind; id: string };

export function parseRefs(raw: unknown): Ref[] {
  if (!Array.isArray(raw) || !raw.length) throw bad("Send at least one item.");
  if (raw.length > BULK_MAX) throw bad(`Up to ${BULK_MAX} items at a time.`);
  return raw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if ((o.kind !== "note" && o.kind !== "mail" && o.kind !== "run") || typeof o.id !== "string" || !o.id || o.id.length > 64) throw bad("Each item needs a kind and an id.");
    return { kind: o.kind, id: o.id };
  });
}

export async function act(deps: Deps, a: A, body: Record<string, unknown>) {
  const action = body.action as Action;
  if (!(ACTIONS as readonly string[]).includes(action)) throw bad("Unknown action.");
  const refs = parseRefs(body.items);
  const until = action === "snooze" ? await snoozeTime(deps, a, body) : null;
  // Check every item first, so a bulk change is all or nothing on reach.
  for (const r of refs) if (r.kind !== "note") await reach(deps, a, r.kind, r.id);
  const notes = [...new Set(refs.filter((r) => r.kind === "note").map((r) => r.id))];
  if (notes.length) {
    const [{ n }] = await deps.db.select({ n: sql<number>`count(*)` }).from(notifications)
      .where(and(eq(notifications.orgId, a.orgId), eq(notifications.userId, a.userId), inIds(notifications.id, notes)));
    if (Number(n) !== notes.length) throw notFound();
  }
  if (notes.length) {
    if (action === "done") { if (notes.length > 1) await markManyDone(deps, a.orgId, a.userId, notes); else await markDone(deps, a.orgId, a.userId, notes[0]); }
    else if (action === "undone") for (const id of notes) await markUndone(deps, a.orgId, a.userId, id);
    else if (action === "read") await markNotificationsRead(deps, a.orgId, a.userId, notes);
    else if (action === "unread") for (const id of notes) await markNotificationUnread(deps, a.orgId, a.userId, id);
    else for (const id of notes) await snooze(deps, a.orgId, a.userId, id, { until: until!.toISOString() });
  }
  const now = deps.now();
  for (const r of refs) {
    if (r.kind === "note") continue;
    const k = r.kind;
    if (action === "done") await upsertState(deps, a, k, r.id, { doneAt: now, snoozedUntil: null });
    else if (action === "undone") await upsertState(deps, a, k, r.id, { doneAt: null, snoozedUntil: null });
    else if (action === "read") await upsertState(deps, a, k, r.id, { read: true });
    else if (action === "unread") await upsertState(deps, a, k, r.id, { read: false });
    else await upsertState(deps, a, k, r.id, { snoozedUntil: until, doneAt: null, read: false });
  }
  return { ok: true, count: refs.length, until: until ? until.toISOString() : null };
}

export async function moveItem(deps: Deps, a: A, body: Record<string, unknown>) {
  const [ref] = parseRefs([body]);
  const lane = body.lane;
  if (lane !== "important" && lane !== "noise") throw bad("lane must be important or noise.");
  let key: string | null;
  if (ref.kind === "note") {
    const n = await deps.db.select({ type: notifications.type, entityType: notifications.entityType, entityId: notifications.entityId }).from(notifications)
      .where(and(eq(notifications.orgId, a.orgId), eq(notifications.userId, a.userId), eq(notifications.id, ref.id))).get();
    if (!n) throw notFound();
    let channelId: string | null = null;
    if (n.entityType === "chat_message") {
      const { chatMessages } = await import("../db/schema");
      channelId = (await deps.db.select({ c: chatMessages.channelId }).from(chatMessages).where(and(eq(chatMessages.orgId, a.orgId), eq(chatMessages.id, n.entityId))).get())?.c ?? null;
    }
    key = ruleKey({ kind: "note", type: n.type, entityType: n.entityType, entityId: n.entityId, channelId });
  } else {
    const r = await reach(deps, a, ref.kind, ref.id);
    key = ruleKey({ kind: ref.kind, sender: r.sender, agentId: r.agentId });
  }
  if (!key) throw bad("This item cannot be moved.");
  const now = deps.now();
  const exists = await deps.db.select({ key: inboxLaneRulesTd6.key }).from(inboxLaneRulesTd6)
    .where(and(eq(inboxLaneRulesTd6.orgId, a.orgId), eq(inboxLaneRulesTd6.userId, a.userId), eq(inboxLaneRulesTd6.key, key))).get();
  if (!exists) {
    const [{ n }] = await deps.db.select({ n: sql<number>`count(*)` }).from(inboxLaneRulesTd6).where(and(eq(inboxLaneRulesTd6.orgId, a.orgId), eq(inboxLaneRulesTd6.userId, a.userId)));
    if (Number(n) >= RULES_MAX) throw bad(`You can keep up to ${RULES_MAX} choices. Remove some first.`);
  }
  await deps.db.insert(inboxLaneRulesTd6).values({ orgId: a.orgId, userId: a.userId, key, lane, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [inboxLaneRulesTd6.orgId, inboxLaneRulesTd6.userId, inboxLaneRulesTd6.key], set: { lane, updatedAt: now } });
  return { ok: true, key, label: ruleLabel(key), lane };
}

export async function listRules(deps: Deps, a: A) {
  const rows = await deps.db.select().from(inboxLaneRulesTd6).where(and(eq(inboxLaneRulesTd6.orgId, a.orgId), eq(inboxLaneRulesTd6.userId, a.userId)))
    .orderBy(asc(inboxLaneRulesTd6.createdAt)).limit(RULES_MAX);
  return rows.map((r) => ({ key: r.key, label: ruleLabel(r.key), lane: r.lane, updatedAt: r.updatedAt.toISOString() }));
}

export async function deleteRule(deps: Deps, a: A, key: unknown) {
  if (typeof key !== "string" || !key || key.length > 400) throw bad("Send the key of a saved choice.");
  const res = await deps.db.delete(inboxLaneRulesTd6)
    .where(and(eq(inboxLaneRulesTd6.orgId, a.orgId), eq(inboxLaneRulesTd6.userId, a.userId), eq(inboxLaneRulesTd6.key, key))).returning({ key: inboxLaneRulesTd6.key });
  if (!res.length) throw notFound();
  return { ok: true };
}

/**
 * Round 20: snooze a thread, send later, and "remind me if no reply" (R20.3).
 *
 * One small table (mail_schedules, primary key plus one index on status and due time) holds the live
 * items, so nothing writes to the messages row (6 rows a change) and an idle cron pass writes nothing:
 *   snooze   2 rows to add, 2 when it comes back to the top of Inbox, 2 when the person opens it
 *            (or 2 to unsnooze early). A snoozed thread hides from Inbox only while due_at is ahead,
 *            so it reappears on time even if the cron pass is paused; the pass floats it to the top.
 *   send     2 rows to schedule, 2 to claim (a delete guarded by status, so it sends exactly once),
 *            then the normal send path (services/mail/send.ts or the agent's requestSend).
 *   remind   2 rows on send, 2 when it comes back or a reply cancels it, 2 when the person opens it.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { mailboxes, mailSchedules, members, messages, organizations, users, apiKeys } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { sendMessageSchema, type SendMessageInput } from "@/shared/schemas";
import { zonedDate, zonedTime, validTimezone } from "../suite/scheduling";
import { presentListItem } from "./mailbox-view";
import { mailboxScope } from "../team";
import { assertOpen, canOpen, personalInfo, personalOwnership as ownershipOf, type Need } from "../mail-access-priv1a";
import { setSnoozedProvider, type MyWorkItem } from "../search";
import { inIds } from "../../lib/sql-chunks";

export type ScheduleKind = "snooze" | "send" | "remind";
export type SnoozePreset = "later_today" | "tomorrow" | "next_week";
type Row = typeof mailSchedules.$inferSelect;

/** Most a scheduled message may weigh (the row keeps it until it goes). */
export const MAX_SCHEDULED_BYTES = 512 * 1024;
/** Due items one cron pass takes; the rest wait for the next pass. */
export const SCHEDULE_PASS_LIMIT = 25;
/** Returned snoozes and reminders nobody opened are cleared after this long. */
export const RETURNED_TTL_MS = 14 * 86_400_000;
/** Furthest ahead anything can be scheduled. */
const MAX_AHEAD_MS = 366 * 86_400_000;
const HOUR = 3_600_000;
const MORNING = 8 * 60;

/** Who acts: a person in the app, or an API key (MCP). `scope` null means every mailbox. */
export interface ScheduleActor {
  orgId: string;
  userId: string;
  role: AuthContext["role"];
  agentId?: string | null;
  apiKeyId?: string;
  scope?: string;
}

export interface SendPayload {
  via: "person" | "agent";
  input: SendMessageInput;
  remindDays?: number;
  agentId?: string;
  apiKeyId?: string;
  /** R34: why a send was queued by a sending limit ("Queued until tomorrow" in Outbox). */
  held?: string;
  /** R34: an operator pressed "Send anyway": the next pass sends it past the limits (never past the kill switch). */
  force?: boolean;
}

// ---------------------------------------------------------------- time

/** The person's own zone (users.timezone since 0026), else the workspace's, else UTC. */
export async function zoneFor(deps: Deps, orgId: string, userId: string): Promise<string> {
  const u = userId ? await deps.db.select({ tz: users.timezone }).from(users).where(eq(users.id, userId)).get() : undefined;
  if (u?.tz && validTimezone(u.tz)) return u.tz;
  const o = await deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId)).get();
  return o?.tz && validTimezone(o.tz) ? o.tz : "UTC";
}

/** "2026-11-01T09:00" read as a wall clock time in `tz` (daylight saving safe). */
export function localToInstant(local: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw badRequest("Pick a date and time like 2026-11-01T09:00.");
  return zonedTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]) * 60 + Number(m[5]), tz);
}

/**
 * When a preset falls for someone in `tz`:
 *   later_today  three hours from now, on the next whole hour
 *   tomorrow     8:00 tomorrow
 *   next_week    8:00 next Monday (a week on, when today is Monday)
 */
export function presetInstant(preset: SnoozePreset, now: Date, tz: string): Date {
  if (preset === "later_today") return new Date(Math.ceil((now.getTime() + 3 * HOUR) / HOUR) * HOUR);
  const today = zonedDate(now, tz);
  const days = preset === "tomorrow" ? 1 : ((7 - ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(today.day)) % 7 || 7);
  // Noon on the target day in UTC terms keeps the calendar step clear of any daylight saving hour.
  const target = zonedDate(new Date(zonedTime(today.y, today.m, today.d, 12 * 60, tz).getTime() + days * 86_400_000), tz);
  return zonedTime(target.y, target.m, target.d, MORNING, tz);
}

export interface WhenInput { preset?: SnoozePreset; at?: string; local?: string }

export async function resolveWhen(deps: Deps, actor: Pick<ScheduleActor, "orgId" | "userId">, w: WhenInput): Promise<Date> {
  const now = deps.now();
  let at: Date;
  if (w.at) at = new Date(w.at);
  else if (w.local) at = localToInstant(w.local, await zoneFor(deps, actor.orgId, actor.userId));
  else if (w.preset) at = presetInstant(w.preset, now, await zoneFor(deps, actor.orgId, actor.userId));
  else throw badRequest("Say when: a preset, a time, or a date and time.");
  if (Number.isNaN(at.getTime())) throw badRequest("That time isn't valid.");
  if (at.getTime() <= now.getTime() + 30_000) throw badRequest("Pick a time in the future.");
  if (at.getTime() > now.getTime() + MAX_AHEAD_MS) throw badRequest("Pick a time within the next year.");
  return at;
}

// ---------------------------------------------------------------- access

function writable(actor: ScheduleActor) {
  if (actor.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
}

async function scopeOf(deps: Deps, actor: ScheduleActor): Promise<string[] | null> {
  if (actor.agentId) {
    const { scopeFor } = await import("../agents");
    return scopeFor(deps, actor as never);
  }
  return mailboxScope(deps.db, actor);
}

const inScope = (scope: string[] | null, mailboxId: string) => !scope || scope.includes(mailboxId);

/** The newest message of a thread the actor can open (a message id or a thread id). */
async function threadHead(deps: Deps, actor: ScheduleActor, ref: { messageId?: string; threadId?: string }, need: Need = "read") {
  const scope = await scopeOf(deps, actor);
  let threadId = ref.threadId;
  let mailboxId: string | undefined;
  if (ref.messageId) {
    const m = await deps.db.select().from(messages).where(and(eq(messages.id, ref.messageId), eq(messages.orgId, actor.orgId))).get();
    if (!m || !inScope(scope, m.mailboxId)) throw notFound("Message");
    threadId = m.threadId; mailboxId = m.mailboxId;
  }
  if (!threadId) throw badRequest("Say which thread.");
  const rows = await deps.db.select().from(messages)
    .where(and(eq(messages.orgId, actor.orgId), eq(messages.threadId, threadId), sql`${messages.folder} <> 'drafts'`, mailboxId ? eq(messages.mailboxId, mailboxId) : undefined))
    .orderBy(desc(messages.date)).limit(20);
  const head = rows.find((r) => inScope(scope, r.mailboxId));
  if (!head) throw notFound("Thread");
  // PRIV1b (P11): snooze and remind change the mailbox for everyone in it, so a read share can't (403 share_level).
  if (need !== "read" && !actor.agentId) await assertOpen(deps.db, actor, head.mailboxId, need);
  return head;
}

// ---------------------------------------------------------------- inbox view

/**
 * The listMessages condition that hides snoozed threads from Inbox while their time is ahead.
 * Reads only: a thread whose time has passed shows again even before the cron pass floats it up.
 */
export function snoozeHiddenCond(now: Date): SQL {
  return sql`not exists (select 1 from ${mailSchedules} s where s.status = 'pending' and s.kind = 'snooze' and s.due_at > ${now.getTime()} and s.mailbox_id = ${messages.mailboxId} and s.thread_id = ${messages.threadId})`;
}

// ---------------------------------------------------------------- snooze

export async function snoozeThread(deps: Deps, actor: ScheduleActor, ref: { messageId?: string; threadId?: string }, when: WhenInput) {
  writable(actor);
  const head = await threadHead(deps, actor, ref, "reply");
  const dueAt = await resolveWhen(deps, actor, when);
  // One snooze per thread: a new time replaces the old one (2 rows only when there was one).
  await deps.db.delete(mailSchedules).where(and(eq(mailSchedules.mailboxId, head.mailboxId), eq(mailSchedules.threadId, head.threadId), eq(mailSchedules.kind, "snooze")));
  const id = newId("msch");
  await deps.db.insert(mailSchedules).values({ id, orgId: actor.orgId, mailboxId: head.mailboxId, userId: actor.userId || null, kind: "snooze", threadId: head.threadId, messageId: head.id, dueAt, createdAt: deps.now() });
  return { id, threadId: head.threadId, mailboxId: head.mailboxId, dueAt: dueAt.toISOString() };
}

// ---------------------------------------------------------------- send later

function checkSize(input: SendMessageInput) {
  if (JSON.stringify(input).length > MAX_SCHEDULED_BYTES) throw new HttpError(413, "too_large_to_schedule", "Messages over 512 KB can't be scheduled. Send it now instead.");
}

/** Holds a message for later. It goes through the same send path as Send when it is due. */
export async function scheduleSend(deps: Deps, actor: ScheduleActor, raw: unknown, when: WhenInput, opts: { remindDays?: number; agentId?: string; id?: string; retry?: boolean } = {}) {
  writable(actor);
  if (opts.id && opts.retry) {
    // R55 (MB-239): a retry under the same Idempotency-Key whose first attempt queued the send gets that one back. One read, only on a retry.
    const hit = await deps.db.select({ id: mailSchedules.id, dueAt: mailSchedules.dueAt }).from(mailSchedules).where(and(eq(mailSchedules.id, opts.id), eq(mailSchedules.orgId, actor.orgId))).get();
    if (hit) return { id: hit.id, dueAt: hit.dueAt.toISOString() };
  }
  const input = sendMessageSchema.parse(raw);
  checkSize(input);
  const dueAt = await resolveWhen(deps, actor, when);
  let payload: SendPayload;
  let mailboxId = input.mailboxId;
  if (actor.agentId || opts.agentId) {
    // An agent's send keeps its rules: allowed recipients, daily cap and approvals apply when it goes.
    const { getAgent } = await import("../agents");
    const agent = await getAgent(deps, actor.orgId, (actor.agentId ?? opts.agentId)!);
    if (actor.agentId && opts.agentId && opts.agentId !== actor.agentId) throw new HttpError(403, "agent_key_scope", "This key belongs to another agent.");
    mailboxId = agent.inboxId;
    payload = { via: "agent", input: { ...input, mailboxId }, agentId: agent.id, apiKeyId: actor.apiKeyId };
  } else {
    const scope = await mailboxScope(deps.db, actor);
    if (!inScope(scope, input.mailboxId)) throw notFound("Mailbox");
    const mb = await deps.db.select({ id: mailboxes.id, personal: mailboxes.personal, address: mailboxes.address }).from(mailboxes).where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.orgId, actor.orgId))).get();
    if (!mb) throw notFound("Mailbox");
    // PRIV1b (P11, P10): the same need as Send, checked before anything is written or deleted.
    const { assertSendLevel } = await import("./send");
    await assertSendLevel(deps.db, actor, mb, input);
    // A draft that is scheduled leaves Drafts now; the scheduled copy is the one that goes. PRIV1b (P11): only the
    // caller's own draft or one nobody owns (as Send deletes it); someone else's draft stays.
    if (input.draftId) await deps.db.delete(messages).where(and(eq(messages.id, input.draftId), eq(messages.mailboxId, mb.id), eq(messages.folder, "drafts"), or(isNull(messages.sentByUserId), eq(messages.sentByUserId, actor.userId))));
    payload = { via: "person", input: { ...input, draftId: undefined }, remindDays: opts.remindDays, apiKeyId: actor.apiKeyId };
  }
  const id = opts.id ?? newId("msch");
  await deps.db.insert(mailSchedules).values({ id, orgId: actor.orgId, mailboxId, userId: actor.userId || null, kind: "send", dueAt, payload: JSON.stringify(payload), createdAt: deps.now() });
  return { id, dueAt: dueAt.toISOString() };
}

// ---------------------------------------------------------------- remind if no reply

export async function remindIfNoReply(deps: Deps, actor: ScheduleActor, messageId: string, days: number, from = deps.now()) {
  writable(actor);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw badRequest("Pick between 1 and 60 days.");
  const head = await threadHead(deps, actor, { messageId }, "reply");
  await deps.db.delete(mailSchedules).where(and(eq(mailSchedules.mailboxId, head.mailboxId), eq(mailSchedules.threadId, head.threadId), eq(mailSchedules.kind, "remind")));
  const id = newId("msch");
  const dueAt = new Date(from.getTime() + days * 86_400_000);
  await deps.db.insert(mailSchedules).values({ id, orgId: actor.orgId, mailboxId: head.mailboxId, userId: actor.userId || null, kind: "remind", threadId: head.threadId, messageId, dueAt, createdAt: deps.now() });
  return { id, threadId: head.threadId, dueAt: dueAt.toISOString() };
}

/**
 * A new message in a thread (services/suite/hooks.ts, inbound only) cancels its reminder and wakes
 * its snooze. 0 writes when the thread has none (the usual case); the table holds live items only.
 */
export async function cancelOnReply(deps: Deps, mailboxId: string, threadId: string) {
  if (!threadId) return 0;
  const gone = await deps.db.delete(mailSchedules)
    .where(and(eq(mailSchedules.mailboxId, mailboxId), eq(mailSchedules.threadId, threadId), inArray(mailSchedules.kind, ["snooze", "remind"])))
    .returning({ id: mailSchedules.id });
  return gone.length;
}

/** True when the other side wrote in this thread after `since` (also catches connected mailbox syncs). */
async function repliedSince(deps: Deps, r: Row) {
  const mb = await deps.db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.id, r.mailboxId)).get();
  const hit = await deps.db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.mailboxId, r.mailboxId), eq(messages.threadId, r.threadId ?? ""), inArray(messages.folder, ["inbox", "archive", "trash"]),
      gt(messages.createdAt, r.createdAt), sql`lower(${messages.fromAddress}) <> ${(mb?.address ?? "").toLowerCase()}`))
    .limit(1).get();
  return !!hit;
}

// ---------------------------------------------------------------- lists and edits

/**
 * PRIV1b (P11): personal mailboxes for this list of mailbox ids, with whether the actor is their owner (the workspace
 * owner for one whose owner is unknown or left). One indexed read; team and agent mailboxes are left out.
 */
async function personalOwnership(deps: Deps, actor: ScheduleActor, ids: string[]): Promise<Map<string, boolean>> {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const rows = await deps.db.select({ id: mailboxes.id, owner: mailboxes.ownerUserId, member: members.userId }).from(mailboxes)
    .leftJoin(members, and(eq(members.userId, mailboxes.ownerUserId), eq(members.organizationId, mailboxes.orgId)))
    .where(and(eq(mailboxes.orgId, actor.orgId), eq(mailboxes.personal, true), inIds(mailboxes.id, list)));
  // PRIV1b (integration M3): the shared predicate; an orphan's sends are the workspace owner's to see and cancel only.
  return new Map(rows.map((r) => { const o = ownershipOf(r, actor.userId); return [r.id, !!actor.userId && (o === "owner" || (o === "orphan" && actor.role === "owner"))]; }));
}

/**
 * Who sees a scheduled item. A team mailbox: a member their own sends, owners, admins and the agent's own key all in
 * scope. PRIV1b (P11): a personal mailbox: its owner every item, anyone else only their own sends (not by role).
 */
function seesRow(actor: ScheduleActor, r: Row, personal: Map<string, boolean>) {
  if (r.kind !== "send" || actor.agentId) return true;
  const own = personal.get(r.mailboxId);
  if (own !== undefined) return own || r.userId === actor.userId;
  return actor.role !== "member" || r.userId === actor.userId;
}

async function visibleRow(deps: Deps, actor: ScheduleActor, id: string) {
  const r = await deps.db.select().from(mailSchedules).where(and(eq(mailSchedules.id, id), eq(mailSchedules.orgId, actor.orgId))).get();
  const scope = r ? await scopeOf(deps, actor) : null;
  if (!r || !inScope(scope, r.mailboxId)) throw notFound("Scheduled item");
  const personal = await personalOwnership(deps, actor, [r.mailboxId]);
  if (!seesRow(actor, r, personal)) throw notFound("Scheduled item");
  // PRIV1b (P11): changing someone else's item in a personal mailbox needs Read and reply or more.
  if (personal.has(r.mailboxId) && !personal.get(r.mailboxId) && r.userId !== actor.userId && !actor.agentId) await assertOpen(deps.db, actor, r.mailboxId, "reply");
  return r;
}

function present(r: Row, m?: typeof messages.$inferSelect) {
  const p = r.payload ? (JSON.parse(r.payload) as SendPayload) : null;
  return {
    id: r.id, kind: r.kind, status: r.status, mailboxId: r.mailboxId, threadId: r.threadId, messageId: r.messageId,
    dueAt: r.dueAt.toISOString(), createdAt: r.createdAt.toISOString(), error: r.error,
    message: m ? presentListItem(m) : null,
    send: p ? { to: p.input.to, cc: p.input.cc ?? [], bcc: p.input.bcc ?? [], subject: p.input.subject, text: p.input.text, inReplyToId: p.input.inReplyToId ?? null, remindDays: p.remindDays ?? null, agentId: p.agentId ?? null, held: p.held ?? null } : null,
  };
}

/** Snoozed (pending snoozes), Scheduled (sends and reminders), or Returned (the top of Inbox). */
export async function listSchedules(deps: Deps, actor: ScheduleActor, q: { view: "snoozed" | "scheduled" | "returned"; mailboxId?: string; limit?: number }) {
  const scope = await scopeOf(deps, actor);
  const conds = [eq(mailSchedules.orgId, actor.orgId)];
  if (q.mailboxId) conds.push(eq(mailSchedules.mailboxId, q.mailboxId));
  if (q.view === "snoozed") conds.push(eq(mailSchedules.kind, "snooze"), eq(mailSchedules.status, "pending"), gt(mailSchedules.dueAt, deps.now()));
  else if (q.view === "scheduled") conds.push(inArray(mailSchedules.kind, ["send", "remind"]), inArray(mailSchedules.status, ["pending", "failed"]));
  else conds.push(eq(mailSchedules.status, "returned"));
  const found = (await deps.db.select().from(mailSchedules).where(and(...conds)).orderBy(q.view === "returned" ? desc(mailSchedules.dueAt) : asc(mailSchedules.dueAt)).limit(Math.min(q.limit ?? 100, 200)))
    .filter((r) => inScope(scope, r.mailboxId));
  const personal = await personalOwnership(deps, actor, found.filter((r) => r.kind === "send").map((r) => r.mailboxId));
  const rows = found.filter((r) => seesRow(actor, r, personal));
  const ids = rows.map((r) => r.messageId).filter((x): x is string => !!x);
  const msgs = ids.length ? await deps.db.select().from(messages).where(inIds(messages.id, ids)) : [];
  const byId = new Map(msgs.map((m) => [m.id, m]));
  // A snooze or reminder whose message is gone (deleted) has nothing to show.
  return rows.filter((r) => r.kind === "send" || byId.has(r.messageId ?? "")).map((r) => present(r, byId.get(r.messageId ?? "")));
}

/** Cancel a scheduled send or reminder, unsnooze, or clear a returned item (2 rows). */
export async function cancelSchedule(deps: Deps, actor: ScheduleActor, id: string) {
  writable(actor);
  const r = await visibleRow(deps, actor, id);
  const gone = await deps.db.delete(mailSchedules).where(and(eq(mailSchedules.id, r.id), eq(mailSchedules.status, r.status))).returning({ id: mailSchedules.id });
  // A send the cron pass already claimed has left: say so rather than pretend it was cancelled.
  if (!gone.length) throw new HttpError(409, "already_sent", "Too late: it has already been sent.");
  return { ok: true, item: present(r) };
}

/** Clear every returned item of a thread when the person opens it (0 writes when there are none). */
export async function clearReturned(deps: Deps, actor: ScheduleActor, messageId: string) {
  const head = await threadHead(deps, actor, { messageId });
  // PRIV1b (SL3): the returned snoozes and reminders belong to the mailbox; a read share opening the thread leaves
  // them for its owner (a quiet no-op, opening a thread must not fail).
  if (!actor.agentId && await personalInfo(deps.db, actor.orgId, head.mailboxId) && !(await canOpen(deps.db, actor, head.mailboxId, "reply"))) return { cleared: 0 };
  const gone = await deps.db.delete(mailSchedules)
    .where(and(eq(mailSchedules.mailboxId, head.mailboxId), eq(mailSchedules.threadId, head.threadId), eq(mailSchedules.status, "returned")))
    .returning({ id: mailSchedules.id });
  return { cleared: gone.length };
}

/** A new time for a scheduled send, reminder or snooze (a failed send is retried at the new time). */
export async function rescheduleItem(deps: Deps, actor: ScheduleActor, id: string, when: WhenInput) {
  writable(actor);
  const r = await visibleRow(deps, actor, id);
  if (r.status === "returned") throw badRequest("This one already came back. Snooze the thread again instead.");
  const dueAt = await resolveWhen(deps, actor, when);
  const done = await deps.db.update(mailSchedules).set({ dueAt, status: "pending", error: null })
    .where(and(eq(mailSchedules.id, r.id), eq(mailSchedules.status, r.status))).returning({ id: mailSchedules.id });
  if (!done.length) throw new HttpError(409, "already_sent", "Too late: it has already been sent.");
  return { id: r.id, dueAt: dueAt.toISOString() };
}

// ---------------------------------------------------------------- the cron pass

export interface PassResult { due: number; sent: number; failed: number; returned: number; reminded: number; replied: number; pruned: number; held: number; level?: string }

/**
 * The cron pass (services/maintenance.ts, so the Worker's scheduled handler and the Node timer both
 * run it). It reads due rows first, with a limit, and writes only when something is due: an idle pass
 * writes 0 rows. Each item is claimed by a write guarded by its status, so two passes running at once
 * process it exactly once.
 *
 * Write budget (services/write-budget.ts):
 *   ok    everything runs.
 *   warn  scheduled sends still go (a send the person was promised); snoozes and reminders wait. A
 *         snoozed thread still reappears in Inbox on time (the hiding is a read), just not on top.
 *   shed  nothing is written: scheduled sends wait and go on the first pass after the level drops
 *         (normally just after 00:00 UTC, when the daily count resets). They stay in Scheduled.
 */
export async function runMailSchedules(deps: Deps, opts: { now?: Date; orgId?: string; limit?: number } = {}): Promise<PassResult> {
  const now = opts.now ?? deps.now();
  const limit = opts.limit ?? SCHEDULE_PASS_LIMIT;
  const out: PassResult = { due: 0, sent: 0, failed: 0, returned: 0, reminded: 0, replied: 0, pruned: 0, held: 0 };
  const org = opts.orgId ? eq(mailSchedules.orgId, opts.orgId) : undefined;
  const due = await deps.db.select().from(mailSchedules)
    .where(and(eq(mailSchedules.status, "pending"), lte(mailSchedules.dueAt, now), org))
    .orderBy(asc(mailSchedules.dueAt)).limit(limit);
  const stale = await deps.db.select({ id: mailSchedules.id }).from(mailSchedules)
    .where(and(eq(mailSchedules.status, "returned"), lte(mailSchedules.dueAt, new Date(now.getTime() - RETURNED_TTL_MS)), org)).limit(limit);
  out.due = due.length;
  if (!due.length && !stale.length) return out;

  const { writeBudget } = await import("../write-budget");
  const level = (await writeBudget(deps)).level;
  out.level = level;
  if (level === "shed") { out.held = due.length; deps.log?.warn("mail_schedules.held", { reason: "write_budget_shed", due: due.length }); return out; }
  const optionalPaused = level === "warn";

  for (const r of due) {
    if (r.kind === "send") {
      // Claim: the delete returns the row to exactly one pass.
      const [claimed] = await deps.db.delete(mailSchedules).where(and(eq(mailSchedules.id, r.id), eq(mailSchedules.status, "pending"))).returning();
      if (!claimed) continue;
      try {
        await sendScheduled(deps, claimed);
        out.sent++;
      } catch (err) {
        out.failed++;
        const message = err instanceof HttpError ? err.message : "Couldn't send it. Try again or send it now.";
        if (!(err instanceof HttpError)) deps.reportError?.(err, { where: "mail_schedules.send" });
        // Back into Scheduled, marked, so the person can see why and send it again (2 rows, rare).
        await deps.db.insert(mailSchedules).values({ ...claimed, status: "failed", error: message.slice(0, 500) });
      }
      continue;
    }
    if (optionalPaused) { out.held++; continue; }
    if (r.kind === "remind" && await repliedSince(deps, r)) {
      const gone = await deps.db.delete(mailSchedules).where(and(eq(mailSchedules.id, r.id), eq(mailSchedules.status, "pending"))).returning({ id: mailSchedules.id });
      if (gone.length) out.replied++;
      continue;
    }
    const done = await deps.db.update(mailSchedules).set({ status: "returned" })
      .where(and(eq(mailSchedules.id, r.id), eq(mailSchedules.status, "pending"))).returning({ id: mailSchedules.id });
    if (done.length) { if (r.kind === "snooze") out.returned++; else out.reminded++; }
  }
  if (stale.length && !optionalPaused) {
    const gone = await deps.db.delete(mailSchedules).where(and(inIds(mailSchedules.id, stale.map((s) => s.id)), eq(mailSchedules.status, "returned"))).returning({ id: mailSchedules.id });
    out.pruned = gone.length;
  }
  if (out.sent || out.failed || out.returned || out.reminded) deps.log?.info("mail_schedules.pass", { ...out });
  return out;
}

/** Sends a claimed row through the normal send path, as the person (or agent) who scheduled it. */
async function sendScheduled(deps: Deps, r: Row) {
  const p = JSON.parse(r.payload ?? "{}") as SendPayload;
  if (p.apiKeyId) {
    const key = await deps.db.select({ id: apiKeys.id, expiresAt: apiKeys.expiresAt }).from(apiKeys).where(and(eq(apiKeys.id, p.apiKeyId), eq(apiKeys.orgId, r.orgId))).get();
    if (!key) throw badRequest("The API key that scheduled this was revoked, so it wasn't sent.");
    if (key.expiresAt && key.expiresAt.getTime() <= deps.now().getTime()) throw badRequest("The API key that scheduled this has expired, so it wasn't sent.");
  }
  const u = r.userId ? await deps.db.select().from(users).where(eq(users.id, r.userId)).get() : undefined;
  const m = r.userId ? await deps.db.select({ role: members.role }).from(members).where(and(eq(members.organizationId, r.orgId), eq(members.userId, r.userId))).get() : undefined;
  if (p.via === "agent") {
    const { requestSend } = await import("../agents");
    const actor = { userId: r.userId ?? "", email: u?.email ?? "", name: u?.name ?? "", orgId: r.orgId, role: m?.role ?? "member", sessionId: `schedule:${r.id}`, agentId: p.agentId, apiKeyId: p.apiKeyId };
    const res = await requestSend(deps, actor as never, p.agentId!, { to: p.input.to, cc: p.input.cc, subject: p.input.subject, text: p.input.text });
    return { messageId: res.status === "sent" ? res.result.messageId : null };
  }
  if (!u || !m) throw badRequest("The person who scheduled this is no longer in the workspace, so it wasn't sent.");
  const auth: AuthContext = { userId: u.id, email: u.email, name: u.name, orgId: r.orgId, role: m.role, sessionId: `schedule:${r.id}` };
  const scope = await mailboxScope(deps.db, auth);
  if (!inScope(scope, p.input.mailboxId)) throw badRequest("You no longer have access to this mailbox, so it wasn't sent.");
  const { sendMessage } = await import("./send");
  const result = await sendMessage(deps, auth, p.input, p.force ? { overrideCap: true } : {});
  // R34: still over a limit: sendMessage queued it again for the next midnight; nothing was sent.
  if (result.queued) return result;
  const { audit } = await import("../audit");
  await audit(deps.db, { orgId: r.orgId, actorUserId: u.id, actorEmail: u.email, action: "message.sent", targetType: "message", targetId: result.messageId, metadata: { recipients: [...p.input.to, ...(p.input.cc ?? []), ...(p.input.bcc ?? [])].length, scheduled: true } });
  if (p.remindDays) {
    const actor: ScheduleActor = { orgId: r.orgId, userId: u.id, role: m.role };
    await remindIfNoReply(deps, actor, result.messageId, p.remindDays).catch((err) => deps.log?.warn("mail_schedules.remind_failed", { error: (err as Error).message }));
  }
  return result;
}

/**
 * My Work's "Snoozed mail coming back" (R20.4): the person's own snoozes that return inside the window,
 * in mailboxes they can still open. Reads only.
 */
export async function snoozedComingBack(deps: Deps, actor: ScheduleActor, window: { from: Date; to: Date }): Promise<MyWorkItem[]> {
  if (!actor.userId) return [];
  const scope = await scopeOf(deps, actor);
  const rows = (await deps.db.select().from(mailSchedules)
    .where(and(eq(mailSchedules.status, "pending"), gt(mailSchedules.dueAt, window.from), lte(mailSchedules.dueAt, window.to), eq(mailSchedules.orgId, actor.orgId), eq(mailSchedules.kind, "snooze"), eq(mailSchedules.userId, actor.userId)))
    .orderBy(asc(mailSchedules.dueAt)).limit(20)).filter((r) => inScope(scope, r.mailboxId));
  const ids = rows.map((r) => r.messageId).filter((x): x is string => !!x);
  const msgs = ids.length ? await deps.db.select({ id: messages.id, subject: messages.subject, fromName: messages.fromName, fromAddress: messages.fromAddress, mailboxId: messages.mailboxId }).from(messages).where(inIds(messages.id, ids)) : [];
  const byId = new Map(msgs.map((m) => [m.id, m]));
  return rows.flatMap((r) => {
    const m = byId.get(r.messageId ?? "");
    if (!m) return [];
    return [{ id: r.id, title: m.subject || "(no subject)", subtitle: m.fromName || m.fromAddress || "", url: `/app/mail?mailbox=${m.mailboxId}&folder=inbox&m=${m.id}`, at: r.dueAt.toISOString() }];
  });
}
setSnoozedProvider((deps, actor, window) => snoozedComingBack(deps, { orgId: actor.orgId, userId: actor.userId, role: actor.role ?? "member", agentId: actor.agentId, apiKeyId: actor.apiKeyId, scope: actor.scope }, window), { probeable: true });

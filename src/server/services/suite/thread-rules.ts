/**
 * Round 22 (R22.5): mail rules that assign shared inbox threads, and the inbound hook that puts a
 * waiting or done thread back to open. automations.ts calls these; thread-state.ts does the assigning.
 *
 * Write cost: a rule that assigns writes what a normal assignment writes (the mail_thread_state row and
 * its partial index entry, plus the assignee's notification) and the automation's own run bookkeeping.
 * The round robin pointer rides on that same automation row update, so it adds no write. The reopen hook
 * reads the state row by its primary key and writes only when a waiting or done thread goes back to open.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { mailboxAccess, mailboxes, mailThreadState, members, messages } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import type { SuiteActor } from "./common";
import { inIds } from "../../lib/sql-chunks";

export type AssignThreadConfig =
  | { mode: "person"; userId: string }
  | { mode: "round_robin"; userIds: string[]; last?: string | null };

export const ROUND_ROBIN_MIN = 2;
export const ROUND_ROBIN_MAX = 20;

const bad = (msg: string) => new HttpError(422, "validation_failed", msg);

/** Checks the shape of an assign_thread action and returns it normalised (the pointer kept when still valid). */
export function parseAssignConfig(raw: Record<string, unknown> | undefined): AssignThreadConfig {
  const c = raw ?? {};
  if (c.mode === "person") {
    if (typeof c.userId !== "string" || !c.userId) throw bad("Pick the person who gets these threads.");
    return { mode: "person", userId: c.userId };
  }
  if (c.mode === "round_robin") {
    const ids = Array.isArray(c.userIds) ? c.userIds.filter((x): x is string => typeof x === "string" && !!x) : [];
    const uniq = [...new Set(ids)];
    if (uniq.length !== ids.length || ids.length !== (Array.isArray(c.userIds) ? c.userIds.length : 0)) throw bad("Each person can be in the rotation once.");
    if (uniq.length < ROUND_ROBIN_MIN || uniq.length > ROUND_ROBIN_MAX) throw bad(`Round robin needs ${ROUND_ROBIN_MIN} to ${ROUND_ROBIN_MAX} people.`);
    const last = typeof c.last === "string" && uniq.includes(c.last) ? c.last : null;
    return { mode: "round_robin", userIds: uniq, last };
  }
  throw bad("Assign to a person or round robin.");
}

/**
 * Of these user ids, the ones who are members of the workspace and can open the mailbox (owners and
 * admins open every mailbox; members need a grant). Two reads for the whole list. No mailbox: members only.
 */
export async function eligibleAssignees(deps: Deps, orgId: string, userIds: string[], mailboxId?: string | null) {
  if (!userIds.length) return new Set<string>();
  const rows = await deps.db.select({ userId: members.userId, role: members.role }).from(members)
    .where(and(eq(members.organizationId, orgId), inIds(members.userId, userIds)));
  const needGrant = rows.filter((r) => r.role === "member").map((r) => r.userId);
  const granted = mailboxId && needGrant.length
    ? new Set((await deps.db.select({ userId: mailboxAccess.userId }).from(mailboxAccess)
        .where(and(eq(mailboxAccess.orgId, orgId), eq(mailboxAccess.mailboxId, mailboxId), inIds(mailboxAccess.userId, needGrant)))).map((r) => r.userId))
    : new Set<string>();
  return new Set(rows.filter((r) => r.role !== "member" || !mailboxId || granted.has(r.userId)).map((r) => r.userId));
}

/** Save time checks for an assign_thread rule; returns the normalised action config. */
export async function validateAssignRule(deps: Deps, orgId: string, rule: { trigger: string; conditions: Record<string, unknown>; actionConfig: Record<string, unknown> }) {
  if (rule.trigger !== "email_received") throw bad("Only rules for new email can assign threads.");
  const cfg = parseAssignConfig(rule.actionConfig);
  const mailboxId = typeof rule.conditions.mailboxId === "string" && rule.conditions.mailboxId ? rule.conditions.mailboxId : null;
  if (mailboxId) {
    const mb = await deps.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, orgId))).get();
    if (!mb) throw bad("That mailbox isn't in this workspace.");
  }
  const ids = cfg.mode === "person" ? [cfg.userId] : cfg.userIds;
  const ok = await eligibleAssignees(deps, orgId, ids, mailboxId);
  const inWorkspace = await eligibleAssignees(deps, orgId, ids, null);
  const outsider = ids.find((id) => !inWorkspace.has(id));
  if (outsider) throw bad("Someone in this rule isn't in this workspace.");
  const blocked = ids.find((id) => !ok.has(id));
  if (blocked) throw bad("Someone in this rule can't open that mailbox. Give them access to it first.");
  return cfg;
}

/**
 * True when this message starts its thread: no other stored message in the thread (drafts and trash
 * aside) and no assignee on it yet. Reads only.
 */
export async function isFirstOfThread(deps: Deps, orgId: string, threadId: string, messageId: string) {
  if (!threadId) return false;
  const other = await deps.db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.threadId, threadId), ne(messages.id, messageId), sql`${messages.folder} not in ('trash', 'drafts')`)).limit(1).get();
  if (other) return false;
  const st = await deps.db.select({ a: mailThreadState.assigneeUserId }).from(mailThreadState).where(and(eq(mailThreadState.orgId, orgId), eq(mailThreadState.threadId, threadId))).get();
  return !st?.a;
}

/** The next person in the rotation after `last`, skipping anyone not in `eligible`. */
export function nextInRotation(userIds: string[], last: string | null | undefined, eligible: Set<string>) {
  const start = last ? userIds.indexOf(last) + 1 : 0;
  for (let i = 0; i < userIds.length; i++) {
    const id = userIds[(start + i) % userIds.length];
    if (eligible.has(id)) return id;
  }
  return null;
}

/**
 * Runs one assign_thread rule for a new inbound thread. Returns the new action config JSON when the
 * round robin pointer moved (the caller saves it with the run bookkeeping), else undefined.
 * Throws when nobody in the rule can take the thread (the caller records it as the rule's last error).
 */
export async function runAssignRule(deps: Deps, actor: SuiteActor, actionConfig: string, m: { threadId: string; mailboxId: string }) {
  const cfg = parseAssignConfig(JSON.parse(actionConfig) as Record<string, unknown>);
  const ids = cfg.mode === "person" ? [cfg.userId] : cfg.userIds;
  const eligible = await eligibleAssignees(deps, actor.orgId, ids, m.mailboxId);
  const pick = cfg.mode === "person" ? (eligible.has(cfg.userId) ? cfg.userId : null) : nextInRotation(cfg.userIds, cfg.last, eligible);
  if (!pick) throw new Error("Nobody in this rule can open that mailbox now.");
  const { assignThread } = await import("../mail/thread-state");
  await assignThread(deps, actor, m.threadId, pick);
  return cfg.mode === "round_robin" ? JSON.stringify({ ...cfg, last: pick }) : undefined;
}

/**
 * New inbound mail on a waiting or done thread puts it back to open. One primary key read when the
 * thread has a state row; a write only when the status changes. Threads with no row are open already.
 */
export async function reopenOnInbound(deps: Deps, orgId: string, threadId: string) {
  if (!threadId) return false;
  const where = and(eq(mailThreadState.orgId, orgId), eq(mailThreadState.threadId, threadId));
  const st = await deps.db.select({ status: mailThreadState.status }).from(mailThreadState).where(where).get();
  if (!st || st.status === "open") return false;
  await deps.db.update(mailThreadState).set({ status: "open", doneAt: null, updatedAt: deps.now() }).where(where);
  return true;
}

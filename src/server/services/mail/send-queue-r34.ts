/**
 * R34 (MB-166): the operator's view of messages a sending limit queued until midnight UTC, and "Send anyway".
 * Send anyway marks the held row (force) and makes it due now; the next schedules pass sends it past the limits,
 * never past the kill switch. Writes: one row update (essential, the operator's action).
 */
import { and, asc, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { mailSchedules } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import type { SendPayload } from "./schedules";

export async function listQueuedSends(deps: Deps, orgId: string) {
  const rows = await deps.db.select().from(mailSchedules).where(and(eq(mailSchedules.orgId, orgId), eq(mailSchedules.kind, "send"), eq(mailSchedules.status, "pending")))
    .orderBy(asc(mailSchedules.dueAt)).limit(200);
  return rows.flatMap((r) => {
    const p = JSON.parse(r.payload ?? "{}") as SendPayload;
    if (!p.held) return [];
    return [{ id: r.id, mailboxId: r.mailboxId, dueAt: r.dueAt.toISOString(), reason: p.held, subject: p.input.subject, recipients: [...p.input.to, ...(p.input.cc ?? []), ...(p.input.bcc ?? [])].length, forced: !!p.force }];
  });
}

export async function sendQueuedAnyway(deps: Deps, orgId: string, id: string) {
  const r = await deps.db.select().from(mailSchedules).where(and(eq(mailSchedules.id, id), eq(mailSchedules.orgId, orgId), eq(mailSchedules.kind, "send"))).get();
  if (!r) throw notFound("Queued message");
  const p = JSON.parse(r.payload ?? "{}") as SendPayload;
  if (!p.held) throw badRequest("That message wasn't queued by a sending limit.");
  const dueAt = deps.now();
  await deps.db.update(mailSchedules).set({ status: "pending", dueAt, error: null, payload: JSON.stringify({ ...p, force: true }) }).where(eq(mailSchedules.id, r.id));
  return { ok: true, id: r.id, dueAt: dueAt.toISOString() };
}

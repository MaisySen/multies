/**
 * TD4: give billed time back when its invoice goes away. Called when a draft invoice is deleted or an issued invoice is
 * voided. Only invoices made by a billing run hold time, so for any other document this is one indexed read that finds
 * nothing. Writes an audit entry with the run, the invoice and how many entries came back (no notes, no amounts).
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { billRuns, timeEntries } from "../../db/schema";
import { audit } from "../audit";

export async function releaseBilledTime(deps: Deps, a: { orgId: string; userId: string; email?: string | null }, docId: string, why: "draft_deleted" | "voided") {
  const runs = await deps.db.update(billRuns).set({ status: "released", releasedAt: deps.now(), releasedBy: a.userId, releaseReason: why })
    .where(and(eq(billRuns.orgId, a.orgId), eq(billRuns.docId, docId), eq(billRuns.status, "open"))).returning({ id: billRuns.id });
  if (!runs.length) return 0;
  const back = await deps.db.update(timeEntries).set({ billedDocId: null, billedAt: null })
    .where(and(eq(timeEntries.orgId, a.orgId), eq(timeEntries.billedDocId, docId))).returning({ id: timeEntries.id });
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email ?? null, action: "bill_time.released", targetType: "invoice", targetId: docId, metadata: { runs: runs.map((r) => r.id), entries: back.length, why } });
  return back.length;
}

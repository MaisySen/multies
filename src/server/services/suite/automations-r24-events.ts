/**
 * R24 polish: two more ways recipes hear about changes.
 *   - meeting_ended when a call started from chat ends because the last person left (calls.ts marks
 *     the meeting ended once; this runs the rules after that one write).
 *   - assignee_changed for bulk assignee edits (bulk.ts), with one read of the rules for the whole
 *     request and at most BULK_RULE_RUNS rule runs; the rest are skipped and counted.
 * Both pause while the day's write budget reads warn or shed, like the other optional writers.
 */
import type { Deps } from "../../context";
import { and, eq, isNull } from "drizzle-orm";
import { automations } from "../../db/schema";
import type { SuiteActor } from "./common";
import type { Task } from "./tasks";

export const BULK_RULE_RUNS = 50;

async function paused(deps: Deps) {
  const { writeBudget } = await import("../write-budget");
  const level = (await writeBudget(deps)).level;
  return level === "warn" || level === "shed";
}

/** A call emptied and its meeting was just marked ended. Runs as the workspace's automation, not a person. */
export async function runCallEnded(deps: Deps, meeting: { id: string; orgId: string; title: string }) {
  const actor: SuiteActor = { orgId: meeting.orgId, userId: "", email: "automation", name: "Automation: call ended", system: true };
  const rules = await deps.db.select({ id: automations.id }).from(automations)
    .where(and(eq(automations.orgId, meeting.orgId), eq(automations.trigger, "meeting_ended"), eq(automations.enabled, true), isNull(automations.deletedAt))).limit(1);
  if (!rules.length || (await paused(deps))) return 0;
  const { runMeetingEnded } = await import("./automations-r24");
  return runMeetingEnded(deps, actor, { id: meeting.id, title: meeting.title });
}

/**
 * Tasks whose assignee a bulk edit just changed. Returns how many rule runs happened and how many
 * tasks were skipped (over the cap, or paused by the write budget). No rules: one read, no writes.
 */
export async function runBulkAssigneeChanged(deps: Deps, actor: SuiteActor, changed: Task[]) {
  const withPerson = changed.filter((t) => t.assignee && !t.triage);
  if (!withPerson.length) return { runs: 0, skipped: 0 };
  const rules = await deps.db.select().from(automations)
    .where(and(eq(automations.orgId, actor.orgId), eq(automations.trigger, "assignee_changed"), eq(automations.enabled, true), isNull(automations.deletedAt)));
  if (!rules.length) return { runs: 0, skipped: 0 };
  if (await paused(deps)) return { runs: 0, skipped: withPerson.length };
  const { runTaskEvent } = await import("./automations-r24");
  let runs = 0;
  let done = 0;
  for (const t of withPerson) {
    if (runs >= BULK_RULE_RUNS) break;
    runs += await runTaskEvent(deps, actor, "assignee_changed", t, { rules });
    done++;
  }
  return { runs, skipped: withPerson.length - done };
}

/**
 * R38: sample requests waiting in Triage for the demo workspace, so a visitor (and the e2e for the triage keys
 * A, D, H, M and O) finds real rows there. Three requests from the places triage collects from: a form, an email
 * and the API. Checks for itself, so a retry never makes them twice.
 *
 * Writes: one batch of 3 task rows plus 3 change rows, once per demo workspace (essential seed writes).
 */
import { and, eq, isNotNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { runBatch } from "../../db";
import { changes, tasks } from "../../db/schema";
import { changeRow, createdBy, parseDate, sortableId, type SuiteActor } from "./common";
import { claimNumbers } from "./project-counter";

const day = (now: number, d: number) => new Date(now + d * 86_400_000).toISOString().slice(0, 10);

export const DEMO_TRIAGE = [
  { title: "Website enquiry: 20 mailboxes for a dental group", source: "form" as const, from: "Dr Lena Park <lena@brightsmile.dental>", notes: "Sent through the Website enquiry form.\n\nWe have 4 clinics and about 20 staff. Can we keep our old addresses while we move?", priority: "medium" as const, due: 3 },
  { title: "Invoice 1042 shows the wrong ABN", source: "mail" as const, from: "Accounts <accounts@blueharbor.co>", notes: "The ABN on invoice 1042 is our old one. Could you send a corrected copy?", priority: "high" as const, due: 1 },
  { title: "Add a shared calendar for the front desk", source: "api" as const, from: "Front desk kiosk", notes: "Created by the front desk kiosk through the API.", priority: "low" as const, due: 7 },
];

export async function seedDemoTriage(deps: Deps, actor: SuiteActor, project: { id: string; statuses: { id: string; category: "todo" | "doing" | "done" }[] }, now: number) {
  const have = await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, actor.orgId), isNotNull(tasks.triageState))).limit(1).get();
  if (have) return [];
  const todo = project.statuses.find((s) => s.category === "todo") ?? project.statuses[0];
  if (!todo) return [];
  const first = await claimNumbers(deps, project.id, DEMO_TRIAGE.length);
  const ids = DEMO_TRIAGE.map((_, i) => sortableId("tsk", now + 500 + i));
  const stmts: PromiseLike<unknown>[] = [];
  DEMO_TRIAGE.forEach((t, i) => {
    const at = new Date(now - (DEMO_TRIAGE.length - i) * 37 * 60_000); // spread over the last couple of hours
    stmts.push(deps.db.insert(tasks).values({
      id: ids[i], orgId: actor.orgId, projectId: project.id, number: first + i, statusId: todo.id, status: todo.category, title: t.title, notes: t.notes,
      assigneeType: null, assigneeId: null, priority: t.priority, startAt: null, dueAt: parseDate(day(now, t.due)), labels: "[]", parentId: null,
      position: (i + 1) * 1024 + 900_000, completedAt: null, triageState: "pending", triageSource: t.source, sourceFrom: t.from,
      ...createdBy(actor), createdAt: at, updatedAt: at,
    }));
    stmts.push(deps.db.insert(changes).values(changeRow(actor.orgId, { type: "member", id: actor.userId, name: actor.name }, at, { entityType: "task", entityId: ids[i], op: "create", verb: "task.created", data: { title: t.title } })));
  });
  await runBatch(deps.db, stmts);
  return ids;
}

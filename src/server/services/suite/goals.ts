/**
 * Goals and OKRs. A goal has key results; each key result is a number (from a start value to a
 * target, also as AUD or a percentage) or a set of tasks (linked tasks, or every top level task
 * in a project). Progress is worked out when read, so it moves as tasks are finished. A goal
 * can sit under a bigger goal: its progress is the average of its key results and child goals,
 * and the portfolio roll-up is the average of the top level goals.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { entityLinks, goals, keyResults, members, tasks, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { assertWritable, createdBy, iso, parseDate, recordWrite, sortableId, type SuiteActor } from "./common";
import { notify } from "./notify";
import { resolveTaskId } from "./tasks";

type GoalRow = typeof goals.$inferSelect;
type KrRow = typeof keyResults.$inferSelect;
export type Health = "on_track" | "at_risk" | "off_track";

const notFound = (w = "Goal") => new HttpError(404, "not_found", `${w} not found.`);
const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Progress of a number key result, 0 to 1. Works for targets below the start (for example cutting costs). */
export function numberProgress(start: number, target: number, current: number) {
  if (target === start) return current === target ? 1 : 0;
  return clamp((current - start) / (target - start));
}

/** Expected progress by now, from the goal's dates: used for a suggested health when none is set. */
export function expectedProgress(start: Date | null, due: Date | null, now: Date) {
  if (!start || !due || due.getTime() <= start.getTime()) return null;
  return clamp((now.getTime() - start.getTime()) / (due.getTime() - start.getTime()));
}

export function suggestHealth(progress: number, expected: number | null): Health | null {
  if (expected === null) return null;
  if (progress >= expected - 0.1) return "on_track";
  if (progress >= expected - 0.25) return "at_risk";
  return "off_track";
}

async function taskCounts(deps: Deps, orgId: string, krs: KrRow[]) {
  const out = new Map<string, { total: number; done: number; taskIds: string[] }>();
  const taskKrs = krs.filter((k) => k.kind === "tasks");
  if (!taskKrs.length) return out;
  const links = await deps.db.select({ fromId: entityLinks.fromId, toId: entityLinks.toId }).from(entityLinks)
    .where(and(eq(entityLinks.orgId, orgId), eq(entityLinks.fromType, "key_result"), inArray(entityLinks.fromId, taskKrs.map((k) => k.id)), eq(entityLinks.toType, "task")));
  const linkedIds = [...new Set(links.map((l) => l.toId))];
  const linkedRows = linkedIds.length ? await deps.db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(and(eq(tasks.orgId, orgId), inArray(tasks.id, linkedIds), isNull(tasks.deletedAt))) : [];
  const statusOf = new Map(linkedRows.map((t) => [t.id, t.status]));
  const projectIds = [...new Set(taskKrs.map((k) => k.projectId).filter(Boolean))] as string[];
  const byProject = new Map<string, { total: number; done: number }>();
  if (projectIds.length) {
    const rows = await deps.db.select({ projectId: tasks.projectId, total: sql<number>`count(*)`, done: sql<number>`sum(case when ${tasks.status} = 'done' then 1 else 0 end)` })
      .from(tasks).where(and(eq(tasks.orgId, orgId), inArray(tasks.projectId, projectIds), isNull(tasks.parentId), isNull(tasks.deletedAt))).groupBy(tasks.projectId);
    for (const r of rows) byProject.set(r.projectId, { total: Number(r.total) || 0, done: Number(r.done) || 0 });
  }
  for (const k of taskKrs) {
    const ids = links.filter((l) => l.fromId === k.id).map((l) => l.toId).filter((id) => statusOf.has(id));
    let total = ids.length, done = ids.filter((id) => statusOf.get(id) === "done").length;
    if (k.projectId) { const p = byProject.get(k.projectId) ?? { total: 0, done: 0 }; total += p.total; done += p.done; }
    out.set(k.id, { total, done, taskIds: ids });
  }
  return out;
}

function presentKr(k: KrRow, counts?: { total: number; done: number; taskIds: string[] }) {
  const progress = k.kind === "tasks" ? (counts && counts.total ? counts.done / counts.total : 0) : numberProgress(k.startValue, k.targetValue, k.currentValue);
  return {
    id: k.id, goalId: k.goalId, name: k.name, kind: k.kind, unit: k.kind === "currency" ? "AUD" : k.kind === "percent" ? "%" : k.unit,
    start: k.startValue, target: k.targetValue, current: k.kind === "tasks" ? (counts?.done ?? 0) : k.currentValue,
    projectId: k.projectId, taskIds: counts?.taskIds ?? [], tasks: k.kind === "tasks" ? { total: counts?.total ?? 0, done: counts?.done ?? 0 } : null,
    progress: Math.round(progress * 100), updatedAt: k.updatedAt.toISOString(),
  };
}
export type KeyResult = ReturnType<typeof presentKr>;

interface GoalNode {
  id: string; name: string; description: string; owner: { id: string; name: string } | null; parentId: string | null;
  start: string | null; due: string | null; health: Health | null; suggestedHealth: Health | null; archived: boolean;
  progress: number; keyResults: KeyResult[]; children: GoalNode[]; createdAt: string; updatedAt: string;
}

/** Every goal in the workspace as a tree, with progress rolled up from key results and child goals. */
export async function goalTree(deps: Deps, orgId: string, opts: { includeArchived?: boolean } = {}) {
  const rows = await deps.db.select().from(goals).where(and(eq(goals.orgId, orgId), isNull(goals.deletedAt), opts.includeArchived ? undefined : eq(goals.archived, false))).orderBy(asc(goals.createdAt));
  const ids = rows.map((r) => r.id);
  const krs = ids.length ? await deps.db.select().from(keyResults).where(and(inArray(keyResults.goalId, ids), isNull(keyResults.deletedAt))).orderBy(asc(keyResults.position), asc(keyResults.createdAt)) : [];
  const counts = await taskCounts(deps, orgId, krs);
  const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter(Boolean))] as string[];
  const owners = ownerIds.length ? new Map((await deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds))).map((u) => [u.id, u.name])) : new Map<string, string>();
  const now = deps.now();
  const nodes = new Map<string, GoalNode>();
  for (const g of rows) {
    nodes.set(g.id, {
      id: g.id, name: g.name, description: g.description, owner: g.ownerId ? { id: g.ownerId, name: owners.get(g.ownerId) ?? "Former member" } : null,
      parentId: g.parentId, start: iso(g.startAt), due: iso(g.dueAt), health: g.health, suggestedHealth: null, archived: g.archived,
      progress: 0, keyResults: krs.filter((k) => k.goalId === g.id).map((k) => presentKr(k, counts.get(k.id))), children: [],
      createdAt: g.createdAt.toISOString(), updatedAt: g.updatedAt.toISOString(),
    });
  }
  const roots: GoalNode[] = [];
  for (const n of nodes.values()) { const p = n.parentId ? nodes.get(n.parentId) : undefined; if (p && p.id !== n.id) p.children.push(n); else roots.push(n); }
  const seen = new Set<string>();
  const roll = (n: GoalNode): number => {
    if (seen.has(n.id)) return n.progress / 100;
    seen.add(n.id);
    const parts = [...n.keyResults.map((k) => k.progress / 100), ...n.children.map(roll)];
    const p = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
    n.progress = Math.round(p * 100);
    const g = rows.find((r) => r.id === n.id)!;
    n.suggestedHealth = suggestHealth(p, expectedProgress(g.startAt ?? g.createdAt, g.dueAt, now));
    return p;
  };
  roots.forEach(roll);
  const flat = [...nodes.values()];
  const health = { on_track: 0, at_risk: 0, off_track: 0, not_set: 0 };
  for (const r of roots) { const h = r.health ?? r.suggestedHealth; if (h) health[h]++; else health.not_set++; }
  return {
    goals: roots,
    summary: { goals: flat.length, topLevel: roots.length, keyResults: krs.length, progress: roots.length ? Math.round(roots.reduce((a, r) => a + r.progress, 0) / roots.length) : 0, health },
  };
}

async function goalRow(deps: Deps, orgId: string, id: string) {
  const g = await deps.db.select().from(goals).where(and(eq(goals.orgId, orgId), eq(goals.id, id), isNull(goals.deletedAt))).get();
  if (!g) throw notFound();
  return g;
}

export async function getGoal(deps: Deps, orgId: string, id: string) {
  await goalRow(deps, orgId, id);
  const { goals: roots } = await goalTree(deps, orgId, { includeArchived: true });
  const find = (list: GoalNode[]): GoalNode | undefined => { for (const n of list) { if (n.id === id) return n; const f = find(n.children); if (f) return f; } return undefined; };
  const g = find(roots);
  if (!g) throw notFound();
  return g;
}

async function checkOwner(deps: Deps, orgId: string, ownerId: string | null | undefined) {
  if (!ownerId) return;
  const m = await deps.db.select({ id: members.id }).from(members).where(and(eq(members.organizationId, orgId), eq(members.userId, ownerId))).get();
  if (!m) throw new HttpError(422, "validation_failed", "The owner must be a member of this workspace.");
}

async function checkParent(deps: Deps, orgId: string, id: string | null, parentId: string | null | undefined) {
  if (!parentId) return;
  if (parentId === id) throw new HttpError(422, "validation_failed", "A goal can't sit under itself.");
  let cur: GoalRow | undefined = await goalRow(deps, orgId, parentId);
  for (let i = 0; cur && i < 50; i++) {
    if (cur.id === id) throw new HttpError(422, "validation_failed", "That would put a goal under its own child.");
    cur = cur.parentId ? await deps.db.select().from(goals).where(eq(goals.id, cur.parentId)).get() : undefined;
  }
}

export interface GoalInput { name?: string; description?: string; ownerId?: string | null; parentId?: string | null; start?: string | null; due?: string | null; health?: Health | null; archived?: boolean }

export async function createGoal(deps: Deps, a: SuiteActor, input: GoalInput & { name: string; keyResults?: KrInput[] }) {
  assertWritable(a);
  const name = input.name.trim();
  if (!name) throw new HttpError(422, "validation_failed", "Give the goal a name.");
  await checkOwner(deps, a.orgId, input.ownerId);
  await checkParent(deps, a.orgId, null, input.parentId);
  const now = deps.now();
  const id = sortableId("gol", now.getTime());
  await deps.db.insert(goals).values({
    id, orgId: a.orgId, name: name.slice(0, 200), description: (input.description ?? "").slice(0, 5000), ownerId: input.ownerId ?? (a.agentId ? null : a.userId || null),
    parentId: input.parentId ?? null, startAt: parseDate(input.start), dueAt: parseDate(input.due), health: input.health ?? null, createdAt: now, updatedAt: now, ...createdBy(a),
  });
  for (const k of input.keyResults ?? []) await addKeyResult(deps, a, id, k, { quiet: true });
  const g = await getGoal(deps, a.orgId, id);
  await recordWrite(deps, a, { entityType: "goal", entityId: id, op: "create", verb: "created", data: { name }, event: "goal.created", eventData: { goal: g } });
  return g;
}

export async function updateGoal(deps: Deps, a: SuiteActor, id: string, patch: GoalInput) {
  assertWritable(a);
  const g = await goalRow(deps, a.orgId, id);
  const set: Partial<GoalRow> = { updatedAt: deps.now(), version: g.version + 1 };
  if (patch.name !== undefined) { const n = patch.name.trim(); if (!n) throw new HttpError(422, "validation_failed", "Give the goal a name."); set.name = n.slice(0, 200); }
  if (patch.description !== undefined) set.description = patch.description.slice(0, 5000);
  if (patch.ownerId !== undefined) { await checkOwner(deps, a.orgId, patch.ownerId); set.ownerId = patch.ownerId; }
  if (patch.parentId !== undefined) { await checkParent(deps, a.orgId, g.id, patch.parentId); set.parentId = patch.parentId; }
  if (patch.start !== undefined) set.startAt = parseDate(patch.start);
  if (patch.due !== undefined) set.dueAt = parseDate(patch.due);
  if (patch.health !== undefined) set.health = patch.health;
  if (patch.archived !== undefined) set.archived = patch.archived;
  await deps.db.update(goals).set(set).where(eq(goals.id, g.id));
  return changed(deps, a, g.id, Object.keys(patch));
}

async function changed(deps: Deps, a: SuiteActor, goalId: string, what: string[]) {
  const g = await getGoal(deps, a.orgId, goalId);
  await recordWrite(deps, a, { entityType: "goal", entityId: goalId, op: "update", verb: "updated", data: { changed: what, progress: g.progress }, event: "goal.updated", eventData: { goal: g, changed: what } });
  if (g.owner && g.owner.id !== a.userId) await notify(deps, a.orgId, g.owner.id, { type: "goal.updated", entityType: "goal", entityId: g.id, title: `${g.name} is at ${g.progress}%`, actorName: a.name || a.email });
  return g;
}

export async function deleteGoal(deps: Deps, a: SuiteActor, id: string) {
  assertWritable(a);
  const g = await goalRow(deps, a.orgId, id);
  const now = deps.now();
  await deps.db.update(goals).set({ deletedAt: now, updatedAt: now }).where(eq(goals.id, g.id));
  // Child goals move up to this goal's parent rather than disappearing.
  await deps.db.update(goals).set({ parentId: g.parentId, updatedAt: now }).where(and(eq(goals.orgId, a.orgId), eq(goals.parentId, g.id)));
  await recordWrite(deps, a, { entityType: "goal", entityId: g.id, op: "delete", verb: "deleted", data: { name: g.name }, event: "goal.deleted", eventData: { id: g.id } });
  return { ok: true };
}

export interface KrInput { name?: string; kind?: KrRow["kind"]; start?: number; target?: number; current?: number; unit?: string; projectId?: string | null; taskIds?: string[] }

async function setTaskLinks(deps: Deps, orgId: string, krId: string, taskIds: string[]) {
  await deps.db.delete(entityLinks).where(and(eq(entityLinks.orgId, orgId), eq(entityLinks.fromType, "key_result"), eq(entityLinks.fromId, krId), eq(entityLinks.toType, "task")));
  const ids = [...new Set(await Promise.all(taskIds.slice(0, 500).map((t) => resolveTaskId(deps, orgId, t))))];
  if (ids.length) await deps.db.insert(entityLinks).values(ids.map((t) => ({ orgId, fromType: "key_result", fromId: krId, toType: "task", toId: t, relation: "measures", createdAt: deps.now() }))).onConflictDoNothing();
}

async function checkProject(deps: Deps, orgId: string, projectId: string | null | undefined) {
  if (!projectId) return;
  const { projects } = await import("../../db/schema");
  if (!(await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, projectId))).get())) throw new HttpError(422, "validation_failed", "That project isn't in this workspace.");
}

export async function addKeyResult(deps: Deps, a: SuiteActor, goalId: string, input: KrInput, opts: { quiet?: boolean } = {}) {
  assertWritable(a);
  await goalRow(deps, a.orgId, goalId);
  const name = (input.name ?? "").trim();
  if (!name) throw new HttpError(422, "validation_failed", "Give the key result a name.");
  const kind = input.kind ?? (input.taskIds?.length || input.projectId ? "tasks" : "number");
  if (kind === "tasks" && !input.taskIds?.length && !input.projectId) throw new HttpError(422, "validation_failed", "A tasks key result needs taskIds or a projectId.");
  await checkProject(deps, a.orgId, input.projectId);
  const now = deps.now();
  const id = sortableId("kr", now.getTime());
  // A key result created with a current value and no start counts from that value, so a countdown
  // ("10 open bugs down to 0") starts at 0 percent and rises as the number falls (dogfood F5).
  const start = input.start ?? input.current ?? 0, target = input.target ?? (kind === "percent" ? 100 : 100);
  await deps.db.insert(keyResults).values({ id, orgId: a.orgId, goalId, name: name.slice(0, 200), kind, startValue: start, targetValue: target, currentValue: input.current ?? start, unit: (input.unit ?? "").slice(0, 20), projectId: input.projectId ?? null, position: now.getTime(), createdAt: now, updatedAt: now, ...createdBy(a) });
  if (kind === "tasks" && input.taskIds?.length) await setTaskLinks(deps, a.orgId, id, input.taskIds);
  if (!opts.quiet) await changed(deps, a, goalId, ["keyResults"]);
  return getKeyResult(deps, a.orgId, id);
}

export async function getKeyResult(deps: Deps, orgId: string, id: string) {
  const k = await deps.db.select().from(keyResults).where(and(eq(keyResults.orgId, orgId), eq(keyResults.id, id), isNull(keyResults.deletedAt))).get();
  if (!k) throw notFound("Key result");
  return presentKr(k, (await taskCounts(deps, orgId, [k])).get(k.id));
}

export async function updateKeyResult(deps: Deps, a: SuiteActor, id: string, patch: KrInput) {
  assertWritable(a);
  const k = await deps.db.select().from(keyResults).where(and(eq(keyResults.orgId, a.orgId), eq(keyResults.id, id), isNull(keyResults.deletedAt))).get();
  if (!k) throw notFound("Key result");
  const set: Partial<KrRow> = { updatedAt: deps.now(), version: k.version + 1 };
  if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 200) || k.name;
  if (patch.start !== undefined) set.startValue = patch.start;
  if (patch.target !== undefined) set.targetValue = patch.target;
  if (patch.current !== undefined) set.currentValue = patch.current;
  if (patch.unit !== undefined) set.unit = patch.unit.slice(0, 20);
  if (patch.projectId !== undefined) { await checkProject(deps, a.orgId, patch.projectId); set.projectId = patch.projectId; }
  await deps.db.update(keyResults).set(set).where(eq(keyResults.id, k.id));
  if (patch.taskIds) await setTaskLinks(deps, a.orgId, k.id, patch.taskIds);
  await changed(deps, a, k.goalId, ["keyResult"]);
  return getKeyResult(deps, a.orgId, k.id);
}

export async function deleteKeyResult(deps: Deps, a: SuiteActor, id: string) {
  assertWritable(a);
  const k = await deps.db.select().from(keyResults).where(and(eq(keyResults.orgId, a.orgId), eq(keyResults.id, id), isNull(keyResults.deletedAt))).get();
  if (!k) throw notFound("Key result");
  await deps.db.update(keyResults).set({ deletedAt: deps.now() }).where(eq(keyResults.id, k.id));
  await deps.db.delete(entityLinks).where(and(eq(entityLinks.orgId, a.orgId), eq(entityLinks.fromType, "key_result"), eq(entityLinks.fromId, k.id)));
  await changed(deps, a, k.goalId, ["keyResults"]);
  return { ok: true };
}

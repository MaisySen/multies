/**
 * Import from other work tools (round 20): a file from Trello, Asana, ClickUp, monday, Jira, Linear or
 * Notion becomes tasks in a new or existing project.
 *
 * Write cost, in D1 rows (1 per table row plus 1 per index it touches):
 *   each task          8  (the tasks row, its key, its 5 indexes and the import key index; measured 819 for 100)
 *   each comment       2
 *   each batch of 50   about 4 (task numbers claimed on the project, and the day's import counter)
 *   each import        5  (one summary activity row and one change entry on the project)
 * No per task activity or change rows. A re-run of the same file writes nothing for tasks already in.
 * At most 2,000 tasks per workspace per UTC day; the import stops cleanly at the cap, at the write
 * budget's warn level, or near its time limit, and running it again carries on where it stopped.
 */
import { invalidateStatuses } from "../suite/read-cache";
import { and, eq, max, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { activity, changes, members, projects, projectStatuses, taskComments, tasks, usageCounters, users } from "../../db/schema";
import { runBatch } from "../../db";
import { HttpError } from "../../lib/errors";
import { writeBudget } from "../write-budget";
import { assertWritable, createdBy, actorOf, sortableId, type SuiteActor } from "../suite/common";
import { createProject, DEFAULT_STATUSES, getProject } from "../suite/tasks";
import {
  FIELD_LABELS, ImportFileError, MAP_FIELDS, SOURCE_LABELS, categoryOf, defaultMapping, mapRows, readTable, trelloListOrder, uniqueHeaders,
  type Category, type ImportRow, type Mapping, type Table,
} from "./parse";
import { inIds } from "../../lib/sql-chunks";

export const DAILY_TASK_CAP = 2_000;
export const BATCH_SIZE = 50;
const COUNTER_METRIC = "work_import_tasks";
const COLORS: Record<Category, string> = { todo: "#8a8f98", doing: "#0071E3", done: "#22c55e" };

export interface FileInput { fileName?: string; content: string; mapping?: Mapping }

function load(input: FileInput) {
  let table: Table;
  try { table = readTable(input.content, input.fileName); } catch (e) {
    if (e instanceof ImportFileError) throw new HttpError(422, "unreadable_file", e.message);
    throw e;
  }
  const preset = defaultMapping(table);
  const mapping: Mapping = { ...preset };
  if (input.mapping) {
    for (const f of MAP_FIELDS) {
      if (!(f in input.mapping)) continue;
      const v = input.mapping[f];
      mapping[f] = v && table.headers.includes(v) ? v : null;
    }
  }
  if (!mapping.title) throw new HttpError(422, "validation_failed", "Choose the column that holds the task title.");
  const { rows, skipped } = mapRows(table, mapping);
  return { table, mapping, rows, skipped };
}

/** Status names in the order the file shows them (Trello: the board's list order), each with its group. */
function statusPlan(table: Table, rows: ImportRow[], content: string) {
  const order: string[] = table.source === "trello" ? trelloListOrder(content) : [];
  for (const r of rows) if (r.status && !order.some((o) => o.toLowerCase() === r.status!.toLowerCase())) order.push(r.status);
  const used = new Set(rows.map((r) => r.status?.toLowerCase()).filter(Boolean));
  return order.filter((name) => used.has(name.toLowerCase())).map((name) => {
    const cats = rows.filter((r) => r.status?.toLowerCase() === name.toLowerCase()).map((r) => r.category);
    const one = cats.length && cats.every((c) => c && c === cats[0]) ? cats[0]! : categoryOf(name);
    return { name: name.slice(0, 60), category: one };
  });
}

async function importKey(source: string, scope: string, externalId: string) {
  const bytes = new TextEncoder().encode(`${source}|${scope}|${externalId}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `${source}:${[...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Tasks already brought in from this file, by import key (D1 takes at most 100 bound values a query). */
async function existingByKey(deps: Deps, orgId: string, keys: string[]) {
  const out = new Map<string, { id: string; projectId: string }>();
  for (let i = 0; i < keys.length; i += 90) {
    const part = keys.slice(i, i + 90);
    const rows = await deps.db.select({ id: tasks.id, key: tasks.importKey, projectId: tasks.projectId }).from(tasks)
      .where(and(eq(tasks.orgId, orgId), inIds(tasks.importKey, part)));
    for (const r of rows) out.set(r.key!, { id: r.id, projectId: r.projectId });
  }
  return out;
}

async function people(deps: Deps, orgId: string) {
  const rows = await deps.db.select({ id: users.id, email: users.email, name: users.name }).from(members)
    .innerJoin(users, eq(users.id, members.userId)).where(eq(members.organizationId, orgId));
  const byEmail = new Map(rows.map((r) => [r.email.toLowerCase(), r.id]));
  const byName = new Map<string, string | null>();
  for (const r of rows) { const k = r.name.trim().toLowerCase(); if (k) byName.set(k, byName.has(k) ? null : r.id); }
  return (v: string) => {
    const s = v.trim().toLowerCase();
    const email = /<([^>]+@[^>]+)>/.exec(s)?.[1] ?? (s.includes("@") ? s : null);
    if (email) return byEmail.get(email) ?? null;
    return byName.get(s) ?? null;
  };
}

const dayOf = (d: Date) => `day:${d.toISOString().slice(0, 10)}`;

async function usedToday(deps: Deps, orgId: string) {
  const row = await deps.db.select({ n: usageCounters.count }).from(usageCounters)
    .where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.period, dayOf(deps.now())), eq(usageCounters.metric, COUNTER_METRIC))).get();
  return row?.n ?? 0;
}

function present(r: ImportRow) {
  return {
    title: r.title, status: r.status, group: r.category, assignees: r.assignees, due: r.due?.toISOString().slice(0, 10) ?? null,
    start: r.start?.toISOString().slice(0, 10) ?? null, priority: r.priority, labels: r.labels, parent: r.parent,
    description: r.description.slice(0, 200), comments: r.comments.length,
  };
}

/** Reads the file and answers what would land: the source, the mapping, the first 20 rows and the statuses. Writes nothing. */
export async function previewImport(deps: Deps, actor: SuiteActor, input: FileInput) {
  assertWritable(actor);
  const { table, mapping, rows, skipped } = load(input);
  const match = await people(deps, actor.orgId);
  const unknown = [...new Set(rows.flatMap((r) => r.assignees).filter((a) => !match(a)))];
  const keys = await Promise.all(rows.map((r) => importKey(table.source, table.scope, r.externalId)));
  const already = await existingByKey(deps, actor.orgId, keys);
  const used = await usedToday(deps, actor.orgId);
  return {
    source: table.source, sourceLabel: SOURCE_LABELS[table.source], name: table.name,
    headers: uniqueHeaders(table.headers), fields: MAP_FIELDS.map((f) => ({ id: f, label: FIELD_LABELS[f] })), mapping,
    total: rows.length, skipped, alreadyImported: already.size, subtasks: rows.filter((r) => r.parent).length,
    rows: rows.slice(0, 20).map((r) => {
      // Show the parent by its title when it is a row in the same file (Trello and Jira refer to it by id).
      const parent = r.parent ? rows.find((x) => x.externalId === r.parent)?.title ?? r.parent : null;
      return { ...present(r), parent };
    }),
    statuses: statusPlan(table, rows, input.content),
    unknownAssignees: unknown.slice(0, 50),
    leftToday: Math.max(0, DAILY_TASK_CAP - used),
  };
}

export interface RunInput extends FileInput { projectId?: string | null; projectName?: string | null }
export type StopReason = "daily_cap" | "write_budget" | "time";

/** Brings the file in. Safe to run again: tasks already in are skipped, and a stopped run carries on. */
export async function runImport(deps: Deps, actor: SuiteActor, input: RunInput, opts: { maxMs?: number; batchSize?: number } = {}) {
  assertWritable(actor);
  const started = Date.now();
  const maxMs = opts.maxMs ?? 20_000;
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const { table, rows, skipped } = load(input);
  const label = SOURCE_LABELS[table.source];
  const keys = await Promise.all(rows.map((r) => importKey(table.source, table.scope, r.externalId)));
  const existing = await existingByKey(deps, actor.orgId, keys);

  // Nothing is made (not even the project) when the day's cap or the write budget already says stop.
  const pendingCount = keys.filter((k) => !existing.has(k)).length;
  if (pendingCount) {
    const level = (await writeBudget(deps)).level;
    const early: StopReason | null = level === "warn" || level === "shed" ? "write_budget" : (await usedToday(deps, actor.orgId)) >= DAILY_TASK_CAP ? "daily_cap" : null;
    if (early) {
      if (input.projectId) await getProject(deps, actor.orgId, input.projectId);
      return { projectId: input.projectId ?? null, projectName: null, continued: false, source: table.source, sourceLabel: label, total: rows.length, created: 0, alreadyThere: existing.size, left: pendingCount, skipped, comments: 0, unknownAssignees: 0, stopped: early };
    }
  }

  // Where it goes: the chosen project, or a new one (a re-run of a file into "new project" carries on in the first run's project).
  let projectId = input.projectId ?? null;
  let continued = false;
  if (!projectId) {
    const prior = [...existing.values()][0];
    if (prior) {
      const p = await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, prior.projectId), eq(projects.orgId, actor.orgId), sql`${projects.deletedAt} IS NULL`)).get();
      if (p) { projectId = p.id; continued = true; }
    }
  }
  const plan = statusPlan(table, rows, input.content);
  const fallbackNeeded = (c: Category) => rows.some((r) => r.category === c && (!r.status || plan.find((s) => s.name.toLowerCase() === r.status!.toLowerCase())?.category !== c));
  if (!projectId) {
    const name = (input.projectName?.trim() || table.name || `${label} import`).slice(0, 120);
    let statuses = plan.length ? [...plan] : DEFAULT_STATUSES.map((s) => ({ name: s.name, category: s.category }));
    for (const [c, n] of [["todo", "To do"], ["doing", "In progress"], ["done", "Done"]] as const) {
      if ((fallbackNeeded(c) || (c === "done")) && !statuses.some((s) => s.category === c)) statuses = c === "todo" ? [{ name: n, category: c }, ...statuses] : [...statuses, { name: n, category: c }];
    }
    if (!plan.length && !rows.some((r) => r.category)) statuses = DEFAULT_STATUSES.map((s) => ({ name: s.name, category: s.category }));
    const p = await createProject(deps, actor, { name, statuses: statuses.map((s) => ({ ...s, color: COLORS[s.category] })) });
    projectId = p.id;
  }
  const project = await getProject(deps, actor.orgId, projectId);

  // Statuses the project lacks are added after its own, in the file's order.
  const statuses = [...project.statuses];
  const missing: { name: string; category: Category }[] = plan.filter((s) => !statuses.some((x) => x.name.toLowerCase() === s.name.toLowerCase()));
  for (const c of ["todo", "doing", "done"] as const) {
    if (fallbackNeeded(c) && ![...statuses, ...missing].some((s) => s.category === c)) missing.push({ name: c === "todo" ? "To do" : c === "doing" ? "In progress" : "Done", category: c });
  }
  const todoRows = rows.filter((_, i) => !existing.has(keys[i]));
  if (missing.length && todoRows.length) {
    const now = deps.now();
    let pos = Math.max(-1, ...statuses.map((s) => s.position));
    const add = missing.map((s, i) => ({ id: sortableId("sts", now.getTime() + i), orgId: actor.orgId, projectId: projectId!, name: s.name, category: s.category, color: COLORS[s.category], position: ++pos, ...createdBy(actor), createdAt: now, updatedAt: now }));
    await deps.db.insert(projectStatuses).values(add);
    invalidateStatuses(deps, actor.orgId); // R25 read cache
    statuses.push(...add.map((s) => ({ id: s.id, name: s.name, category: s.category, color: s.color, position: s.position })));
  }
  const statusFor = (r: ImportRow) => {
    const named = r.status ? statuses.find((s) => s.name.toLowerCase() === r.status!.toLowerCase()) : undefined;
    if (named && (!r.category || named.category === r.category)) return named;
    const cat = r.category ?? "todo";
    return statuses.filter((s) => s.category === cat).sort((a, b) => a.position - b.position)[0] ?? statuses[0];
  };

  // Ids for every row up front, so subtasks can point at parents in the same batch or from an earlier run.
  const now = deps.now();
  const idOf = new Map<string, string>();
  const byTitle = new Map<string, string>();
  rows.forEach((r, i) => {
    const id = existing.get(keys[i])?.id ?? sortableId("tsk", now.getTime() + i);
    idOf.set(r.externalId, id);
    if (!byTitle.has(r.title.toLowerCase())) byTitle.set(r.title.toLowerCase(), id);
  });
  const parentOf = (r: ImportRow) => {
    if (!r.parent) return null;
    const p = idOf.get(r.parent) ?? idOf.get(`row:${r.parent.toLowerCase()}`) ?? byTitle.get(r.parent.toLowerCase()) ?? null;
    return p === idOf.get(r.externalId) ? null : p;
  };
  // Parents first, so a run that stops never leaves a subtask pointing at a parent that is not in yet.
  const depth = (r: ImportRow, seen = new Set<string>()): number => {
    if (!r.parent || seen.has(r.externalId)) return 0;
    seen.add(r.externalId);
    const pid = parentOf(r);
    const parent = pid ? rows.find((x) => idOf.get(x.externalId) === pid) : undefined;
    return parent ? 1 + depth(parent, seen) : 0;
  };
  const depthOf = new Map(rows.map((r) => [r.externalId, r.parent ? depth(r) : 0]));
  const pending = rows.map((r, i) => ({ r, key: keys[i] })).filter((x) => !existing.has(x.key))
    .map((x, n) => ({ ...x, n })).sort((a, b) => depthOf.get(a.r.externalId)! - depthOf.get(b.r.externalId)! || a.n - b.n);

  const match = await people(deps, actor.orgId);
  const maxPos = (await deps.db.select({ m: max(tasks.position) }).from(tasks).where(eq(tasks.projectId, projectId)).get())?.m ?? 0;
  const day = dayOf(now);
  let room = Math.max(0, DAILY_TASK_CAP - (await usedToday(deps, actor.orgId)));
  let created = 0, comments = 0, unknownAssignees = 0;
  let stopped: StopReason | null = null;
  const author = `${label} import`;

  for (let i = 0; i < pending.length; i += batchSize) {
    if (room <= 0) { stopped = "daily_cap"; break; }
    const level = (await writeBudget(deps)).level;
    if (level === "warn" || level === "shed") { stopped = "write_budget"; break; }
    if (i > 0 && Date.now() - started > maxMs) { stopped = "time"; break; }
    const part = pending.slice(i, i + Math.min(batchSize, room));
    const claimed = await deps.db.update(projects).set({ nextNumber: sql`${projects.nextNumber} + ${part.length}` }).where(eq(projects.id, projectId)).returning({ n: projects.nextNumber });
    const first = Number(claimed[0].n) - part.length;
    const at = new Date(now.getTime() + i);
    const stmts: PromiseLike<unknown>[] = [];
    part.forEach(({ r, key }, j) => {
      const st = statusFor(r);
      const id = idOf.get(r.externalId)!;
      const known = r.assignees.map((a) => match(a));
      const assignee = known.find(Boolean) ?? null;
      const others = r.assignees.filter((_, k) => !known[k] || known[k] !== assignee);
      if (known.some((k) => !k)) unknownAssignees++;
      const notes = [r.description,
        others.length ? `Assigned in ${label}: ${others.join(", ")}` : "",
        r.parent && !parentOf(r) ? `Parent in ${label}: ${r.parent}` : ""].filter(Boolean).join("\n\n");
      stmts.push(deps.db.insert(tasks).values({
        id, orgId: actor.orgId, projectId: projectId!, number: first + j, statusId: st.id, status: st.category, title: r.title, notes,
        assigneeType: assignee ? "member" : null, assigneeId: assignee, priority: r.priority, startAt: r.start, dueAt: r.due,
        labels: JSON.stringify(r.labels), parentId: parentOf(r), position: maxPos + (created + j + 1) * 1024, completedAt: st.category === "done" ? at : null,
        importKey: key, ...createdBy(actor), createdAt: at, updatedAt: at,
      }).onConflictDoNothing());
      r.comments.forEach((body, k) => {
        stmts.push(deps.db.insert(taskComments).values({ id: sortableId("cmt", at.getTime() + j * 100 + k), orgId: actor.orgId, taskId: id, authorName: author, body, ...createdBy(actor), createdAt: at, updatedAt: at }));
        comments++;
      });
    });
    stmts.push(deps.db.insert(usageCounters).values({ orgId: actor.orgId, period: day, metric: COUNTER_METRIC, count: part.length })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.period, usageCounters.metric], set: { count: sql`${usageCounters.count} + ${part.length}` } }));
    await runBatch(deps.db, stmts);
    created += part.length;
    room -= part.length;
  }
  if (!stopped && created < pending.length) stopped = room <= 0 ? "daily_cap" : "time";

  if (created) {
    // One summary row for the whole import instead of an activity and change row per task.
    const who = actorOf(actor);
    const data = { source: table.source, file: input.fileName ?? null, created, comments, alreadyThere: existing.size, left: pending.length - created, stopped };
    await runBatch(deps.db, [
      deps.db.insert(activity).values({ id: sortableId("act", now.getTime()), orgId: actor.orgId, actorType: who.type, actorId: who.id, actorName: who.name, verb: "tasks.imported", entityType: "project", entityId: projectId, data: JSON.stringify(data), createdAt: now }),
      deps.db.insert(changes).values({ orgId: actor.orgId, entityType: "project", entityId: projectId, op: "update", version: project.version, createdAt: now }),
    ]);
  }
  return {
    projectId, projectName: project.name, continued, source: table.source, sourceLabel: label,
    total: rows.length, created, alreadyThere: existing.size, left: pending.length - created, skipped, comments, unknownAssignees, stopped,
  };
}

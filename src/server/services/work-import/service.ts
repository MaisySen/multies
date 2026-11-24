/**
 * Import from other work tools (round 20): a file from Trello, Asana, ClickUp, monday, Jira, Linear or
 * Notion becomes tasks in a new or existing project.
 *
 * Write cost, in D1 rows (1 per table row plus 1 per index it touches):
 *   each task          9  (the tasks row, its key, its indexes, the import key index and the status counter row)
 *   each subtask       +1 (its parent index entry; R55: no parent count update, the parent's insert carries it)
 *   each comment       3  (R55 on D1: no comment count update on the task, its insert carries the count)
 *   each checklist item 3  (the row, its key and its task index; R55 on D1: no count update, as for comments)
 *   each batch of 50   about 4 (task numbers claimed on the project, and the day's import counter)
 *   each import        5  (one summary activity row and one change entry on the project)
 * No per task activity or change rows. A re-run of the same file writes nothing for tasks already in.
 * At most 2,000 tasks per workspace per UTC day; the import stops cleanly at the cap, at the write
 * budget's warn level, or near its time limit, and running it again carries on where it stopped.
 */
import { invalidateStatuses } from "../suite/read-cache";
import { and, eq, max, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { changes, members, projects, projectStatuses, taskChecklistItems, taskComments, tasks, usageCounters, users } from "../../db/schema";
import { runBatch } from "../../db";
import { HttpError } from "../../lib/errors";
import { writeBudget } from "../write-budget";
import { assertWritable, changeRow, createdBy, actorOf, sortableId, type SuiteActor } from "../suite/common";
import { createProject, DEFAULT_STATUSES, getProject, machineTriage } from "../suite/tasks";
import {
  FIELD_LABELS, ImportFileError, MAP_FIELDS, SOURCE_LABELS, categoryOf, defaultMapping, mapRows, readTable, trelloListOrder, uniqueHeaders,
  type Category, type ImportRow, type Mapping, type Table,
} from "./parse";
import { inIds } from "../../lib/sql-chunks";
import { claimNumbers } from "../suite/project-counter";
import { machineTriageAlways } from "../suite/triage-settings";

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
    description: r.description.slice(0, 200), comments: r.comments.length, checklist: r.checklist.length,
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

export interface RunInput extends FileInput {
  projectId?: string | null; projectName?: string | null;
  /** R38: a status name in the file (any case) to a status id in the chosen project. Unlisted names are added as new statuses. */
  statusMap?: Record<string, string | null> | null;
  /** R38: a person as the file names them to a member's user id, or "" to leave their tasks unassigned. Unlisted names match by email or name. */
  people?: Record<string, string | null> | null;
}
export type StopReason = "daily_cap" | "write_budget" | "time";

/** Brings the file in. Safe to run again: tasks already in are skipped, and a stopped run carries on. */
export async function runImport(deps: Deps, actor: SuiteActor, input: RunInput, opts: { maxMs?: number; batchSize?: number; project?: { id?: string; retry?: boolean } } = {}) {
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
      return { projectId: input.projectId ?? null, projectName: null, continued: false, source: table.source, sourceLabel: label, total: rows.length, created: 0, alreadyThere: existing.size, left: pendingCount, skipped, comments: 0, checklistItems: 0, unknownAssignees: 0, stopped: early, projectCreated: false, createdTaskIds: [] as string[], createdStatusIds: [] as string[], triage: false };
    }
  }

  // Where it goes: the chosen project, or a new one (a re-run of a file into "new project" carries on in the first run's project).
  let projectId = input.projectId ?? null;
  let continued = false;
  let projectCreated = false;
  if (!projectId) {
    const prior = [...existing.values()][0];
    if (prior) {
      const p = await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, prior.projectId), eq(projects.orgId, actor.orgId), sql`${projects.deletedAt} IS NULL`)).get();
      if (p) { projectId = p.id; continued = true; }
    }
  }
  const mapped = new Map(Object.entries(input.statusMap ?? {}).filter(([, v]) => v).map(([k, v]) => [k.trim().toLowerCase(), v!]));
  const plan = statusPlan(table, rows, input.content);
  const fallbackNeeded = (c: Category) => rows.some((r) => r.category === c && (!r.status || plan.find((s) => s.name.toLowerCase() === r.status!.toLowerCase())?.category !== c));
  if (!projectId) {
    const name = (input.projectName?.trim() || table.name || `${label} import`).slice(0, 120);
    let statuses = plan.length ? [...plan] : DEFAULT_STATUSES.map((s) => ({ name: s.name, category: s.category }));
    for (const [c, n] of [["todo", "To do"], ["doing", "In progress"], ["done", "Done"]] as const) {
      if ((fallbackNeeded(c) || (c === "done")) && !statuses.some((s) => s.category === c)) statuses = c === "todo" ? [{ name: n, category: c }, ...statuses] : [...statuses, { name: n, category: c }];
    }
    if (!plan.length && !rows.some((r) => r.category)) statuses = DEFAULT_STATUSES.map((s) => ({ name: s.name, category: s.category }));
    // R53 (MB-239): under an Idempotency-Key the new project keeps one id, so a retry whose first attempt made the
    // project but no task yet carries on in it instead of making a second, empty one. Tasks, their checklist items
    // and comments go in one batch per part with their import key, so a retry skips every row that already landed.
    const p = await createProject(deps, actor, { name, statuses: statuses.map((s) => ({ ...s, color: COLORS[s.category] })) }, opts.project);
    projectId = p.id;
    projectCreated = true;
  }
  const project = await getProject(deps, actor.orgId, projectId);
  // AIS1 review (row 35): an API key's or a connected AI app's import into a project with Triage on (a new project
  // the import makes starts with it on) waits there for a person, subtasks too, like the key's own tasks. A person's
  // import goes straight to the board. Nothing extra is read or written: the rows carry the flag.
  // Round 2 (PR 24): with "AI and API tasks always wait in Triage" on, it waits in a project with Triage off too (one
  // read of the workspace row, only for a machine's import into such a project).
  const machine = machineTriage(actor);
  const wait = machine && (project.triage || await machineTriageAlways(deps, actor.orgId)) ? machine : null;

  // Statuses the project lacks are added after its own, in the file's order.
  const statuses = [...project.statuses];
  const mappedOk = (name: string) => { const id = mapped.get(name.toLowerCase()); return !!id && statuses.some((x) => x.id === id); };
  const missing: { name: string; category: Category }[] = plan.filter((s) => !mappedOk(s.name) && !statuses.some((x) => x.name.toLowerCase() === s.name.toLowerCase()));
  for (const c of ["todo", "doing", "done"] as const) {
    if (fallbackNeeded(c) && ![...statuses, ...missing].some((s) => s.category === c)) missing.push({ name: c === "todo" ? "To do" : c === "doing" ? "In progress" : "Done", category: c });
  }
  const todoRows = rows.filter((_, i) => !existing.has(keys[i]));
  const createdStatusIds: string[] = [];
  if (missing.length && todoRows.length) {
    const now = deps.now();
    let pos = Math.max(-1, ...statuses.map((s) => s.position));
    const add = missing.map((s, i) => ({ id: sortableId("sts", now.getTime() + i), orgId: actor.orgId, projectId: projectId!, name: s.name, category: s.category, color: COLORS[s.category], position: ++pos, ...createdBy(actor), createdAt: now, updatedAt: now }));
    await deps.db.insert(projectStatuses).values(add);
    invalidateStatuses(deps, actor.orgId); // R25 read cache
    statuses.push(...add.map((s) => ({ id: s.id, name: s.name, category: s.category, color: s.color, position: s.position })));
    createdStatusIds.push(...add.map((s) => s.id));
  }
  const statusFor = (r: ImportRow) => {
    const pick = r.status ? mapped.get(r.status.toLowerCase()) : undefined;
    const chosen = pick ? statuses.find((s) => s.id === pick) : undefined;
    if (chosen) return chosen;
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
  // R55: rows go in families (a top row and every row under it). A family that fits in one batch goes in together,
  // children before their parent, and the parent's insert carries its subtask counts, so the count trigger finds no
  // parent row yet and writes nothing (D1 measured 53 rows for a parent with 4 subtasks parent first, 49 children
  // first). The batch is one transaction, so a run that stops never leaves a subtask pointing at a parent that is not
  // in. A family bigger than a batch keeps the old order, parents first, across batches (the triggers count it).
  const depth = (r: ImportRow, seen = new Set<string>()): number => {
    if (!r.parent || seen.has(r.externalId)) return 0;
    seen.add(r.externalId);
    const pid = parentOf(r);
    const parent = pid ? rows.find((x) => idOf.get(x.externalId) === pid) : undefined;
    return parent ? 1 + depth(parent, seen) : 0;
  };
  const depthOf = new Map(rows.map((r) => [r.externalId, r.parent ? depth(r) : 0]));
  const pendingRows = rows.map((r, i) => ({ r, key: keys[i] })).filter((x) => !existing.has(x.key)).map((x, n) => ({ ...x, n }));
  const pendingById = new Map(pendingRows.map((x) => [idOf.get(x.r.externalId)!, x]));
  const rootOf = (x: (typeof pendingRows)[number]) => {
    let cur = x; const seen = new Set<string>();
    for (;;) {
      const pid = parentOf(cur.r);
      const up = pid ? pendingById.get(pid) : undefined;
      if (!up || seen.has(pid!)) return cur;
      seen.add(pid!); cur = up;
    }
  };
  const familyOf = new Map<string, (typeof pendingRows)>();
  for (const x of pendingRows) {
    const root = idOf.get(rootOf(x).r.externalId)!;
    familyOf.set(root, [...(familyOf.get(root) ?? []), x]);
  }
  // Families in file order of their top row; inside a family, deepest first when it fits a batch, else parents first.
  const families = [...familyOf.values()].sort((a, b) => Math.min(...a.map((x) => x.n)) - Math.min(...b.map((x) => x.n)));
  const byDepth = (dir: 1 | -1) => (a: (typeof pendingRows)[number], b: (typeof pendingRows)[number]) => dir * (depthOf.get(a.r.externalId)! - depthOf.get(b.r.externalId)!) || a.n - b.n;
  const pending = families.flatMap((f) => (f.length > 1 && f.length <= batchSize ? [...f].sort(byDepth(-1)) : [...f].sort(byDepth(1))).map((x) => ({ ...x, family: f.length <= batchSize ? f : null })));
  // Batches end on a family boundary: a family that fits never straddles two batches.
  const parts: (typeof pending)[] = [];
  for (let i = 0; i < pending.length;) {
    let end = Math.min(i + batchSize, pending.length);
    while (end < pending.length && end > i && pending[end].family && pending[end].family === pending[end - 1].family) end--;
    if (end === i) end = Math.min(i + batchSize, pending.length);
    parts.push(pending.slice(i, end));
    i = end;
  }

  const auto = await people(deps, actor.orgId);
  const chosenPeople = new Map(Object.entries(input.people ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v ?? ""]));
  // R38: a person picked in the wizard wins; "" means leave unassigned (kept as a note on the task).
  const match = (a: string) => { const c = chosenPeople.get(a.trim().toLowerCase()); return c !== undefined ? c || null : auto(a); };
  const maxPos = (await deps.db.select({ m: max(tasks.position) }).from(tasks).where(eq(tasks.projectId, projectId)).get())?.m ?? 0;
  const day = dayOf(now);
  let room = Math.max(0, DAILY_TASK_CAP - (await usedToday(deps, actor.orgId)));
  let created = 0, comments = 0, checklistItems = 0, unknownAssignees = 0;
  const byActor = actorOf(actor);
  const by = byActor.id ? `${byActor.type}:${byActor.id}` : byActor.type;
  let stopped: StopReason | null = null;
  const createdTaskIds: string[] = [];
  const waiting: { id: string; title: string }[] = []; // Round 2 (PR 24): for the triage.created events
  const author = `${label} import`;

  // R55: on D1 a batch is one transaction, so comments and checklist items can go in before their task with the
  // foreign key check deferred to the commit, and the task row carries their counts: the count triggers then find no
  // task row and write nothing (staging: 25 rows for a task with 2 comments and 2 checklist items, task first; 21
  // children first). SQLite in Node runs the statements one by one, so there the task stays first.
  const atomic = typeof (deps.db as unknown as { batch?: unknown }).batch === "function";
  let offset = 0;
  for (const whole of parts) {
    const i = offset;
    if (room <= 0) { stopped = "daily_cap"; break; }
    const level = (await writeBudget(deps)).level;
    if (level === "warn" || level === "shed") { stopped = "write_budget"; break; }
    if (i > 0 && Date.now() - started > maxMs) { stopped = "time"; break; }
    // Under the day's cap: whole families only (a flat row is a family of one).
    let take = Math.min(whole.length, room);
    while (take < whole.length && take > 0 && whole[take].family && whole[take].family === whole[take - 1].family) take--;
    // Not even one whole family fits under the cap: take what fits of it, parents first (the triggers count it).
    const part = take > 0 ? whole.slice(0, take)
      : [...whole].filter((x) => x.family === whole[0].family).sort(byDepth(1)).slice(0, room).map((x) => ({ ...x, family: null }));
    offset += part.length;
    // Subtask counts a parent's insert carries: its children in this batch (they go in first) when the family is whole here.
    const kids = new Map<string, { total: number; done: number }>();
    for (const { r, family } of part) {
      const pid = parentOf(r);
      if (!family || !pid || !pendingById.has(pid)) continue;
      const k = kids.get(pid) ?? { total: 0, done: 0 };
      k.total++; if (statusFor(r).category === "done") k.done++;
      kids.set(pid, k);
    }
    const first = await claimNumbers(deps, projectId, part.length); // R33: 1 row on project_counters
    const at = new Date(now.getTime() + i);
    const stmts: PromiseLike<unknown>[] = [];
    if (atomic && part.some(({ r }) => r.checklist.length || r.comments.length)) stmts.push(deps.db.run(sql`PRAGMA defer_foreign_keys = on`));
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
      const sub = kids.get(id);
      const task = deps.db.insert(tasks).values({
        id, orgId: actor.orgId, projectId: projectId!, number: first + j, statusId: st.id, status: st.category, title: r.title, notes,
        assigneeType: assignee ? "member" : null, assigneeId: assignee, priority: r.priority, startAt: r.start, dueAt: r.due,
        labels: JSON.stringify(r.labels), parentId: parentOf(r), position: maxPos + (created + j + 1) * 1024, completedAt: st.category === "done" ? at : null,
        importKey: key, ...createdBy(actor), createdAt: at, updatedAt: at,
        ...(wait ? { triageState: "pending" as const, triageSource: wait.source } : {}),
        ...(sub ? { subtaskTotal: sub.total, subtaskDone: sub.done } : {}),
        ...(atomic ? { commentCount: r.comments.length, checklistTotal: r.checklist.length, checklistDone: r.checklist.filter((c) => c.done).length } : {}),
      }).onConflictDoNothing();
      if (!atomic) stmts.push(task);
      // R49: checklist items land as checklist items on the task (2 rows each: the row and its task index).
      r.checklist.forEach((c, k) => {
        stmts.push(deps.db.insert(taskChecklistItems).values({ id: sortableId("chk", at.getTime() + j * 100 + k), orgId: actor.orgId, taskId: id, title: c.title, done: c.done, position: k + 1, createdBy: by, createdAt: at, updatedAt: at }));
        checklistItems++;
      });
      r.comments.forEach((body, k) => {
        stmts.push(deps.db.insert(taskComments).values({ id: sortableId("cmt", at.getTime() + j * 100 + k), orgId: actor.orgId, taskId: id, authorName: author, body, ...createdBy(actor), createdAt: at, updatedAt: at }));
        comments++;
      });
      if (atomic) stmts.push(task);
    });
    stmts.push(deps.db.insert(usageCounters).values({ orgId: actor.orgId, period: day, metric: COUNTER_METRIC, count: part.length })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.period, usageCounters.metric], set: { count: sql`${usageCounters.count} + ${part.length}` } }));
    await runBatch(deps.db, stmts);
    createdTaskIds.push(...part.map(({ r }) => idOf.get(r.externalId)!));
    if (wait) waiting.push(...part.map(({ r }) => ({ id: idOf.get(r.externalId)!, title: r.title })));
    created += part.length;
    room -= part.length;
  }
  if (!stopped && created < pending.length) stopped = room <= 0 ? "daily_cap" : "time";

  if (created) {
    // One summary row for the whole import instead of an activity and change row per task.
    const who = actorOf(actor);
    const data = { source: table.source, file: input.fileName ?? null, created, comments, checklistItems, alreadyThere: existing.size, left: pending.length - created, stopped };
    await runBatch(deps.db, [
      // R33: one change row carries the timeline entry (was an activity row plus a change row).
      deps.db.insert(changes).values(changeRow(actor.orgId, who, now, { entityType: "project", entityId: projectId, op: "update", version: project.version, verb: "tasks.imported", data })),
    ]);
  }
  // Round 2 (PR 24): one triage.created per task that waits, all in one write (none when nobody listens), at most
  // EMIT_MANY_MAX a step, marked import: true so a receiver can tell them from tasks made one by one.
  if (wait && waiting.length) {
    const wh = await import("../developer/webhooks");
    const who = actorOf(actor);
    await wh.emitEventMany(deps, actor.orgId, "triage.created", waiting.slice(0, wh.EMIT_MANY_MAX).map((t) => ({
      task: { id: t.id, title: t.title, projectId }, source: wait.source, actor: { type: who.type, id: who.id, name: who.name }, import: true,
    })));
  }
  return {
    projectId, projectName: project.name, continued, source: table.source, sourceLabel: label,
    total: rows.length, created, alreadyThere: existing.size, left: pending.length - created, skipped, comments, checklistItems, unknownAssignees, stopped,
    projectCreated, createdTaskIds, createdStatusIds,
    /** AIS1 review: true when the tasks wait in the project's Triage for a person (a key's or an AI app's import). */
    triage: !!wait,
  };
}

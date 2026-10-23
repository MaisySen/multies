/**
 * Work management: projects with custom statuses, tasks (from email or by hand), subtasks,
 * comments and saved filters. People, workspace keys and agent keys all use these
 * functions, through the app, the REST API and MCP.
 */
import { and, asc, desc, eq, gte, inArray, isNull, like, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { agents, docs, entityLinks, members, messages, projectStatuses, projects, savedViews, taskComments, tasks, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { latestText } from "../agents/parse";
import { assertWritable, createdBy, scopeOf, iso, parseDate, recordWrite, sortableId, timeline, type SuiteActor } from "./common";

export type Category = "todo" | "doing" | "done";
export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];

export const DEFAULT_STATUSES: { name: string; category: Category; color: string }[] = [
  { name: "To do", category: "todo", color: "#8a8f98" },
  { name: "In progress", category: "doing", color: "#3b82f6" },
  { name: "Waiting on reply", category: "doing", color: "#f59e0b" },
  { name: "Done", category: "done", color: "#22c55e" },
];

type TaskRow = typeof tasks.$inferSelect;
type StatusRow = typeof projectStatuses.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

// ---------------------------------------------------------------- projects

function presentStatus(s: StatusRow) {
  return { id: s.id, name: s.name, category: s.category, color: s.color, position: s.position };
}

function presentProject(p: ProjectRow, statuses: StatusRow[], counts?: Record<Category, number>) {
  return {
    id: p.id, name: p.name, description: p.description, key: p.key, color: p.color, archived: !!p.archivedAt,
    statuses: statuses.filter((s) => s.projectId === p.id).sort((a, b) => a.position - b.position).map(presentStatus),
    counts: counts ?? { todo: 0, doing: 0, done: 0 },
    createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(), version: p.version,
  };
}
export type Project = ReturnType<typeof presentProject>;

function keyFrom(name: string) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const k = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "TSK");
  return k.slice(0, 5) || "TSK";
}

export async function listProjects(deps: Deps, orgId: string, opts: { includeArchived?: boolean } = {}) {
  const ps = await deps.db.select().from(projects).where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt), opts.includeArchived ? undefined : isNull(projects.archivedAt))).orderBy(asc(projects.createdAt));
  if (!ps.length) return [];
  const ids = ps.map((p) => p.id);
  const [sts, counts] = await Promise.all([
    deps.db.select().from(projectStatuses).where(and(inArray(projectStatuses.projectId, ids), isNull(projectStatuses.deletedAt))),
    deps.db.select({ projectId: tasks.projectId, status: tasks.status, n: sql<number>`count(*)` }).from(tasks)
      .where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt))).groupBy(tasks.projectId, tasks.status),
  ]);
  const byProject = new Map<string, Record<Category, number>>();
  for (const c of counts) {
    const m = byProject.get(c.projectId) ?? { todo: 0, doing: 0, done: 0 };
    m[c.status] = Number(c.n);
    byProject.set(c.projectId, m);
  }
  return ps.map((p) => presentProject(p, sts, byProject.get(p.id)));
}

async function projectRow(deps: Deps, orgId: string, id: string) {
  const p = await deps.db.select().from(projects).where(and(eq(projects.id, id), eq(projects.orgId, orgId), isNull(projects.deletedAt))).get();
  if (!p) throw notFound("Project");
  return p;
}

async function statusesOf(deps: Deps, projectId: string) {
  return (await deps.db.select().from(projectStatuses).where(and(eq(projectStatuses.projectId, projectId), isNull(projectStatuses.deletedAt)))).sort((a, b) => a.position - b.position);
}

export async function getProject(deps: Deps, orgId: string, id: string) {
  const p = await projectRow(deps, orgId, id);
  return presentProject(p, await statusesOf(deps, id));
}

export interface StatusInput { id?: string; name: string; category: Category; color?: string }

export async function createProject(deps: Deps, actor: SuiteActor, input: { name: string; description?: string; key?: string; color?: string; statuses?: StatusInput[] }) {
  assertWritable(actor);
  const now = deps.now();
  const id = sortableId("prj", now.getTime());
  const key = (input.key ?? keyFrom(input.name)).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "TSK";
  await deps.db.insert(projects).values({ id, orgId: actor.orgId, name: input.name.trim(), description: input.description ?? "", key, color: input.color ?? "#ff5a36", ...createdBy(actor), createdAt: now, updatedAt: now });
  const list = input.statuses?.length ? input.statuses : DEFAULT_STATUSES;
  if (!list.some((s) => s.category === "done")) throw new HttpError(422, "validation_failed", "Add at least one status in the Done group.");
  await deps.db.insert(projectStatuses).values(list.map((s, i) => ({
    id: sortableId("sts", now.getTime() + i), orgId: actor.orgId, projectId: id, name: s.name.trim(), category: s.category, color: s.color ?? "#8a8f98", position: i, ...createdBy(actor), createdAt: now, updatedAt: now,
  })));
  await recordWrite(deps, actor, { entityType: "project", entityId: id, op: "create", verb: "created", data: { name: input.name }, event: "project.created", eventData: { id, name: input.name } });
  return getProject(deps, actor.orgId, id);
}

/** The workspace's first project, made on first use so "Make task" always has somewhere to go. */
export async function defaultProject(deps: Deps, actor: SuiteActor) {
  const first = await deps.db.select().from(projects).where(and(eq(projects.orgId, actor.orgId), isNull(projects.deletedAt), isNull(projects.archivedAt))).orderBy(asc(projects.createdAt)).get();
  if (first) return first;
  await createProject(deps, actor, { name: "Tasks", key: "TSK", description: "Tasks made from email land here first." });
  return (await deps.db.select().from(projects).where(and(eq(projects.orgId, actor.orgId), isNull(projects.deletedAt))).orderBy(asc(projects.createdAt)).get())!;
}

export async function updateProject(deps: Deps, actor: SuiteActor, id: string, patch: { name?: string; description?: string; color?: string; archived?: boolean; statuses?: StatusInput[] }) {
  assertWritable(actor);
  const p = await projectRow(deps, actor.orgId, id);
  const now = deps.now();
  await deps.db.update(projects).set({
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.archived !== undefined ? { archivedAt: patch.archived ? now : null } : {}),
    updatedAt: now, version: p.version + 1,
  }).where(eq(projects.id, id));
  if (patch.statuses) await replaceStatuses(deps, actor, p, patch.statuses);
  await recordWrite(deps, actor, { entityType: "project", entityId: id, op: "update", version: p.version + 1, verb: "updated", data: { fields: Object.keys(patch) } });
  return getProject(deps, actor.orgId, id);
}

/** Saves the ordered status list. Tasks in a removed status move to the first status of the same group. */
async function replaceStatuses(deps: Deps, actor: SuiteActor, p: ProjectRow, list: StatusInput[]) {
  if (!list.length) throw new HttpError(422, "validation_failed", "A project needs at least one status.");
  if (!list.some((s) => s.category === "done")) throw new HttpError(422, "validation_failed", "Add at least one status in the Done group.");
  const now = deps.now();
  const current = await statusesOf(deps, p.id);
  const keep = new Set(list.map((s) => s.id).filter(Boolean) as string[]);
  const saved: { id: string; category: Category }[] = [];
  for (const [i, s] of list.entries()) {
    const existing = s.id ? current.find((c) => c.id === s.id) : undefined;
    if (existing) {
      await deps.db.update(projectStatuses).set({ name: s.name.trim(), category: s.category, color: s.color ?? existing.color, position: i, updatedAt: now, version: existing.version + 1 }).where(eq(projectStatuses.id, existing.id));
      if (existing.category !== s.category) await deps.db.update(tasks).set({ status: s.category }).where(eq(tasks.statusId, existing.id));
      saved.push({ id: existing.id, category: s.category });
    } else {
      const id = sortableId("sts", now.getTime() + i);
      await deps.db.insert(projectStatuses).values({ id, orgId: p.orgId, projectId: p.id, name: s.name.trim(), category: s.category, color: s.color ?? "#8a8f98", position: i, ...createdBy(actor), createdAt: now, updatedAt: now });
      saved.push({ id, category: s.category });
    }
  }
  for (const gone of current.filter((c) => !keep.has(c.id))) {
    const target = saved.find((s) => s.category === gone.category) ?? saved[0];
    await deps.db.update(tasks).set({ statusId: target.id, status: target.category, updatedAt: now }).where(eq(tasks.statusId, gone.id));
    await deps.db.update(projectStatuses).set({ deletedAt: now, updatedAt: now }).where(eq(projectStatuses.id, gone.id));
  }
}

export async function deleteProject(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const p = await projectRow(deps, actor.orgId, id);
  const now = deps.now();
  await deps.db.update(projects).set({ deletedAt: now, updatedAt: now, version: p.version + 1 }).where(eq(projects.id, id));
  await deps.db.update(tasks).set({ deletedAt: now, updatedAt: now }).where(and(eq(tasks.projectId, id), isNull(tasks.deletedAt)));
  await recordWrite(deps, actor, { entityType: "project", entityId: id, op: "delete", verb: "deleted", data: { name: p.name } });
  return { ok: true };
}

// ---------------------------------------------------------------- tasks

export interface Assignee { type: "member" | "agent"; id: string }

/** Names for assignees and statuses, loaded once per response. */
async function lookups(deps: Deps, orgId: string, rows: TaskRow[]) {
  const statusIds = [...new Set(rows.map((r) => r.statusId))];
  const memberIds = [...new Set(rows.filter((r) => r.assigneeType === "member" && r.assigneeId).map((r) => r.assigneeId!))];
  const agentIds = [...new Set(rows.filter((r) => r.assigneeType === "agent" && r.assigneeId).map((r) => r.assigneeId!))];
  const parentIds = rows.map((r) => r.id);
  const [sts, us, ags, subs, cms, prs] = await Promise.all([
    statusIds.length ? deps.db.select().from(projectStatuses).where(inArray(projectStatuses.id, statusIds)) : [],
    memberIds.length ? deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, memberIds)) : [],
    agentIds.length ? deps.db.select({ id: agents.id, name: agents.name }).from(agents).where(and(inArray(agents.id, agentIds), eq(agents.orgId, orgId))) : [],
    parentIds.length ? deps.db.select({ parentId: tasks.parentId, status: tasks.status, n: sql<number>`count(*)` }).from(tasks)
      .where(and(eq(tasks.orgId, orgId), inArray(tasks.parentId, parentIds.slice(0, 500)), isNull(tasks.deletedAt))).groupBy(tasks.parentId, tasks.status) : [],
    parentIds.length ? deps.db.select({ taskId: taskComments.taskId, n: sql<number>`count(*)` }).from(taskComments)
      .where(and(inArray(taskComments.taskId, parentIds.slice(0, 500)), isNull(taskComments.deletedAt))).groupBy(taskComments.taskId) : [],
    deps.db.select({ id: projects.id, key: projects.key, name: projects.name }).from(projects).where(eq(projects.orgId, orgId)),
  ]);
  const subtasks = new Map<string, { total: number; done: number }>();
  for (const s of subs) {
    const m = subtasks.get(s.parentId!) ?? { total: 0, done: 0 };
    m.total += Number(s.n);
    if (s.status === "done") m.done += Number(s.n);
    subtasks.set(s.parentId!, m);
  }
  return {
    statuses: new Map(sts.map((s) => [s.id, s])),
    members: new Map(us.map((u) => [u.id, u])),
    agents: new Map(ags.map((a) => [a.id, a])),
    subtasks,
    comments: new Map(cms.map((c) => [c.taskId, Number(c.n)])),
    projects: new Map(prs.map((p) => [p.id, p])),
  };
}
type Lookups = Awaited<ReturnType<typeof lookups>>;

function presentTask(t: TaskRow, l: Lookups) {
  const st = l.statuses.get(t.statusId);
  const pr = l.projects.get(t.projectId);
  const assignee = t.assigneeType && t.assigneeId
    ? t.assigneeType === "member"
      ? { type: "member" as const, id: t.assigneeId, name: l.members.get(t.assigneeId)?.name ?? "Former member", email: l.members.get(t.assigneeId)?.email ?? null }
      : { type: "agent" as const, id: t.assigneeId, name: l.agents.get(t.assigneeId)?.name ?? "Removed agent", email: null }
    : null;
  return {
    id: t.id, ref: `${pr?.key ?? "TSK"}-${t.number}`, projectId: t.projectId, number: t.number,
    title: t.title, notes: t.notes,
    statusId: t.statusId, statusName: st?.name ?? "", statusColor: st?.color ?? "#8a8f98", status: t.status,
    assignee, assigneeId: assignee ? `${assignee.type}:${assignee.id}` : null,
    priority: t.priority, labels: JSON.parse(t.labels) as string[],
    start: iso(t.startAt), due: iso(t.dueAt), parentId: t.parentId, position: t.position,
    source: t.threadId || t.messageId ? { threadId: t.threadId, messageId: t.messageId, from: t.sourceFrom ?? "", subject: t.sourceSubject ?? "" } : null,
    subtasks: l.subtasks.get(t.id) ?? { total: 0, done: 0 },
    commentCount: l.comments.get(t.id) ?? 0,
    completedAt: iso(t.completedAt),
    createdBy: { type: t.createdByType, id: t.createdById },
    createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(), version: t.version,
  };
}
export type Task = ReturnType<typeof presentTask>;

export interface TaskFilters {
  projectId?: string; status?: Category; statusId?: string; threadId?: string; assignee?: string; priority?: Priority; label?: string;
  dueBefore?: string; dueAfter?: string; q?: string; parentId?: string | null; includeSubtasks?: boolean; limit?: number;
}

export async function listTasks(deps: Deps, actor: SuiteActor, f: TaskFilters = {}) {
  const conds: (SQL | undefined)[] = [eq(tasks.orgId, actor.orgId), isNull(tasks.deletedAt)];
  if (f.projectId) conds.push(eq(tasks.projectId, f.projectId));
  if (f.status) conds.push(eq(tasks.status, f.status));
  if (f.statusId) conds.push(eq(tasks.statusId, f.statusId));
  if (f.threadId) conds.push(eq(tasks.threadId, f.threadId));
  if (f.priority) conds.push(eq(tasks.priority, f.priority));
  if (f.assignee) {
    if (f.assignee === "none") conds.push(isNull(tasks.assigneeId));
    else {
      const [type, id] = f.assignee === "me" ? (actor.agentId ? ["agent", actor.agentId] : ["member", actor.userId]) : f.assignee.split(":");
      conds.push(and(eq(tasks.assigneeType, type as "member" | "agent"), eq(tasks.assigneeId, id)));
    }
  }
  if (f.label) conds.push(like(tasks.labels, `%${JSON.stringify(f.label).slice(1, -1)}%`));
  if (f.dueBefore) conds.push(lte(tasks.dueAt, parseDate(f.dueBefore)!));
  if (f.dueAfter) conds.push(gte(tasks.dueAt, parseDate(f.dueAfter)!));
  if (f.q) conds.push(or(like(tasks.title, `%${f.q}%`), like(tasks.notes, `%${f.q}%`)));
  if (f.parentId === null) conds.push(isNull(tasks.parentId));
  else if (f.parentId) conds.push(eq(tasks.parentId, f.parentId));
  else if (!f.includeSubtasks && !f.threadId) conds.push(isNull(tasks.parentId));
  const rows = await deps.db.select().from(tasks).where(and(...conds)).orderBy(asc(tasks.position), desc(tasks.createdAt)).limit(Math.min(f.limit ?? 500, 1000));
  const l = await lookups(deps, actor.orgId, rows);
  return rows.map((r) => presentTask(r, l));
}

async function taskRow(deps: Deps, orgId: string, id: string) {
  const t = await deps.db.select().from(tasks).where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), eq(tasks.id, id))).get();
  if (!t) throw notFound("Task");
  return t;
}

/** Accepts a task id or a reference like OPS-12. */
export async function resolveTaskId(deps: Deps, orgId: string, idOrRef: string) {
  const m = idOrRef.match(/^([A-Za-z0-9]{1,6})-(\d+)$/);
  if (!m) return idOrRef;
  const row = await deps.db.select({ id: tasks.id }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.orgId, orgId), eq(projects.key, m[1].toUpperCase()), eq(tasks.number, Number(m[2])), isNull(tasks.deletedAt))).get();
  return row?.id ?? idOrRef;
}

export async function getTask(deps: Deps, actor: SuiteActor, idOrRef: string) {
  const t = await taskRow(deps, actor.orgId, await resolveTaskId(deps, actor.orgId, idOrRef));
  const l = await lookups(deps, actor.orgId, [t]);
  return presentTask(t, l);
}

async function validateAssignee(deps: Deps, orgId: string, a: Assignee | null | undefined) {
  if (!a) return;
  if (a.type === "member") {
    const m = await deps.db.select({ id: members.id }).from(members).where(and(eq(members.organizationId, orgId), eq(members.userId, a.id))).get();
    if (!m) throw new HttpError(422, "invalid_assignee", "That person isn't a member of this workspace.");
  } else {
    const g = await deps.db.select({ id: agents.id }).from(agents).where(and(eq(agents.orgId, orgId), eq(agents.id, a.id))).get();
    if (!g) throw new HttpError(422, "invalid_assignee", "That agent isn't in this workspace.");
  }
}

/** "member:usr_x" or "agent:agt_y" (or an object) to an Assignee. */
export function parseAssignee(v: string | Assignee | null | undefined): Assignee | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string") return v;
  const [type, id] = v.split(":");
  if ((type !== "member" && type !== "agent") || !id) throw new HttpError(422, "invalid_assignee", "Assignee looks like member:<userId> or agent:<agentId>.");
  return { type, id };
}

async function pickStatus(deps: Deps, projectId: string, statusId?: string, category?: Category) {
  const sts = await statusesOf(deps, projectId);
  if (statusId) {
    const s = sts.find((x) => x.id === statusId);
    if (!s) throw new HttpError(422, "invalid_status", "That status isn't in this project.");
    return s;
  }
  return sts.find((x) => x.category === (category ?? "todo")) ?? sts[0];
}

async function bottomPosition(deps: Deps, statusId: string) {
  const r = await deps.db.select({ p: sql<number>`coalesce(max(${tasks.position}), 0)` }).from(tasks).where(and(eq(tasks.statusId, statusId), isNull(tasks.deletedAt))).get();
  return Number(r?.p ?? 0) + 1024;
}

export interface CreateTaskInput {
  title: string; notes?: string; projectId?: string; statusId?: string; status?: Category; assignee?: Assignee | null;
  priority?: Priority; start?: string | null; due?: string | null; labels?: string[]; parentId?: string | null;
  source?: { messageId?: string; threadId?: string } | null;
}

const cleanSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|aw)\s*:\s*)+/i, "").trim();

export async function createTask(deps: Deps, actor: SuiteActor, input: CreateTaskInput) {
  assertWritable(actor);
  const title = input.title.trim();
  if (!title) throw new HttpError(422, "validation_failed", "Give the task a title.");
  let projectId = input.projectId;
  if (input.parentId && !projectId) projectId = (await taskRow(deps, actor.orgId, input.parentId)).projectId;
  const project = projectId ? await projectRow(deps, actor.orgId, projectId) : await defaultProject(deps, actor);
  if (input.parentId) await taskRow(deps, actor.orgId, input.parentId);
  const status = await pickStatus(deps, project.id, input.statusId, input.status);
  await validateAssignee(deps, actor.orgId, input.assignee);

  let source: { threadId: string | null; messageId: string | null; from: string | null; subject: string | null } = { threadId: null, messageId: null, from: null, subject: null };
  if (input.source?.messageId || input.source?.threadId) {
    const scope = await scopeOf(deps, actor);
    const m = await deps.db.select().from(messages).where(and(
      eq(messages.orgId, actor.orgId),
      input.source.messageId ? eq(messages.id, input.source.messageId) : eq(messages.threadId, input.source.threadId!),
    )).orderBy(desc(messages.date)).get();
    if (!m || (scope && !scope.includes(m.mailboxId))) throw notFound("Message");
    source = { threadId: m.threadId, messageId: m.id, from: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress, subject: m.subject };
  }

  const now = deps.now();
  // Claim the next number in the project. The unique index on (project, number) guards races.
  const claimed = await deps.db.update(projects).set({ nextNumber: sql`${projects.nextNumber} + 1` }).where(eq(projects.id, project.id)).returning({ n: projects.nextNumber });
  const number = Number(claimed[0]?.n ?? project.nextNumber + 1) - 1;
  const id = sortableId("tsk", now.getTime());
  const row = {
    id, orgId: actor.orgId, projectId: project.id, number, statusId: status.id, status: status.category,
    title, notes: input.notes ?? "", assigneeType: input.assignee?.type ?? null, assigneeId: input.assignee?.id ?? null,
    priority: input.priority ?? "none", startAt: parseDate(input.start), dueAt: parseDate(input.due), labels: JSON.stringify(normaliseLabels(input.labels)),
    parentId: input.parentId ?? null, position: await bottomPosition(deps, status.id),
    threadId: source.threadId, messageId: source.messageId, sourceFrom: source.from, sourceSubject: source.subject,
    completedAt: status.category === "done" ? now : null, ...createdBy(actor), createdAt: now, updatedAt: now,
  };
  await deps.db.insert(tasks).values(row);
  if (source.messageId) {
    const m = await deps.db.select({ fromAddress: messages.fromAddress }).from(messages).where(eq(messages.id, source.messageId)).get();
    if (m) {
      const { contactIdFor } = await import("./contacts");
      const contactId = await contactIdFor(deps, actor.orgId, m.fromAddress);
      if (contactId) await link(deps, actor.orgId, { type: "task", id }, { type: "contact", id: contactId }, "about");
    }
  }
  const task = await getTask(deps, actor, id);
  await recordWrite(deps, actor, {
    entityType: "task", entityId: id, op: "create", verb: source.threadId ? "created_from_email" : "created",
    data: { title, ref: task.ref, ...(source.subject ? { subject: source.subject } : {}) }, event: "task.created", eventData: { task },
  });
  if (task.assignee?.type === "member" && task.assignee.id !== actor.userId) {
    const { notify } = await import("./notify");
    await notify(deps, actor.orgId, task.assignee.id, { type: "task.assigned", entityType: "task", entityId: id, title: `${task.ref} assigned to you: ${title}` });
  }
  return task;
}

/** One click from an email: the task takes the thread's subject and links back to it. */
export async function createTaskFromThread(deps: Deps, actor: SuiteActor, input: { messageId?: string; threadId?: string } & Partial<Omit<CreateTaskInput, "source">>) {
  const m = await deps.db.select().from(messages).where(and(eq(messages.orgId, actor.orgId), input.messageId ? eq(messages.id, input.messageId) : eq(messages.threadId, input.threadId ?? "-")))
    .orderBy(desc(messages.date)).get();
  if (!m) throw notFound("Message");
  const fromLine = m.fromName || m.fromAddress;
  const title = input.title?.trim() || cleanSubject(m.subject) || `Follow up with ${fromLine}`;
  const notes = input.notes ?? latestText(m.text).slice(0, 2000);
  return createTask(deps, actor, { ...input, title, notes, source: { messageId: m.id, threadId: m.threadId } });
}

const normaliseLabels = (l?: string[]) => [...new Set((l ?? []).map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 40)))].slice(0, 20);

export interface UpdateTaskInput {
  title?: string; notes?: string; projectId?: string; statusId?: string; status?: Category; assignee?: Assignee | null; priority?: Priority;
  start?: string | null; due?: string | null; labels?: string[]; parentId?: string | null; position?: number; version?: number;
}

export async function updateTask(deps: Deps, actor: SuiteActor, idOrRef: string, patch: UpdateTaskInput) {
  assertWritable(actor);
  const t = await taskRow(deps, actor.orgId, await resolveTaskId(deps, actor.orgId, idOrRef));
  if (patch.version !== undefined && patch.version !== t.version) throw new HttpError(409, "version_conflict", "Someone else changed this task. Reload and try again.");
  const now = deps.now();
  const set: Partial<typeof tasks.$inferInsert> = { updatedAt: now, version: t.version + 1 };
  const changed: Record<string, unknown> = {};
  if (patch.title !== undefined) { set.title = patch.title.trim() || t.title; changed.title = set.title; }
  if (patch.notes !== undefined) { set.notes = patch.notes; changed.notes = true; }
  if (patch.priority !== undefined) { set.priority = patch.priority; changed.priority = patch.priority; }
  if (patch.labels !== undefined) { set.labels = JSON.stringify(normaliseLabels(patch.labels)); changed.labels = normaliseLabels(patch.labels); }
  if (patch.start !== undefined) { set.startAt = parseDate(patch.start); changed.start = patch.start; }
  if (patch.due !== undefined) { set.dueAt = parseDate(patch.due); set.reminderSentFor = null; changed.due = patch.due; }
  if (patch.parentId !== undefined) {
    if (patch.parentId === t.id) throw new HttpError(422, "validation_failed", "A task can't be its own parent.");
    if (patch.parentId) await taskRow(deps, actor.orgId, patch.parentId);
    set.parentId = patch.parentId;
  }
  if (patch.assignee !== undefined) {
    await validateAssignee(deps, actor.orgId, patch.assignee);
    set.assigneeType = patch.assignee?.type ?? null; set.assigneeId = patch.assignee?.id ?? null;
    changed.assignee = patch.assignee ? `${patch.assignee.type}:${patch.assignee.id}` : null;
  }
  let projectId = t.projectId;
  if (patch.projectId && patch.projectId !== t.projectId) {
    const p = await projectRow(deps, actor.orgId, patch.projectId);
    const claimed = await deps.db.update(projects).set({ nextNumber: sql`${projects.nextNumber} + 1` }).where(eq(projects.id, p.id)).returning({ n: projects.nextNumber });
    set.projectId = p.id; set.number = Number(claimed[0]?.n ?? p.nextNumber + 1) - 1; projectId = p.id;
    changed.projectId = p.id;
  }
  let fromCategory: Category | null = null;
  if (patch.statusId !== undefined || patch.status !== undefined || set.projectId) {
    const s = await pickStatus(deps, projectId, set.projectId && !patch.statusId ? undefined : patch.statusId, patch.status ?? (set.projectId ? t.status : undefined));
    if (s.id !== t.statusId) {
      set.statusId = s.id; set.status = s.category;
      fromCategory = t.status;
      set.completedAt = s.category === "done" ? (t.completedAt ?? now) : null;
      changed.status = { from: t.statusId, to: s.id, name: s.name, category: s.category };
      if (patch.position === undefined) set.position = await bottomPosition(deps, s.id);
    }
  }
  if (patch.position !== undefined) set.position = patch.position;
  await deps.db.update(tasks).set(set).where(eq(tasks.id, t.id));
  const task = await getTask(deps, actor, t.id);
  const statusChanged = !!changed.status;
  const verb = statusChanged ? "moved" : changed.assignee !== undefined ? "assigned" : "updated";
  if (Object.keys(changed).length || patch.position !== undefined) {
    await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "update", version: task.version, verb, data: changed, event: "task.updated", eventData: { task, changed: Object.keys(changed) } });
  }
  if (changed.assignee && task.assignee?.type === "member" && task.assignee.id !== actor.userId) {
    const { notify } = await import("./notify");
    await notify(deps, actor.orgId, task.assignee.id, { type: "task.assigned", entityType: "task", entityId: t.id, title: `${task.ref} assigned to you: ${task.title}` });
  }
  if (statusChanged) {
    const { runStatusAutomations } = await import("./automations");
    await runStatusAutomations(deps, actor.orgId, task, fromCategory);
  }
  return task;
}

export async function deleteTask(deps: Deps, actor: SuiteActor, idOrRef: string) {
  assertWritable(actor);
  const t = await taskRow(deps, actor.orgId, await resolveTaskId(deps, actor.orgId, idOrRef));
  const now = deps.now();
  await deps.db.update(tasks).set({ deletedAt: now, updatedAt: now, version: t.version + 1 }).where(or(eq(tasks.id, t.id), eq(tasks.parentId, t.id)));
  await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "delete", version: t.version + 1, verb: "deleted", data: { title: t.title }, event: "task.deleted", eventData: { id: t.id } });
  return { ok: true };
}

// ---------------------------------------------------------------- comments, thread, detail

export async function addComment(deps: Deps, actor: SuiteActor, idOrRef: string, body: string) {
  assertWritable(actor);
  const t = await taskRow(deps, actor.orgId, await resolveTaskId(deps, actor.orgId, idOrRef));
  const text = body.trim();
  if (!text) throw new HttpError(422, "validation_failed", "Write something first.");
  const now = deps.now();
  const id = sortableId("cmt", now.getTime());
  const by = createdBy(actor);
  await deps.db.insert(taskComments).values({ id, orgId: actor.orgId, taskId: t.id, authorName: actor.name || actor.email, body: text.slice(0, 20_000), ...by, createdAt: now, updatedAt: now });
  await deps.db.update(tasks).set({ updatedAt: now }).where(eq(tasks.id, t.id));
  const comment = { id, taskId: t.id, body: text, author: { type: by.createdByType, id: by.createdById, name: actor.name || actor.email }, createdAt: now.toISOString() };
  await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "update", version: t.version, verb: "commented", data: { commentId: id, excerpt: text.slice(0, 140) }, event: "task.commented", eventData: { taskId: t.id, comment } });
  if (t.assigneeType === "member" && t.assigneeId && t.assigneeId !== actor.userId) {
    const { notify } = await import("./notify");
    await notify(deps, actor.orgId, t.assigneeId, { type: "task.commented", entityType: "task", entityId: t.id, title: `New comment on ${t.title}` });
  }
  return comment;
}

export async function listComments(deps: Deps, orgId: string, taskId: string) {
  const rows = await deps.db.select().from(taskComments).where(and(eq(taskComments.orgId, orgId), eq(taskComments.taskId, taskId), isNull(taskComments.deletedAt))).orderBy(asc(taskComments.createdAt));
  return rows.map((c) => ({ id: c.id, taskId: c.taskId, body: c.body, author: { type: c.createdByType, id: c.createdById, name: c.authorName }, createdAt: c.createdAt.toISOString() }));
}

/** The thread behind a task: every message the viewer can open, newest last, quoted history removed. */
export async function threadForTask(deps: Deps, actor: SuiteActor, threadId: string) {
  const scope = await scopeOf(deps, actor);
  const rows = await deps.db.select({ id: messages.id, mailboxId: messages.mailboxId, folder: messages.folder, fromAddress: messages.fromAddress, fromName: messages.fromName, subject: messages.subject, text: messages.text, date: messages.date, sentByAgentId: messages.sentByAgentId })
    .from(messages).where(and(eq(messages.orgId, actor.orgId), eq(messages.threadId, threadId), ne(messages.folder, "drafts"), scope ? inArray(messages.mailboxId, scope.length ? scope : ["-"]) : undefined))
    .orderBy(asc(messages.date)).limit(200);
  return rows.map((m) => ({
    id: m.id, mailboxId: m.mailboxId, direction: m.folder === "sent" ? "outbound" as const : "inbound" as const,
    from: { address: m.fromAddress, name: m.fromName }, subject: m.subject, date: m.date.toISOString(), latestText: latestText(m.text).slice(0, 4000), byAgent: !!m.sentByAgentId,
  }));
}

export async function taskDetail(deps: Deps, actor: SuiteActor, idOrRef: string) {
  const task = await getTask(deps, actor, idOrRef);
  const [subtasks, comments, thread, history, linkedDocs, linkedContacts] = await Promise.all([
    listTasks(deps, actor, { parentId: task.id }),
    listComments(deps, actor.orgId, task.id),
    task.source?.threadId ? threadForTask(deps, actor, task.source.threadId) : Promise.resolve([]),
    timeline(deps, actor.orgId, "task", task.id, 50),
    linked(deps, actor.orgId, "task", task.id, "doc"),
    linked(deps, actor.orgId, "task", task.id, "contact"),
  ]);
  const [dependencies, time] = await Promise.all([
    dependenciesOf(deps, actor.orgId, task.id),
    import("./time").then(({ taskTime }) => taskTime(deps, actor, task.id)),
  ]);
  const docRows = linkedDocs.length ? await deps.db.select({ id: docs.id, title: docs.title, updatedAt: docs.updatedAt }).from(docs).where(and(inArray(docs.id, linkedDocs), isNull(docs.deletedAt))) : [];
  const { contactsByIds } = await import("./contacts");
  return {
    task, subtasks, comments, thread, activity: history,
    docs: docRows.map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt.toISOString() })),
    contacts: await contactsByIds(deps, actor.orgId, linkedContacts),
    blockedBy: dependencies.blockedBy, blocking: dependencies.blocking,
    time: { totalSeconds: time.totalSeconds, entries: time.entries.slice(0, 50) },
  };
}

// ---------------------------------------------------------------- links

export async function link(deps: Deps, orgId: string, from: { type: string; id: string }, to: { type: string; id: string }, relation = "related") {
  await deps.db.insert(entityLinks).values({ orgId, fromType: from.type, fromId: from.id, toType: to.type, toId: to.id, relation, createdAt: deps.now() }).onConflictDoNothing();
}

export async function unlink(deps: Deps, orgId: string, from: { type: string; id: string }, to: { type: string; id: string }) {
  await deps.db.delete(entityLinks).where(and(eq(entityLinks.orgId, orgId), eq(entityLinks.fromType, from.type), eq(entityLinks.fromId, from.id), eq(entityLinks.toType, to.type), eq(entityLinks.toId, to.id)));
}

/** Ids of `otherType` items linked to (or from) this item. */
export async function linked(deps: Deps, orgId: string, type: string, id: string, otherType: string): Promise<string[]> {
  const [out, inc] = await Promise.all([
    deps.db.select({ id: entityLinks.toId }).from(entityLinks).where(and(eq(entityLinks.orgId, orgId), eq(entityLinks.fromType, type), eq(entityLinks.fromId, id), eq(entityLinks.toType, otherType))),
    deps.db.select({ id: entityLinks.fromId }).from(entityLinks).where(and(eq(entityLinks.orgId, orgId), eq(entityLinks.toType, type), eq(entityLinks.toId, id), eq(entityLinks.fromType, otherType))),
  ]);
  return [...new Set([...out, ...inc].map((r) => r.id))];
}

// ---------------------------------------------------------------- dependencies (blocked by, blocking)

async function tasksByIds(deps: Deps, orgId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await deps.db.select().from(tasks).where(and(eq(tasks.orgId, orgId), inArray(tasks.id, ids.slice(0, 500)), isNull(tasks.deletedAt)));
  const l = await lookups(deps, orgId, rows);
  return rows.map((r) => presentTask(r, l));
}

/** Every "blocks" link in the workspace (or one project): { from: blocker, to: blocked }. */
export async function dependencyLinks(deps: Deps, orgId: string, projectId?: string) {
  const rows = await deps.db.select({ from: entityLinks.fromId, to: entityLinks.toId }).from(entityLinks)
    .where(and(eq(entityLinks.orgId, orgId), eq(entityLinks.fromType, "task"), eq(entityLinks.toType, "task"), eq(entityLinks.relation, "blocks"))).limit(5000);
  if (!projectId || !rows.length) return rows;
  const ids = [...new Set(rows.flatMap((r) => [r.from, r.to]))];
  const inProject = new Set((await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.projectId, projectId), inArray(tasks.id, ids.slice(0, 900))))).map((t) => t.id));
  return rows.filter((r) => inProject.has(r.from) || inProject.has(r.to));
}

export async function dependenciesOf(deps: Deps, orgId: string, taskId: string) {
  const all = await dependencyLinks(deps, orgId);
  const [blockedBy, blocking] = await Promise.all([
    tasksByIds(deps, orgId, all.filter((l) => l.to === taskId).map((l) => l.from)),
    tasksByIds(deps, orgId, all.filter((l) => l.from === taskId).map((l) => l.to)),
  ]);
  return { blockedBy, blocking, blocked: blockedBy.some((t) => t.status !== "done") };
}

/** True when `start` can already reach `target` by following "blocks" links: adding target -> start would loop. */
export function wouldLoop(links: { from: string; to: string }[], blocker: string, blocked: string) {
  if (blocker === blocked) return true;
  const next = new Map<string, string[]>();
  for (const l of links) next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
  const seen = new Set<string>();
  const stack = [blocked];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === blocker) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(next.get(n) ?? []));
  }
  return false;
}

/** `taskId` is blocked by `blockedById` (which is then "blocking" it). */
export async function addDependency(deps: Deps, actor: SuiteActor, taskIdOrRef: string, blockedByIdOrRef: string) {
  assertWritable(actor);
  const blocked = await taskRow(deps, actor.orgId, await resolveTaskId(deps, actor.orgId, taskIdOrRef));
  const blocker = await taskRow(deps, actor.orgId, await resolveTaskId(deps, actor.orgId, blockedByIdOrRef));
  if (wouldLoop(await dependencyLinks(deps, actor.orgId), blocker.id, blocked.id)) throw new HttpError(422, "dependency_loop", "That would make the tasks wait on each other in a loop.");
  await link(deps, actor.orgId, { type: "task", id: blocker.id }, { type: "task", id: blocked.id }, "blocks");
  await recordWrite(deps, actor, { entityType: "task", entityId: blocked.id, op: "update", version: blocked.version, verb: "task.blocked_by", data: { taskId: blocker.id, title: blocker.title },
    event: "task.updated", eventData: { id: blocked.id, change: "dependency_added", blockedBy: blocker.id } });
  return dependenciesOf(deps, actor.orgId, blocked.id);
}

export async function removeDependency(deps: Deps, actor: SuiteActor, taskIdOrRef: string, blockedByIdOrRef: string) {
  assertWritable(actor);
  const blocked = await resolveTaskId(deps, actor.orgId, taskIdOrRef);
  const blocker = await resolveTaskId(deps, actor.orgId, blockedByIdOrRef);
  await taskRow(deps, actor.orgId, blocked);
  await unlink(deps, actor.orgId, { type: "task", id: blocker }, { type: "task", id: blocked });
  await recordWrite(deps, actor, { entityType: "task", entityId: blocked, op: "update", verb: "task.unblocked", data: { taskId: blocker },
    event: "task.updated", eventData: { id: blocked, change: "dependency_removed", blockedBy: blocker } });
  return dependenciesOf(deps, actor.orgId, blocked);
}

// ---------------------------------------------------------------- saved views and people

export async function listViews(deps: Deps, actor: SuiteActor, projectId?: string) {
  const rows = await deps.db.select().from(savedViews).where(and(eq(savedViews.orgId, actor.orgId), isNull(savedViews.deletedAt), projectId ? eq(savedViews.projectId, projectId) : undefined,
    or(isNull(savedViews.userId), eq(savedViews.userId, actor.userId)))).orderBy(asc(savedViews.createdAt));
  return rows.map((v) => ({ id: v.id, projectId: v.projectId, name: v.name, view: v.view, filters: JSON.parse(v.filters) as Record<string, string>, shared: !v.userId }));
}

export async function createView(deps: Deps, actor: SuiteActor, input: { projectId?: string | null; name: string; view: "board" | "list" | "calendar" | "timeline"; filters: Record<string, string>; shared?: boolean }) {
  assertWritable(actor);
  if (input.projectId) await projectRow(deps, actor.orgId, input.projectId);
  const now = deps.now();
  const id = sortableId("viw", now.getTime());
  await deps.db.insert(savedViews).values({ id, orgId: actor.orgId, projectId: input.projectId ?? null, userId: input.shared ? null : actor.userId || null, name: input.name.trim(), view: input.view, filters: JSON.stringify(input.filters), ...createdBy(actor), createdAt: now, updatedAt: now });
  return (await listViews(deps, actor, input.projectId ?? undefined)).find((v) => v.id === id)!;
}

export async function deleteView(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const v = await deps.db.select().from(savedViews).where(and(eq(savedViews.id, id), eq(savedViews.orgId, actor.orgId))).get();
  if (!v) throw notFound("Saved view");
  await deps.db.update(savedViews).set({ deletedAt: deps.now() }).where(eq(savedViews.id, id));
  return { ok: true };
}

/** Everyone a task can go to: members and agents. */
export async function assignees(deps: Deps, orgId: string) {
  const [ms, ags] = await Promise.all([
    deps.db.select({ id: users.id, name: users.name, email: users.email }).from(members).innerJoin(users, eq(users.id, members.userId)).where(eq(members.organizationId, orgId)),
    deps.db.select({ id: agents.id, name: agents.name, status: agents.status }).from(agents).where(eq(agents.orgId, orgId)),
  ]);
  return [
    ...ms.map((m) => ({ id: `member:${m.id}`, type: "member" as const, name: m.name, email: m.email })),
    ...ags.map((a) => ({ id: `agent:${a.id}`, type: "agent" as const, name: a.name, email: null as string | null })),
  ];
}

/** The next task an agent should pick up: assigned to it, not done, most urgent and soonest due first. */
export async function nextTaskFor(deps: Deps, actor: SuiteActor, agentId: string) {
  const rank = sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`;
  const row = await deps.db.select().from(tasks).where(and(eq(tasks.orgId, actor.orgId), isNull(tasks.deletedAt), eq(tasks.assigneeType, "agent"), eq(tasks.assigneeId, agentId), ne(tasks.status, "done")))
    .orderBy(rank, sql`case when ${tasks.dueAt} is null then 1 else 0 end`, asc(tasks.dueAt), asc(tasks.createdAt)).get();
  if (!row) return null;
  return taskDetail(deps, actor, row.id);
}

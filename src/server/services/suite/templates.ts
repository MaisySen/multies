/**
 * Project, task and doc templates, plus the starter gallery (client onboarding, content calendar,
 * sales pipeline, bug tracker, meeting notes, project brief). A template is saved from an
 * existing item or written from scratch. A project template carries statuses, custom fields and tasks
 * with due dates counted in days from the start date; a task template carries one task with
 * its subtasks. Starters live here in code; saved templates live in the templates table.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { customFields, projectStatuses, tasks, templates } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { assertWritable, createdBy, recordWrite, sortableId, type SuiteActor } from "./common";
import { createField } from "./fields";
import { normaliseRule, type RepeatRule } from "./recurrence";
import { createProject, createTask, getProject, resolveTaskId, type Category, type Priority } from "./tasks";
import { emitEvent } from "../developer/webhooks";

export interface TemplateTask {
  title: string; notes?: string; status?: string; priority?: Priority; labels?: string[];
  /** Days after the start date the task is due. */
  dueInDays?: number | null;
  subtasks?: string[];
  repeat?: RepeatRule | null;
}
export interface ProjectTemplateData {
  project: { name: string; description?: string; color?: string; statuses?: { name: string; category: Category; color?: string }[] };
  fields?: { name: string; type: "text" | "number" | "currency" | "date" | "select" | "multiselect" | "person" | "checkbox" | "url"; options?: string[] }[];
  tasks: TemplateTask[];
}
export type TaskTemplateData = TemplateTask;
/** A doc template: a title and a body, either editor JSON (saved from a doc) or plain text. */
export interface DocTemplateData { title: string; text?: string; content?: unknown }
export type TemplateKind = "project" | "task" | "doc";
type TemplateData = ProjectTemplateData | TaskTemplateData | DocTemplateData;

type Starter = { id: string; name: string; description: string; category: string } & ({ kind: "project"; data: ProjectTemplateData } | { kind: "doc"; data: DocTemplateData });

export const STARTERS: Starter[] = [
  {
    id: "starter-client-onboarding", kind: "project", name: "Client onboarding", category: "Clients",
    description: "Welcome a new client: kick-off, access, first delivery and a check-in a month later.",
    data: {
      project: { name: "Client onboarding", color: "#2f9e6e", statuses: [
        { name: "To do", category: "todo", color: "#8a8f98" }, { name: "Waiting on client", category: "doing", color: "#e0a03a" },
        { name: "In progress", category: "doing", color: "#4c8dff" }, { name: "Done", category: "done", color: "#2f9e6e" },
      ] },
      fields: [{ name: "Client", type: "text" }, { name: "Contract value", type: "currency" }, { name: "Signed", type: "checkbox" }],
      tasks: [
        { title: "Send the welcome email and kick-off agenda", dueInDays: 0, priority: "high" },
        { title: "Kick-off call", dueInDays: 2, subtasks: ["Confirm goals and success measures", "Agree contacts on both sides", "Book the next check-in"] },
        { title: "Collect logins, brand files and access", dueInDays: 3, status: "Waiting on client" },
        { title: "Set up the shared project and invite the client as a guest", dueInDays: 3 },
        { title: "First delivery", dueInDays: 14, priority: "high" },
        { title: "30 day check-in", dueInDays: 30, notes: "Ask what is working and what is not. Note any upsell or referral." },
      ],
    },
  },
  {
    id: "starter-content-calendar", kind: "project", name: "Content calendar", category: "Marketing",
    description: "Plan, write, review and publish posts, with a weekly newsletter that repeats.",
    data: {
      project: { name: "Content calendar", color: "#a061e8", statuses: [
        { name: "Ideas", category: "todo", color: "#8a8f98" }, { name: "Writing", category: "doing", color: "#4c8dff" },
        { name: "Review", category: "doing", color: "#e0a03a" }, { name: "Scheduled", category: "doing", color: "#a061e8" }, { name: "Published", category: "done", color: "#2f9e6e" },
      ] },
      fields: [{ name: "Channel", type: "select", options: ["Blog", "Newsletter", "LinkedIn", "Instagram"] }, { name: "Publish date", type: "date" }, { name: "Link", type: "url" }],
      tasks: [
        { title: "Weekly newsletter", dueInDays: 4, status: "Writing", repeat: { freq: "weekly", interval: 1 } },
        { title: "Blog post: answers to the top 5 customer questions", dueInDays: 7, status: "Ideas" },
        { title: "Case study with a happy client", dueInDays: 14, status: "Ideas", subtasks: ["Ask the client", "Interview", "Draft", "Client sign-off"] },
        { title: "Monthly round-up post", dueInDays: 28, status: "Ideas", repeat: { freq: "monthly", interval: 1 } },
      ],
    },
  },
  {
    id: "starter-sales-pipeline", kind: "project", name: "Sales pipeline", category: "Sales",
    description: "Track leads from first contact to won or lost, with deal value in AUD.",
    data: {
      project: { name: "Sales pipeline", color: "#ff5a36", statuses: [
        { name: "New lead", category: "todo", color: "#8a8f98" }, { name: "Contacted", category: "doing", color: "#4c8dff" },
        { name: "Proposal sent", category: "doing", color: "#e0a03a" }, { name: "Won", category: "done", color: "#2f9e6e" }, { name: "Lost", category: "done", color: "#d6455d" },
      ] },
      fields: [{ name: "Deal value", type: "currency" }, { name: "Source", type: "select", options: ["Referral", "Website", "Event", "Cold outreach"] }, { name: "Close date", type: "date" }],
      tasks: [
        { title: "Example lead: Harbour Coffee, website refresh", status: "New lead", dueInDays: 1, notes: "Replace with a real lead, or make one from an email with Make task." },
        { title: "Follow up on open proposals", dueInDays: 5, repeat: { freq: "weekly", interval: 1, weekdays: [1] } },
        { title: "Review the pipeline and update values", dueInDays: 7, repeat: { freq: "weekly", interval: 1, weekdays: [5] } },
      ],
    },
  },
  {
    id: "starter-bug-tracker", kind: "project", name: "Bug tracker", category: "Product",
    description: "Report, triage, fix and verify bugs, with severity and the affected area.",
    data: {
      project: { name: "Bug tracker", color: "#d6455d", statuses: [
        { name: "Reported", category: "todo", color: "#8a8f98" }, { name: "Triaged", category: "todo", color: "#e0a03a" },
        { name: "Fixing", category: "doing", color: "#4c8dff" }, { name: "Ready to verify", category: "doing", color: "#a061e8" }, { name: "Closed", category: "done", color: "#2f9e6e" },
      ] },
      fields: [{ name: "Severity", type: "select", options: ["Critical", "High", "Medium", "Low"] }, { name: "Area", type: "text" }, { name: "Reported by", type: "text" }],
      tasks: [
        { title: "Example: checkout button does nothing on Safari", status: "Reported", priority: "high", subtasks: ["Reproduce", "Find the cause", "Fix and add a test", "Verify on the live site"] },
        { title: "Weekly bug triage", dueInDays: 2, repeat: { freq: "weekly", interval: 1, weekdays: [2] } },
      ],
    },
  },
  {
    id: "starter-meeting-notes", kind: "doc", name: "Meeting notes", category: "Docs",
    description: "Who came, what was decided and who does what next.",
    data: { title: "Meeting notes", text: "# Meeting notes\nDate and time:\nPeople:\n# Agenda\n- \n# Decisions\n- \n# Actions\n- Owner, task, due date" },
  },
  {
    id: "starter-project-brief", kind: "doc", name: "Project brief", category: "Docs",
    description: "One page on the why, the scope, the dates and how you will know it worked.",
    data: { title: "Project brief", text: "# Why\nThe problem and who has it.\n# Scope\n- In:\n- Out:\n# Dates\n- Start:\n- Launch:\n# Success\nHow we will measure it.\n# Team\n- Owner:" },
  },
];

const notFound = () => new HttpError(404, "not_found", "Template not found.");

function summary(t: { id: string; kind: TemplateKind; name: string; description: string; category: string; data: TemplateData }, builtin: boolean) {
  const taskCount = t.kind === "project" ? (t.data as ProjectTemplateData).tasks.length : t.kind === "doc" ? 0 : 1 + ((t.data as TaskTemplateData).subtasks?.length ?? 0);
  return { id: t.id, kind: t.kind, name: t.name, description: t.description, category: t.category, builtin, taskCount };
}

export async function listTemplates(deps: Deps, orgId: string, kind?: TemplateKind) {
  const rows = await deps.db.select().from(templates).where(and(eq(templates.orgId, orgId), isNull(templates.deletedAt), kind ? eq(templates.kind, kind) : undefined)).orderBy(asc(templates.name));
  const custom = rows.map((r) => summary({ ...r, data: JSON.parse(r.data) }, false));
  const starters = STARTERS.filter((s) => !kind || s.kind === kind).map((s) => summary(s, true));
  return [...starters, ...custom];
}

async function load(deps: Deps, orgId: string, id: string) {
  const s = STARTERS.find((x) => x.id === id);
  if (s) return { ...s, builtin: true };
  const r = await deps.db.select().from(templates).where(and(eq(templates.orgId, orgId), eq(templates.id, id), isNull(templates.deletedAt))).get();
  if (!r) throw notFound();
  return { id: r.id, kind: r.kind, name: r.name, description: r.description, category: r.category, data: JSON.parse(r.data) as TemplateData, builtin: false };
}

export async function getTemplate(deps: Deps, orgId: string, id: string) {
  const t = await load(deps, orgId, id);
  return { ...summary(t, t.builtin), data: t.data };
}

const addDays = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));

/** Saves a project (statuses, fields, top level tasks and their subtasks) or one task as a template. */
export interface TemplateSaveInput {
  kind: TemplateKind; fromProjectId?: string; fromTaskId?: string; fromDocId?: string;
  /** Write the template from scratch instead of saving an existing item (checked by scratchData). */
  data?: Record<string, unknown> | TemplateData;
  name?: string; description?: string; category?: string;
}

const badTemplate = (message: string) => new HttpError(422, "validation_failed", message);

/** Checks a template written from scratch and keeps only the fields a template uses. */
export function scratchData(kind: TemplateKind, raw: unknown): TemplateData {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const task = (t: unknown): TemplateTask => {
    const x = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
    const title = text(x.title, 200);
    if (!title) throw badTemplate("Every task in a template needs a title.");
    const priority = ["none", "low", "medium", "high", "urgent"].includes(String(x.priority)) ? x.priority as Priority : undefined;
    const dueInDays = typeof x.dueInDays === "number" && Number.isInteger(x.dueInDays) && x.dueInDays >= 0 && x.dueInDays <= 730 ? x.dueInDays : null;
    return {
      title, notes: text(x.notes, 5000) || undefined, priority, dueInDays, status: text(x.status, 60) || undefined,
      labels: Array.isArray(x.labels) ? x.labels.map((l) => text(l, 40)).filter(Boolean).slice(0, 10) : undefined,
      subtasks: Array.isArray(x.subtasks) ? x.subtasks.map((s) => text(s, 200)).filter(Boolean).slice(0, 50) : undefined,
    };
  };
  if (kind === "doc") {
    const title = text(d.title, 200);
    if (!title) throw badTemplate("A doc template needs a title.");
    return { title, text: text(d.text, 50_000) };
  }
  if (kind === "task") return task(d);
  const p = (d.project && typeof d.project === "object" ? d.project : {}) as Record<string, unknown>;
  const name = text(p.name, 80);
  if (!name) throw badTemplate("A project template needs a project name.");
  const list = Array.isArray(d.tasks) ? d.tasks : [];
  if (list.length > 200) throw badTemplate("A project template holds up to 200 tasks.");
  return { project: { name, description: text(p.description, 1000) || undefined, color: /^#[0-9a-f]{6}$/i.test(String(p.color)) ? String(p.color) : undefined }, tasks: list.map(task) };
}

export async function saveTemplate(deps: Deps, a: SuiteActor, input: TemplateSaveInput) {
  assertWritable(a);
  let data: TemplateData;
  let name = input.name?.trim() || "";
  if (input.data !== undefined) {
    data = scratchData(input.kind, input.data);
    name ||= input.kind === "project" ? (data as ProjectTemplateData).project.name : (data as TaskTemplateData | DocTemplateData).title;
    return insertTemplate(deps, a, input, data, name);
  }
  const subtasksOf = async (taskId: string) => (await deps.db.select({ title: tasks.title }).from(tasks).where(and(eq(tasks.parentId, taskId), isNull(tasks.deletedAt))).orderBy(asc(tasks.position))).map((s) => s.title);
  if (input.kind === "project") {
    if (!input.fromProjectId) throw new HttpError(422, "validation_failed", "Pass fromProjectId, or data to write the template from scratch.");
    const p = await getProject(deps, a.orgId, input.fromProjectId);
    const statuses = await deps.db.select().from(projectStatuses).where(eq(projectStatuses.projectId, p.id)).orderBy(asc(projectStatuses.position));
    const statusName = new Map(statuses.map((s) => [s.id, s.name]));
    const fields = await deps.db.select().from(customFields).where(and(eq(customFields.projectId, p.id), isNull(customFields.deletedAt))).orderBy(asc(customFields.position));
    const top = await deps.db.select().from(tasks).where(and(eq(tasks.projectId, p.id), isNull(tasks.parentId), isNull(tasks.deletedAt))).orderBy(asc(tasks.createdAt)).limit(200);
    const earliest = top.reduce<number | null>((m, t) => (t.dueAt && (m === null || t.dueAt.getTime() < m) ? t.dueAt.getTime() : m), null);
    const out: TemplateTask[] = [];
    for (const t of top) {
      out.push({
        title: t.title, notes: t.notes || undefined, status: statusName.get(t.statusId), priority: t.priority, labels: JSON.parse(t.labels) as string[],
        dueInDays: t.dueAt && earliest !== null ? Math.round((t.dueAt.getTime() - earliest) / 86_400_000) : null,
        subtasks: await subtasksOf(t.id), repeat: t.repeatRule ? JSON.parse(t.repeatRule) as RepeatRule : null,
      });
    }
    data = {
      project: { name: p.name, description: p.description, color: p.color, statuses: statuses.map((s) => ({ name: s.name, category: s.category as Category, color: s.color })) },
      // R24.1: formula and rollup fields need their settings and are left out of templates.
      fields: fields.filter((f) => f.type !== "formula" && f.type !== "rollup").map((f) => ({ name: f.name, type: f.type as NonNullable<ProjectTemplateData["fields"]>[number]["type"], options: f.options ? (JSON.parse(f.options) as { label: string }[]).map((o) => o.label) : undefined })),
      tasks: out,
    };
    name ||= p.name;
  } else if (input.kind === "doc") {
    if (!input.fromDocId) throw new HttpError(422, "validation_failed", "Pass fromDocId, or data to write the template from scratch.");
    const { getDoc } = await import("./docs");
    const doc = await getDoc(deps, a.orgId, input.fromDocId);
    data = { title: doc.title, content: doc.content };
    name ||= doc.title;
  } else {
    if (!input.fromTaskId) throw new HttpError(422, "validation_failed", "Pass fromTaskId.");
    const id = await resolveTaskId(deps, a.orgId, input.fromTaskId);
    const t = await deps.db.select().from(tasks).where(and(eq(tasks.orgId, a.orgId), eq(tasks.id, id))).get();
    if (!t) throw new HttpError(404, "not_found", "Task not found.");
    data = { title: t.title, notes: t.notes || undefined, priority: t.priority, labels: JSON.parse(t.labels) as string[], subtasks: await subtasksOf(t.id), repeat: t.repeatRule ? JSON.parse(t.repeatRule) as RepeatRule : null };
    name ||= t.title;
  }
  return insertTemplate(deps, a, input, data, name);
}

async function insertTemplate(deps: Deps, a: SuiteActor, input: TemplateSaveInput, data: TemplateData, name: string) {
  const now = deps.now();
  const id = sortableId("tpl", now.getTime());
  await deps.db.insert(templates).values({ id, orgId: a.orgId, kind: input.kind, name: name.slice(0, 120), description: (input.description ?? "").slice(0, 500), category: (input.category ?? "Custom").slice(0, 40), data: JSON.stringify(data), createdAt: now, updatedAt: now, ...createdBy(a) });
  await recordWrite(deps, a, { entityType: "template", entityId: id, op: "create", verb: "created", data: { name } });
  return getTemplate(deps, a.orgId, id);
}

export async function deleteTemplate(deps: Deps, a: SuiteActor, id: string) {
  assertWritable(a);
  if (STARTERS.some((s) => s.id === id)) throw new HttpError(422, "validation_failed", "Starter templates can't be deleted.");
  await load(deps, a.orgId, id);
  await deps.db.update(templates).set({ deletedAt: deps.now() }).where(eq(templates.id, id));
  return { ok: true };
}

async function makeTask(deps: Deps, a: SuiteActor, projectId: string, t: TemplateTask, start: Date, statusIds: Map<string, string>, parentId?: string) {
  const task = await createTask(deps, a, {
    title: t.title, notes: t.notes, projectId, parentId,
    statusId: t.status ? statusIds.get(t.status.toLowerCase()) : undefined,
    priority: t.priority, labels: t.labels,
    due: t.dueInDays === undefined || t.dueInDays === null ? null : addDays(start, t.dueInDays).toISOString().slice(0, 10),
    repeat: t.repeat ? normaliseRule(t.repeat) : null,
  });
  for (const s of t.subtasks ?? []) await createTask(deps, a, { title: s, projectId, parentId: task.id });
  return task;
}

/** Makes a project (or a task in a project) from a template. Due dates count from startDate, today by default. */
export async function useTemplate(deps: Deps, a: SuiteActor, id: string, input: { name?: string; projectId?: string; startDate?: string }) {
  assertWritable(a);
  const t = await load(deps, a.orgId, id);
  const now = deps.now();
  const start = input.startDate ? new Date(`${input.startDate}T00:00:00.000Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (Number.isNaN(start.getTime())) throw new HttpError(422, "validation_failed", "startDate must be YYYY-MM-DD.");
  if (t.kind === "project") {
    const d = t.data as ProjectTemplateData;
    const project = await createProject(deps, a, { name: (input.name?.trim() || d.project.name).slice(0, 80), description: d.project.description, color: d.project.color, statuses: d.project.statuses });
    for (const f of d.fields ?? []) await createField(deps, a, project.id, { name: f.name, type: f.type, options: f.options?.map((label) => ({ label })) });
    const statusIds = new Map(project.statuses.map((s) => [s.name.toLowerCase(), s.id]));
    let made = 0;
    for (const task of d.tasks) { await makeTask(deps, a, project.id, task, start, statusIds); made++; }
    const fresh = await getProject(deps, a.orgId, project.id);
    await emitEvent(deps, a.orgId, "template.used", { templateId: t.id, name: t.name, projectId: project.id, tasks: made });
    return { kind: "project" as const, project: fresh, tasks: made };
  }
  if (t.kind === "doc") {
    const d = t.data as DocTemplateData;
    const { createDoc } = await import("./docs");
    const doc = await createDoc(deps, a, { title: (input.name?.trim() || d.title).slice(0, 200), ...(d.content !== undefined ? { content: d.content } : { text: d.text ?? "" }), projectId: input.projectId ?? null });
    await emitEvent(deps, a.orgId, "template.used", { templateId: t.id, name: t.name, docId: doc.id });
    return { kind: "doc" as const, doc };
  }
  if (!input.projectId) throw new HttpError(422, "validation_failed", "Pass projectId for a task template.");
  const project = await getProject(deps, a.orgId, input.projectId);
  const task = await makeTask(deps, a, project.id, { ...(t.data as TaskTemplateData), title: input.name?.trim() || (t.data as TaskTemplateData).title }, start, new Map(project.statuses.map((s) => [s.name.toLowerCase(), s.id])));
  await emitEvent(deps, a.orgId, "template.used", { templateId: t.id, name: t.name, taskId: task.id });
  return { kind: "task" as const, task };
}

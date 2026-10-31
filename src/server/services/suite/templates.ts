/**
 * Project, task and doc templates, plus the starter gallery (client onboarding, content calendar,
 * sales pipeline, bug tracker, sprint, hiring, launch, support desk, meeting notes, project brief). A template is saved from an
 * existing item or written from scratch. A project template carries statuses, custom fields and tasks
 * with due dates counted in days from the start date; a task template carries one task with
 * its subtasks. Starters live here in code; saved templates live in the templates table.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { customFields, docs, projects, projectStatuses, tasks, templates } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { assertWritable, createdBy, recordWrite, sortableId, type SuiteActor } from "./common";
import { createField } from "./fields";
import { normaliseRule, type RepeatRule } from "./recurrence";
import { createProject, createTask, getProject, getTask, resolveTaskId, type Category, type Priority } from "./tasks";
import { emitEvent } from "../developer/webhooks";
import { checklistTitles, copyChecklist } from "./checklists"; // R26 (MB-85)
import { VISUAL_STARTERS } from "../../../shared/docs-visual-templates";

export interface TemplateTask {
  title: string; notes?: string; status?: string; priority?: Priority; labels?: string[];
  /** Days after the start date the task is due. */
  dueInDays?: number | null;
  subtasks?: string[];
  repeat?: RepeatRule | null;
  /** R26 (MB-85): checklist item titles, made unticked when the template is used. */
  checklist?: string[];
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
  // R55 (plan idea 24): four starters for a young team: a sprint, hiring, a launch and a support desk.
  {
    id: "starter-sprint", kind: "project", name: "Two week sprint", category: "Product",
    description: "Plan a two week sprint: a backlog, a daily check, a demo and a short look back.",
    data: {
      project: { name: "Sprint", color: "#4c8dff", statuses: [
        { name: "Backlog", category: "todo", color: "#8a8f98" }, { name: "This sprint", category: "todo", color: "#e0a03a" },
        { name: "In progress", category: "doing", color: "#4c8dff" }, { name: "In review", category: "doing", color: "#a061e8" }, { name: "Done", category: "done", color: "#2f9e6e" },
      ] },
      fields: [{ name: "Estimate", type: "number" }, { name: "Area", type: "select", options: ["Web", "Phone", "Backend", "Design"] }],
      tasks: [
        { title: "Sprint planning: pick the work and agree the goal", dueInDays: 0, priority: "high", status: "This sprint" },
        { title: "Daily check in: done, next, blocked", dueInDays: 1, repeat: { freq: "weekly", interval: 1, weekdays: [1, 2, 3, 4, 5] } },
        { title: "Example: people can reset their password from the phone", status: "Backlog", subtasks: ["Design the screen", "Build it", "Test on a real phone"] },
        { title: "Sprint demo", dueInDays: 13, notes: "Show what shipped, on the live site where you can." },
        { title: "Look back: what to keep, what to change", dueInDays: 13 },
      ],
    },
  },
  {
    id: "starter-hiring", kind: "project", name: "Hiring", category: "People",
    description: "Move candidates from applied to offer, with a clear next step for each person.",
    data: {
      project: { name: "Hiring", color: "#e0a03a", statuses: [
        { name: "Applied", category: "todo", color: "#8a8f98" }, { name: "Phone screen", category: "doing", color: "#4c8dff" },
        { name: "Interview", category: "doing", color: "#a061e8" }, { name: "Offer", category: "doing", color: "#e0a03a" },
        { name: "Hired", category: "done", color: "#2f9e6e" }, { name: "Not this time", category: "done", color: "#d6455d" },
      ] },
      fields: [{ name: "Role", type: "text" }, { name: "Source", type: "select", options: ["Referral", "Job board", "Website", "Network"] }, { name: "CV link", type: "url" }],
      tasks: [
        { title: "Write the role: what they will do in the first 90 days", dueInDays: 0, priority: "high" },
        { title: "Post the role and ask the team for referrals", dueInDays: 2 },
        { title: "Example candidate: Sam Lee, product designer", status: "Applied", notes: "Replace with a real candidate, or make one from an application email with Make task." },
        { title: "Review new applications", dueInDays: 3, repeat: { freq: "weekly", interval: 1, weekdays: [2, 4] } },
        { title: "Send every candidate a reply within a week", dueInDays: 7 },
      ],
    },
  },
  {
    id: "starter-launch", kind: "project", name: "Product launch", category: "Marketing",
    description: "Get a launch out the door: the page, the story, the checks and the follow up.",
    data: {
      project: { name: "Launch", color: "#a061e8", statuses: [
        { name: "To do", category: "todo", color: "#8a8f98" }, { name: "Doing", category: "doing", color: "#4c8dff" },
        { name: "Ready", category: "doing", color: "#e0a03a" }, { name: "Done", category: "done", color: "#2f9e6e" },
      ] },
      fields: [{ name: "Owner team", type: "select", options: ["Product", "Marketing", "Sales", "Support"] }, { name: "Launch day", type: "date" }],
      tasks: [
        { title: "Agree the launch day and who owns it", dueInDays: 0, priority: "high" },
        { title: "Launch page and screenshots", dueInDays: 7, subtasks: ["Write the page", "Take screenshots", "Check it on a phone"] },
        { title: "Announcement email and posts", dueInDays: 10 },
        { title: "Support answers for the top questions", dueInDays: 12 },
        { title: "Launch day checks", dueInDays: 14, priority: "urgent", checklist: ["Site is up", "Sign up works", "Payments work", "Team knows the plan"] },
        { title: "Follow up a week later: numbers and lessons", dueInDays: 21 },
      ],
    },
  },
  {
    id: "starter-support-desk", kind: "project", name: "Support desk", category: "Support",
    description: "Turn customer emails into tasks, answer them on time and fix what keeps coming back.",
    data: {
      project: { name: "Support desk", color: "#2f9e6e", statuses: [
        { name: "New", category: "todo", color: "#8a8f98" }, { name: "Waiting on customer", category: "doing", color: "#e0a03a" },
        { name: "Working on it", category: "doing", color: "#4c8dff" }, { name: "Solved", category: "done", color: "#2f9e6e" },
      ] },
      fields: [{ name: "Customer", type: "text" }, { name: "Kind", type: "select", options: ["Question", "Bug", "Billing", "Request"] }],
      tasks: [
        { title: "Set up a shared support address and add the team", dueInDays: 0, priority: "high", notes: "In Mail, open the support address, then use Make task on any email to land it here." },
        { title: "Example: customer cannot find the invoice", status: "New", notes: "Replace with a real request, or make one from an email with Make task." },
        { title: "Write saved replies for the five most common questions", dueInDays: 3 },
        { title: "Weekly look at repeat questions and bugs", dueInDays: 7, repeat: { freq: "weekly", interval: 1, weekdays: [5] } },
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
  ...VISUAL_STARTERS, // R89: starter whiteboards and a diagram
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
      ...(Array.isArray(x.checklist) ? { checklist: x.checklist.map((s) => text(s, 500)).filter(Boolean).slice(0, 200) } : {}), // R26 (MB-85)
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

export async function saveTemplate(deps: Deps, a: SuiteActor, input: TemplateSaveInput, opts: { id?: string; retry?: boolean } = {}) {
  assertWritable(a);
  // R54 (MB-239): a retry under the same Idempotency-Key returns the template the first attempt saved (one read, only on a retry).
  if (opts.id && opts.retry && await deps.db.select({ id: templates.id }).from(templates).where(and(eq(templates.orgId, a.orgId), eq(templates.id, opts.id))).get()) return getTemplate(deps, a.orgId, opts.id);
  let data: TemplateData;
  let name = input.name?.trim() || "";
  if (input.data !== undefined) {
    data = scratchData(input.kind, input.data);
    name ||= input.kind === "project" ? (data as ProjectTemplateData).project.name : (data as TaskTemplateData | DocTemplateData).title;
    return insertTemplate(deps, a, input, data, name, opts.id);
  }
  const checklistOf = async (taskId: string) => { const titles = await checklistTitles(deps, taskId); return titles.length ? { checklist: titles } : {}; }; // R26 (MB-85)
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
        ...await checklistOf(t.id), // R26 (MB-85)
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
    data = { title: t.title, notes: t.notes || undefined, priority: t.priority, labels: JSON.parse(t.labels) as string[], subtasks: await subtasksOf(t.id), repeat: t.repeatRule ? JSON.parse(t.repeatRule) as RepeatRule : null, ...await checklistOf(t.id) };
    name ||= t.title;
  }
  return insertTemplate(deps, a, input, data, name, opts.id);
}

async function insertTemplate(deps: Deps, a: SuiteActor, input: TemplateSaveInput, data: TemplateData, name: string, givenId?: string) {
  const now = deps.now();
  const id = givenId ?? sortableId("tpl", now.getTime());
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

async function makeTask(deps: Deps, a: SuiteActor, projectId: string, t: TemplateTask, start: Date, statusIds: Map<string, string>, parentId?: string, id?: string) {
  const task = await createTask(deps, a, {
    title: t.title, notes: t.notes, projectId, parentId,
    statusId: t.status ? statusIds.get(t.status.toLowerCase()) : undefined,
    priority: t.priority, labels: t.labels,
    due: t.dueInDays === undefined || t.dueInDays === null ? null : addDays(start, t.dueInDays).toISOString().slice(0, 10),
    repeat: t.repeat ? normaliseRule(t.repeat) : null,
  }, id ? { id, retry: false } : {});
  for (const s of t.subtasks ?? []) await createTask(deps, a, { title: s, projectId, parentId: task.id });
  if (t.checklist?.length) await copyChecklist(deps, a, t.checklist, task.id); // R26 (MB-85)
  return task;
}

/** Makes a project (or a task in a project) from a template. Due dates count from startDate, today by default. */
/** R54 (MB-239): the ids a template use keeps on a retry, one per kind it can make. */
export interface TemplateUseIds { project?: string; doc?: string; task?: string; retry?: boolean }

export async function useTemplate(deps: Deps, a: SuiteActor, id: string, input: { name?: string; projectId?: string; startDate?: string }, ids: TemplateUseIds = {}) {
  assertWritable(a);
  const t = await load(deps, a.orgId, id);
  // R54 (MB-239): the project, doc or task the template makes takes the stable id of the request's Idempotency-Key.
  // A retry whose first attempt made it answers with what was made, without making its fields, tasks or event again
  // (one read, only on a retry). A first attempt that stopped partway is not completed by the retry.
  const made = ids.retry ? await alreadyMade(deps, a, t.kind, ids) : undefined;
  if (made) return made;
  const now = deps.now();
  const start = input.startDate ? new Date(`${input.startDate}T00:00:00.000Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (Number.isNaN(start.getTime())) throw new HttpError(422, "validation_failed", "startDate must be YYYY-MM-DD.");
  if (t.kind === "project") {
    const d = t.data as ProjectTemplateData;
    const project = await createProject(deps, a, { name: (input.name?.trim() || d.project.name).slice(0, 80), description: d.project.description, color: d.project.color, statuses: d.project.statuses }, ids.project ? { id: ids.project, retry: false } : {});
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
    const doc = await createDoc(deps, a, { title: (input.name?.trim() || d.title).slice(0, 200), ...(d.content !== undefined ? { content: d.content } : { text: d.text ?? "" }), projectId: input.projectId ?? null }, ids.doc ? { id: ids.doc } : {});
    await emitEvent(deps, a.orgId, "template.used", { templateId: t.id, name: t.name, docId: doc.id });
    return { kind: "doc" as const, doc };
  }
  if (!input.projectId) throw new HttpError(422, "validation_failed", "Pass projectId for a task template.");
  const project = await getProject(deps, a.orgId, input.projectId);
  const task = await makeTask(deps, a, project.id, { ...(t.data as TaskTemplateData), title: input.name?.trim() || (t.data as TaskTemplateData).title }, start, new Map(project.statuses.map((s) => [s.name.toLowerCase(), s.id])), undefined, ids.task);
  await emitEvent(deps, a.orgId, "template.used", { templateId: t.id, name: t.name, taskId: task.id });
  return { kind: "task" as const, task };
}

/** R54 (MB-239): on a retry, what the first attempt of this template use already made, answered the same way; else undefined. */
async function alreadyMade(deps: Deps, a: SuiteActor, kind: string, ids: TemplateUseIds) {
  if (kind === "project" && ids.project) {
    if (!await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, a.orgId), eq(projects.id, ids.project))).get()) return undefined;
    const tops = await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, ids.project), isNull(tasks.parentId), isNull(tasks.deletedAt)));
    return { kind: "project" as const, project: await getProject(deps, a.orgId, ids.project), tasks: tops.length };
  }
  if (kind === "doc" && ids.doc) {
    if (!await deps.db.select({ id: docs.id }).from(docs).where(and(eq(docs.orgId, a.orgId), eq(docs.id, ids.doc))).get()) return undefined;
    const { getDoc } = await import("./docs");
    return { kind: "doc" as const, doc: await getDoc(deps, a.orgId, ids.doc) };
  }
  if (kind === "task" && ids.task) {
    if (!await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, a.orgId), eq(tasks.id, ids.task))).get()) return undefined;
    return { kind: "task" as const, task: await getTask(deps, a, ids.task) };
  }
  return undefined;
}

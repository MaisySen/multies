/**
 * The suite in the public API (v1): tasks, projects, docs, contacts, companies, deals and
 * the change feed. Workspace keys and agent keys both work here: tasks are internal work,
 * so agents act on them directly, with their name on every change. Anything an agent
 * sends outside the business still goes through the approval queue (send_email, reply).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import { changesSince, type SuiteActor } from "../services/suite/common";
import {
  addComment, createProject, createTask, createTaskFromThread, deleteProject, deleteTask, getProject, listProjects, listTasksPage, nextTaskFor, parseAssignee, taskDetail, updateProject, updateTask,
} from "../services/suite/tasks";
import { applyTaskQuery, wantsSubtasks } from "../services/suite/task-query"; // R26 (MB-86)
import { appendToDoc, createDoc, deleteDoc, getDoc, listDocs, updateDoc } from "../services/suite/docs";
import { contactDetail, createDeal, listCompanies, listContacts, listDeals, updateContact, updateDeal, upsertContact } from "../services/suite/contacts";
import { assigneeOf } from "./suite";
import { parseFieldFilters } from "../services/suite/fields";
import { unknownTaskParams } from "./suite-schemas";

/** R26 (MB-72): an unknown query parameter is a 400 that names it, so a client never acts on the wrong list. */
function strictTaskParams(query: Record<string, string>, allowed?: string[]) {
  const bad = unknownTaskParams(query, allowed);
  if (bad.length) throw new HttpError(400, "unknown_parameter", `Unknown query parameter${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}.`, { unknown: bad });
}
/**
 * R28: the version a doc write expects, from the body or an If-Match header ("3", W/"3" or 3).
 * A body value and a header that disagree, or a header that is not a version, is a 400.
 */
export function expectedVersion(c: Context<AppEnv>, fromBody: number | undefined): number | undefined {
  const raw = c.req.header("if-match")?.trim();
  if (!raw || raw === "*") return fromBody;
  const m = raw.match(/^(?:W\/)?"?(\d{1,12})"?$/);
  if (!m) throw new HttpError(400, "bad_if_match", "If-Match must be a doc version, like \"3\".");
  const v = Number(m[1]);
  if (fromBody !== undefined && fromBody !== v) throw new HttpError(400, "bad_if_match", "If-Match and ifVersion disagree.");
  return v;
}
const sprintFilter = (v: string | undefined) => (v === undefined ? undefined : v === "none" ? null : v);
import { idempotentCreate, idempotentId } from "../lib/idempotency"; // R40 (MB-201), R52
import {
  CommentCreate, ContactCreate, ContactPatch, DealCreate, DealPatch, DocAppend, DocCreate, DocPatch, ProjectCreate, ProjectPatch, TaskCreate, TaskFromEmail, TaskPatch, TaskQuery,
} from "./suite-schemas";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const errors = { 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 409: err("Version conflict."), 422: err("Validation failed.") } as const;
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const secured = [{ bearerAuth: [] }];
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "tsk_mh1k2j3h4abcdefghij" }) });

const Assignee = z.object({ type: z.enum(["member", "agent"]), id: z.string(), name: z.string(), email: z.string().nullable() }).nullable();
const Task = z.object({
  id: z.string(), ref: z.string().openapi({ example: "OPS-12" }), projectId: z.string(), number: z.number().int(), title: z.string(), notes: z.string(),
  statusId: z.string(), statusName: z.string(), statusColor: z.string(), status: z.enum(["todo", "doing", "done"]),
  assignee: Assignee, assigneeId: z.string().nullable(), priority: z.enum(["none", "low", "medium", "high", "urgent"]), labels: z.array(z.string()),
  type: z.enum(["task", "story", "bug", "epic"]).openapi({ description: "task, story, bug or epic." }),
  start: z.string().nullable(), due: z.string().nullable(), parentId: z.string().nullable(), position: z.number(),
  source: z.object({ threadId: z.string().nullable(), messageId: z.string().nullable(), from: z.string(), subject: z.string() }).nullable(),
  subtasks: z.object({ total: z.number(), done: z.number() }),
  checklist: z.object({ total: z.number().int(), done: z.number().int() }).openapi({ description: "R28: checklist progress inside the task (items, and how many are ticked). 0 and 0 when the task has no checklist.", example: { total: 5, done: 3 } }),
  commentCount: z.number(), completedAt: z.string().nullable(),
  createdBy: z.object({ type: z.string(), id: z.string().nullable() }), createdAt: z.string(), updatedAt: z.string(), version: z.number().int(),
  fields: z.record(z.string(), z.unknown()).openapi({ description: "Custom field values by field id. See Field for the value types." }),
  sprintId: z.string().nullable().optional(), points: z.number().nullable().optional(),
}).openapi("Task");
const Status = z.object({ id: z.string(), name: z.string(), category: z.enum(["todo", "doing", "done"]), color: z.string(), position: z.number() });
const Project = z.object({ id: z.string(), name: z.string(), description: z.string(), key: z.string(), color: z.string(), archived: z.boolean(), statuses: z.array(Status), counts: z.record(z.string(), z.number()), createdAt: z.string(), updatedAt: z.string(), version: z.number() }).openapi("Project");
const Comment = z.object({ id: z.string(), taskId: z.string(), body: z.string(), author: z.object({ type: z.string(), id: z.string().nullable(), name: z.string() }), createdAt: z.string() }).openapi("TaskComment");
const ThreadMessage = z.object({ id: z.string(), mailboxId: z.string(), direction: z.enum(["inbound", "outbound"]), from: z.object({ address: z.string(), name: z.string() }), subject: z.string(), date: z.string(), latestText: z.string(), byAgent: z.boolean() });
const TaskDetail = z.object({ task: Task, subtasks: z.array(Task), comments: z.array(Comment), thread: z.array(ThreadMessage), activity: z.array(z.unknown()), docs: z.array(z.unknown()), contacts: z.array(z.unknown()), customFields: z.array(z.unknown()).optional().openapi({ description: "The project's custom field definitions, in order." }) }).openapi("TaskDetail");
const Doc = z.object({ id: z.string(), title: z.string(), projectId: z.string().nullable(), excerpt: z.string(), content: z.unknown().optional(), text: z.string().optional(), links: z.array(z.object({ type: z.string(), id: z.string() })).optional(), createdAt: z.string(), updatedAt: z.string(), version: z.number() }).passthrough().openapi("Doc");
const Contact = z.object({ id: z.string(), name: z.string(), email: z.string(), phone: z.string().nullable(), title: z.string().nullable(), notes: z.string(), source: z.string(), company: z.object({ id: z.string(), name: z.string(), domain: z.string().nullable() }).nullable(), messageCount: z.number(), firstContactAt: z.string().nullable(), lastContactAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), version: z.number() }).passthrough().openapi("Contact");
const Deal = z.object({ id: z.string(), title: z.string(), stage: z.string(), value: z.number(), currency: z.literal("AUD"), contactId: z.string().nullable(), companyId: z.string().nullable() }).passthrough().openapi("Deal");

const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;

export function registerSuiteRoutes(api: OpenAPIHono<AppEnv>) {
  const tag = (t: string) => [t];

  // ---------------------------------------------------------------- tasks
  // R47: cursor paging (each page at most limit tasks, default 500, at most 1000; next is null on the last page).
  const PAGING = " Paging (R47): every answer carries next, an opaque cursor for the following page, or null on the last page. Send cursor=<next> with the same filters to read on; a page holds at most limit tasks (default 500, at most 1000). Without cursor the first page comes back, as before.";
  const TaskPageQuery = TaskQuery.extend({ cursor: z.string().max(400).optional().openapi({ description: "R47: the next value from the previous page (same filters)." }) });
  const TaskPage = z.object({ tasks: z.array(Task), next: z.string().nullable().openapi({ description: "R47: cursor for the following page; null on the last page." }) });
  api.openapi(createRoute({ method: "get", path: "/tasks", tags: tag("Tasks"), summary: "List tasks", security: secured,
    description: "Filter by project, status group, status, thread, assignee (me, none, member:<id>, agent:<id>), priority, label, due range or text. Subtasks are left out unless parentId or includeSubtasks=true. Filter on custom fields with field.<fieldId>=<value> or field.<fieldId>=<op>:<value>, where op is eq, ne, gt, gte, lt, lte, contains, empty or notempty (for example field.fld_budget=gt:1000). Sort with sort=field:<fieldId> and dir=desc. sprintId=<id> lists one sprint, sprintId=none the backlog. An unknown query parameter answers 400. R26: q takes the task query language, for example q=assignee:me status:doing label:bug due:<7d sprint:current -label:wontfix \"free text\" (keys: assignee, status, label, priority, due, sprint, type, project, created, updated, points, has, is, title). A bad query answers 400 bad_query with details.position, the character where it went wrong." + PAGING,
    request: { query: TaskPageQuery }, responses: { 200: json(TaskPage, "Tasks, one page."), 400: err("Bad task query (R26): the message names the problem and details.position the character."), 401: errors[401] } }),
  async (c) => {
    strictTaskParams(c.req.query(), Object.keys(TaskPageQuery.shape));
    const { cursor, ...q } = c.req.valid("query");
    // ---- R26 (MB-86) task query: q is the query language (plain words still search title and notes); 400 bad_query with position.
    const r26 = q.q ? { q: undefined, queryConds: applyTaskQuery(q.q, { deps: c.var.deps, actor: actor(c) }), includeSubtasks: q.includeSubtasks === "true" || wantsSubtasks(q.q) } : {};
    // ---- end R26 (MB-86)
    const page = await listTasksPage(c.var.deps, actor(c), { ...q, sprintId: sprintFilter(q.sprintId), includeSubtasks: q.includeSubtasks === "true", fieldFilters: parseFieldFilters(c.req.query()), ...r26, cursor, noChangeCursor: true });
    return send(c, { tasks: page.tasks, next: page.next });
  });

  // MB-52: the nested path most REST clients try first; same filters as GET /tasks.
  api.openapi(createRoute({ method: "get", path: "/projects/{id}/tasks", tags: tag("Tasks"), summary: "List a project's tasks", security: secured,
    description: "The same as GET /tasks?projectId={id}, with the same filters and paging." + PAGING,
    request: { params: z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) }), query: TaskPageQuery.omit({ projectId: true }) }, responses: { 200: json(TaskPage, "Tasks, one page."), 401: errors[401] } }),
  async (c) => {
    strictTaskParams(c.req.query(), Object.keys(TaskPageQuery.omit({ projectId: true }).shape));
    const { cursor, ...q } = c.req.valid("query");
    await getProject(c.var.deps, actor(c).orgId, c.req.valid("param").id);
    const page = await listTasksPage(c.var.deps, actor(c), { ...q, sprintId: sprintFilter(q.sprintId), projectId: c.req.valid("param").id, includeSubtasks: q.includeSubtasks === "true", fieldFilters: parseFieldFilters(c.req.query()), cursor, noChangeCursor: true });
    return send(c, { tasks: page.tasks, next: page.next });
  });

  api.openapi(createRoute({ method: "post", path: "/tasks", tags: tag("Tasks"), summary: "Create a task", security: secured,
    description: "Pass source.messageId or source.threadId to link the task to an email thread: replies on the thread then show on the task. When the project uses Triage, the new task waits there (triage.state pending, source api) until someone accepts it.",
    request: body(TaskCreate), responses: { 201: json(z.object({ task: Task }), "The task."), 401: errors[401], 422: errors[422] } }),
  async (c) => { const b = c.req.valid("json"); return send(c, { task: await createTask(c.var.deps, actor(c), { ...b, assignee: assigneeOf(b), triage: { source: "api", when: "if_project" } }, { id: await idempotentId(c.req.raw, "tsk") }) }, 201); }); // R32: waits in Triage when the project uses it

  api.openapi(createRoute({ method: "post", path: "/tasks/from-email", tags: tag("Tasks"), summary: "Make a task from an email", security: secured,
    description: "One call: the title comes from the subject, the notes from the newest text without quoted history, and the task links to the thread.",
    request: body(TaskFromEmail), responses: { 201: json(z.object({ task: Task }), "The task."), 401: errors[401], 404: errors[404], 422: errors[422] } }),
  async (c) => { const b = c.req.valid("json"); return send(c, { task: await createTaskFromThread(c.var.deps, actor(c), { ...b, assignee: parseAssignee(b.assignee) }) }, 201); });

  api.openapi(createRoute({ method: "get", path: "/tasks/next", tags: tag("Tasks"), summary: "The next task for this agent", security: secured,
    description: "For agent keys: the most urgent open task assigned to the agent, with its thread, comments and subtasks. Null when there is nothing to do.",
    request: { query: z.object({ agentId: z.string().optional() }) }, responses: { 200: json(z.object({ next: TaskDetail.nullable() }), "The next task, or null."), 401: errors[401], 422: errors[422] } }),
  async (c) => {
    const a = actor(c);
    const agentId = a.agentId ?? c.req.valid("query").agentId;
    if (!agentId) throw new HttpError(422, "agent_required", "Pass agentId, or call with an agent key.");
    return send(c, { next: await nextTaskFor(c.var.deps, a, agentId) });
  });

  api.openapi(createRoute({ method: "get", path: "/tasks/{id}", tags: tag("Tasks"), summary: "Get a task with its thread, comments and subtasks", security: secured,
    description: "Takes a task id or a reference like OPS-12.", request: { params: Id }, responses: { 200: json(TaskDetail, "The task."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, await taskDetail(c.var.deps, actor(c), c.req.valid("param").id)));

  api.openapi(createRoute({ method: "patch", path: "/tasks/{id}", tags: tag("Tasks"), summary: "Update a task", security: secured,
    description: "Change any field, move it to another status or project, or reorder it with position. Send version to reject the write if the task changed since you read it.",
    request: { params: Id, ...body(TaskPatch) }, responses: { 200: json(z.object({ task: Task }), "The task."), 401: errors[401], 404: errors[404], 409: errors[409], 422: errors[422] } }),
  async (c) => { const b = c.req.valid("json"); return send(c, { task: await updateTask(c.var.deps, actor(c), c.req.valid("param").id, { ...b, assignee: assigneeOf(b) }) }); });

  api.openapi(createRoute({ method: "delete", path: "/tasks/{id}", tags: tag("Tasks"), summary: "Delete a task and its subtasks", security: secured,
    request: { params: Id }, responses: { 200: json(z.object({ ok: z.boolean() }), "Deleted."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, await deleteTask(c.var.deps, actor(c), c.req.valid("param").id)));

  api.openapi(createRoute({ method: "post", path: "/tasks/{id}/comments", tags: tag("Tasks"), summary: "Comment on a task", security: secured,
    request: { params: Id, ...body(CommentCreate) }, responses: { 201: json(z.object({ comment: Comment }), "The comment."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, { comment: await addComment(c.var.deps, actor(c), c.req.valid("param").id, c.req.valid("json").body, await idempotentCreate(c.req.raw, "cmt")) }, 201));

  // ---------------------------------------------------------------- projects
  api.openapi(createRoute({ method: "get", path: "/projects", tags: tag("Projects"), summary: "List projects with their statuses", security: secured,
    responses: { 200: json(z.object({ projects: z.array(Project) }), "Projects."), 401: errors[401] } }),
  async (c) => send(c, { projects: await listProjects(c.var.deps, actor(c).orgId) }));

  api.openapi(createRoute({ method: "post", path: "/projects", tags: tag("Projects"), summary: "Create a project", security: secured,
    description: "Statuses are optional: the default is To do, In progress, In review and Done. Each status belongs to a group (todo, doing, done).",
    request: body(ProjectCreate), responses: { 201: json(z.object({ project: Project }), "The project."), 401: errors[401], 422: errors[422] } }),
  async (c) => send(c, { project: await createProject(c.var.deps, actor(c), c.req.valid("json"), { id: await idempotentId(c.req.raw, "prj") }) }, 201));

  api.openapi(createRoute({ method: "get", path: "/projects/{id}", tags: tag("Projects"), summary: "Get a project", security: secured,
    request: { params: Id }, responses: { 200: json(z.object({ project: Project }), "The project."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, { project: await getProject(c.var.deps, actor(c).orgId, c.req.valid("param").id) }));

  api.openapi(createRoute({ method: "patch", path: "/projects/{id}", tags: tag("Projects"), summary: "Update a project or its statuses", security: secured,
    request: { params: Id, ...body(ProjectPatch) }, responses: { 200: json(z.object({ project: Project }), "The project."), 401: errors[401], 404: errors[404], 409: err("The key is used by another project (key_taken)."), 422: errors[422] } }),
  async (c) => send(c, { project: await updateProject(c.var.deps, actor(c), c.req.valid("param").id, c.req.valid("json")) }));

  // R44: a key could create a project but not remove it. Same rule as the app: admins only, so an agent
  // member's key (role member) is refused; the project and its tasks are soft deleted.
  api.openapi(createRoute({ method: "delete", path: "/projects/{id}", tags: tag("Projects"), summary: "Delete a project and its tasks", security: secured,
    request: { params: Id }, responses: { 200: json(z.object({ ok: z.boolean() }), "Deleted."), 401: errors[401], 403: err("Only an admin's key can delete a project (admin_only)."), 404: errors[404] } }),
  async (c) => {
    if (c.var.auth.role === "member") throw new HttpError(403, "admin_only", "Only an admin can delete a project. Use a workspace key.");
    return send(c, await deleteProject(c.var.deps, actor(c), c.req.valid("param").id));
  });

  // ---------------------------------------------------------------- docs
  api.openapi(createRoute({ method: "get", path: "/docs", tags: tag("Docs"), summary: "List or search docs", security: secured,
    request: { query: z.object({ q: z.string().max(200).optional(), projectId: z.string().optional() }) }, responses: { 200: json(z.object({ docs: z.array(Doc) }), "Docs."), 401: errors[401] } }),
  async (c) => send(c, { docs: await listDocs(c.var.deps, actor(c).orgId, c.req.valid("query")) }));

  api.openapi(createRoute({ method: "post", path: "/docs", tags: tag("Docs"), summary: "Create a doc", security: secured,
    description: "Send Tiptap JSON as content, or plain text as text. links ties it to tasks, projects, threads, contacts or deals.",
    request: body(DocCreate), responses: { 201: json(z.object({ doc: Doc }), "The doc."), 401: errors[401], 422: errors[422] } }),
  async (c) => send(c, { doc: await createDoc(c.var.deps, actor(c), c.req.valid("json"), await idempotentCreate(c.req.raw, "doc")) }, 201));

  api.openapi(createRoute({ method: "get", path: "/docs/{id}", tags: tag("Docs"), summary: "Read a doc", security: secured,
    request: { params: Id }, responses: { 200: json(z.object({ doc: Doc }), "The doc, with content and plain text."), 401: errors[401], 404: errors[404] } }),
  async (c) => {
    const doc = await getDoc(c.var.deps, actor(c).orgId, c.req.valid("param").id);
    c.header("etag", `"${doc.version}"`); // R28: send it back as If-Match on a write
    return send(c, { doc });
  });

  api.openapi(createRoute({ method: "patch", path: "/docs/{id}", tags: tag("Docs"), summary: "Update a doc", security: secured,
    description: "Optimistic version check (R28): send the version you read as ifVersion (or version, or an If-Match header). If the doc changed since, the answer is 409 with details.currentVersion and nothing is written.",
    request: { params: Id, ...body(DocPatch) }, responses: { 200: json(z.object({ doc: Doc }), "The doc."), 401: errors[401], 404: errors[404], 409: errors[409], 422: errors[422] } }),
  async (c) => {
    const { ifVersion, version, ...patch } = c.req.valid("json");
    const doc = await updateDoc(c.var.deps, actor(c), c.req.valid("param").id, { ...patch, version: expectedVersion(c, ifVersion ?? version) });
    c.header("etag", `"${doc.version}"`);
    return send(c, { doc });
  });

  api.openapi(createRoute({ method: "post", path: "/docs/{id}/append", tags: tag("Docs"), summary: "Add to the end of a doc", security: secured,
    description: "Adds markdown (headings, paragraphs, bullet, numbered and task lists, quotes, code, bold, italic, strike, links) or plain text after the doc's existing content, which stays as it is. ifVersion (or an If-Match header) makes it a 409 with details.currentVersion if the doc changed since you read it. A doc can be up to 1 MB (413 past that).",
    request: { params: Id, ...body(DocAppend) }, responses: { 200: json(z.object({ doc: Doc }), "The doc."), 401: errors[401], 403: errors[403], 404: errors[404], 409: errors[409], 413: err("The doc would be over 1 MB."), 422: errors[422] } }),
  async (c) => {
    const b = c.req.valid("json");
    const doc = await appendToDoc(c.var.deps, actor(c), c.req.valid("param").id, b.markdown ?? b.text ?? "", { markdown: b.markdown !== undefined, ifVersion: expectedVersion(c, b.ifVersion) });
    c.header("etag", `"${doc.version}"`);
    return send(c, { doc });
  });

  api.openapi(createRoute({ method: "delete", path: "/docs/{id}", tags: tag("Docs"), summary: "Delete a doc", security: secured,
    request: { params: Id }, responses: { 200: json(z.object({ ok: z.boolean() }), "Deleted."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, await deleteDoc(c.var.deps, actor(c), c.req.valid("param").id)));

  // ---------------------------------------------------------------- contacts
  api.openapi(createRoute({ method: "get", path: "/contacts", tags: tag("Contacts"), summary: "List or search contacts", security: secured,
    description: "Contacts are made from mail automatically: every outside correspondent, with the company from their work domain.",
    request: { query: z.object({ q: z.string().max(200).optional(), companyId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional() }) },
    responses: { 200: json(z.object({ contacts: z.array(Contact), total: z.number() }), "Contacts."), 401: errors[401] } }),
  async (c) => send(c, await listContacts(c.var.deps, actor(c).orgId, c.req.valid("query"))));

  api.openapi(createRoute({ method: "post", path: "/contacts", tags: tag("Contacts"), summary: "Create or update a contact by email", security: secured,
    request: body(ContactCreate), responses: { 200: json(z.object({ contact: Contact }), "The contact."), 401: errors[401], 422: errors[422] } }),
  async (c) => send(c, { contact: await upsertContact(c.var.deps, actor(c), c.req.valid("json")) }));

  api.openapi(createRoute({ method: "get", path: "/contacts/{id}", tags: tag("Contacts"), summary: "A contact with its timeline of threads, tasks and deals", security: secured,
    description: "Takes a contact id or an email address.", request: { params: Id },
    responses: { 200: json(z.object({ contact: Contact, threads: z.array(z.unknown()), tasks: z.array(Task), deals: z.array(Deal), timeline: z.array(z.unknown()), activity: z.array(z.unknown()) }), "The contact."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, await contactDetail(c.var.deps, actor(c), c.req.valid("param").id)));

  api.openapi(createRoute({ method: "patch", path: "/contacts/{id}", tags: tag("Contacts"), summary: "Update a contact", security: secured,
    request: { params: Id, ...body(ContactPatch) }, responses: { 200: json(z.object({ contact: Contact }), "The contact."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, { contact: await updateContact(c.var.deps, actor(c), c.req.valid("param").id, c.req.valid("json")) }));

  api.openapi(createRoute({ method: "get", path: "/companies", tags: tag("Contacts"), summary: "List companies", security: secured,
    request: { query: z.object({ q: z.string().max(200).optional() }) }, responses: { 200: json(z.object({ companies: z.array(z.unknown()) }), "Companies."), 401: errors[401] } }),
  async (c) => send(c, { companies: await listCompanies(c.var.deps, actor(c).orgId, c.req.valid("query")) }));

  api.openapi(createRoute({ method: "get", path: "/deals", tags: tag("Contacts"), summary: "The deals pipeline", security: secured,
    responses: { 200: json(z.object({ stages: z.array(z.unknown()), deals: z.array(Deal) }), "Stages with totals, and deals."), 401: errors[401] } }),
  async (c) => send(c, await listDeals(c.var.deps, actor(c).orgId)));

  api.openapi(createRoute({ method: "post", path: "/deals", tags: tag("Contacts"), summary: "Create a deal", security: secured,
    request: body(DealCreate), responses: { 201: json(z.object({ deal: Deal }), "The deal."), 401: errors[401], 422: errors[422] } }),
  async (c) => send(c, { deal: await createDeal(c.var.deps, actor(c), c.req.valid("json"), await idempotentCreate(c.req.raw, "del")) }, 201));

  api.openapi(createRoute({ method: "patch", path: "/deals/{id}", tags: tag("Contacts"), summary: "Update or move a deal", security: secured,
    request: { params: Id, ...body(DealPatch) }, responses: { 200: json(z.object({ deal: Deal }), "The deal."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, { deal: await updateDeal(c.var.deps, actor(c), c.req.valid("param").id, c.req.valid("json")) }));

  // ---------------------------------------------------------------- change feed
  api.openapi(createRoute({ method: "get", path: "/changes", tags: tag("Sync"), summary: "What changed since a cursor", security: secured,
    description: "An ordered feed of task, project, doc, contact and deal changes. Keep the cursor and pass it back as since.",
    request: { query: z.object({ since: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(500) }) },
    responses: { 200: json(z.object({ changes: z.array(z.object({ seq: z.number(), entity: z.string(), id: z.string(), op: z.string(), version: z.number(), at: z.string() })), cursor: z.number(), more: z.boolean() }), "Changes."), 401: errors[401] } }),
  async (c) => { const q = c.req.valid("query"); return send(c, await changesSince(c.var.deps, actor(c).orgId, q.since, q.limit)); });
}

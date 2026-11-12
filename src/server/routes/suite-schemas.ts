/** Request schemas for the suite, shared by the app routes, the REST API (v1) and MCP. */
import { z } from "@hono/zod-openapi";
import { SWIMLANES } from "../../shared/board-lanes";

export const Category = z.enum(["todo", "doing", "done"]).openapi({ description: "The status group: to do, doing or done." });
export const Priority = z.enum(["none", "low", "medium", "high", "urgent"]);
const date = z.string().max(40).nullable().optional().openapi({ description: "ISO 8601 date or date-time, e.g. 2026-10-31.", example: "2026-10-31" });
export const AssigneeRef = z.string().regex(/^(member|agent):[A-Za-z0-9_-]+$/).nullable().optional()
  .openapi({ description: "member:<userId> or agent:<agentId>, or null for nobody.", example: "agent:agt_k3j2h1g0f9e8d7c6" });

export const StatusInput = z.object({ id: z.string().optional(), name: z.string().trim().min(1).max(40), category: Category, color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });
export const ProjectCreate = z.object({
  name: z.string().trim().min(1).max(80), description: z.string().max(2000).optional(), key: z.string().trim().max(6).regex(/^[A-Za-z0-9]*$/).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), statuses: z.array(StatusInput).min(1).max(20).optional(),
  triage: z.boolean().optional().openapi({ description: "Tasks from mail rules, forms, the API and AI apps wait in Triage until a person accepts them. On when left out. Only a person signed in to Multies may choose false: an API key gets 403 person_only." }),
}).openapi("ProjectCreate");
export const ProjectPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(), description: z.string().max(2000).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  archived: z.boolean().optional(), statuses: z.array(StatusInput).min(1).max(20).optional(),
  health: z.enum(["on_track", "at_risk", "off_track"]).nullable().optional().openapi({ description: "Set by hand on the portfolio: on_track, at_risk, off_track, or null for not set." }),
  healthNote: z.string().max(500).optional(), ownerId: z.string().nullable().optional().openapi({ description: "The user id of the project's owner, or null. The owner is a person: an AI agent is refused with 422." }),
  triage: z.boolean().optional().openapi({ description: "Tasks from mail rules, forms, the API and AI apps wait in Triage until a person accepts them. Tasks a person makes go straight to the board. Only a person signed in to Multies turns it off: an API key gets 403 person_only." }),
  key: z.string().trim().min(1).max(6).regex(/^[A-Za-z0-9]+$/).optional().openapi({ description: "R33: the short key before task numbers (letters and digits, up to 6, stored in capitals). A key another project in the workspace uses, in any case, answers 409 key_taken.", example: "OPS" }),
}).openapi("ProjectPatch");

export const FieldValues = z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(50), z.null()]))
  .openapi({ description: "Custom field values by field id (or field name). Text and URL: string. Number and currency (AUD): number. Date: YYYY-MM-DD. Single select: option id or label. Multi select: array of option ids or labels. Person: member:<id> or agent:<id>. Checkbox: true or false. null clears a value.", example: { fld_budget: 1250, fld_client: "Harbour Coffee" } });
const FieldOptionInput = z.object({ id: z.string().max(40).optional(), label: z.string().trim().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });
export const FieldCreate = z.object({
  name: z.string().trim().min(1).max(60), type: z.enum(["text", "number", "currency", "date", "select", "multiselect", "person", "checkbox", "url", "formula", "rollup"]),
  options: z.array(FieldOptionInput).max(50).optional(), position: z.number().int().optional(),
  config: z.lazy(() => FieldConfig).optional(),
}).openapi("FieldCreate");
export const FieldPatch = z.object({ name: z.string().trim().min(1).max(60).optional(), options: z.array(FieldOptionInput).max(50).optional(), position: z.number().int().optional(), config: z.lazy(() => FieldConfig).optional() }).openapi("FieldPatch");
/** R24.1: formula ({ expression }) or rollup ({ source, field, fn }) settings. */
export const FieldConfig = z.object({
  expression: z.string().max(500).optional().openapi({ description: "Formula: an expression like {Budget} * 1.1 (up to 500 characters)." }),
  source: z.enum(["subtasks", "epic_children", "project"]).optional().openapi({ description: "Rollup: what to aggregate." }),
  field: z.string().max(64).nullable().optional().openapi({ description: "Rollup: points, or a number, currency or formula field id." }),
  fn: z.enum(["sum", "count", "count_done", "average", "min", "max", "percent_done"]).optional(),
}).openapi("FieldConfig");
export const GuestInvite = z.object({ email: z.string().trim().email().max(254), name: z.string().trim().max(80).optional(), agentId: z.string().optional() }).openapi("GuestInvite");

export const RepeatRule = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(365).optional().openapi({ description: "Every N days, weeks, months or years (custom). Default 1." }),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional().openapi({ description: "Weekly: days of the week, 0 Sunday to 6 Saturday." }),
  monthDay: z.number().int().min(1).max(31).optional().openapi({ description: "Monthly: day of the month (short months use their last day)." }),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().openapi({ description: "Stop repeating after this date, YYYY-MM-DD." }),
  // R95: smart repeat.
  nth: z.number().int().min(-1).max(5).optional().openapi({ description: "Monthly: the nth weekday (1 to 5, -1 the last; a missing 5th falls back to the last)." }),
  nthWeekday: z.number().int().min(0).max(6).optional().openapi({ description: "Monthly with nth: the weekday, 0 Sunday to 6 Saturday." }),
  basis: z.enum(["due", "done"]).optional().openapi({ description: "Count the next date from the due date (default) or from when it was finished." }),
  tz: z.string().max(64).optional().openapi({ description: "Time zone the dates are counted in, e.g. Australia/Sydney (keeps the wall clock time across daylight saving)." }),
  rotate: z.array(z.string().max(100)).max(20).optional().openapi({ description: "Hand each next task to the next person: member:<id> in order." }),
}).nullable().optional().openapi("RepeatRule", { description: "Finishing a repeating task makes the next one, with the dates moved on. null stops repeating." });

export const TaskCreate = z.object({
  title: z.string().trim().min(1).max(300).openapi({ example: "Send Harbour Coffee the revised quote" }),
  notes: z.string().max(50_000).optional(),
  projectId: z.string().optional().openapi({ description: "Defaults to the workspace's first project." }),
  statusId: z.string().optional(), status: Category.optional(),
  assignee: AssigneeRef, assigneeId: AssigneeRef,
  priority: Priority.optional(), start: date, due: date,
  labels: z.array(z.string().max(40)).max(20).optional(),
  parentId: z.string().nullable().optional().openapi({ description: "Makes this a subtask of another task." }),
  source: z.object({ messageId: z.string().optional(), threadId: z.string().optional() }).nullable().optional().openapi({ description: "The email this task is about. The task links to its thread." }),
  fields: FieldValues.optional(),
  repeat: RepeatRule,
  type: z.enum(["task", "story", "bug", "epic"]).optional().openapi({ description: "task (default), story, bug or epic. An item whose parentId is an epic is in that epic." }),
  sprintId: z.string().max(64).nullable().optional().openapi({ description: "Round 21: put the task in a planned or active sprint of its project." }),
  points: z.number().min(0).max(1000).nullable().optional().openapi({ description: "Round 21: the estimate, in the project's unit (points or hours)." }),
}).openapi("TaskCreate");
export const TaskFromEmail = z.object({
  messageId: z.string().optional(), threadId: z.string().optional(),
  title: z.string().trim().max(300).optional(), notes: z.string().max(50_000).optional(), projectId: z.string().optional(),
  assignee: AssigneeRef, priority: Priority.optional(), due: date, labels: z.array(z.string().max(40)).max(20).optional(),
}).refine((v) => v.messageId || v.threadId, { message: "Pass messageId or threadId." }).openapi("TaskFromEmail");
export const TaskPatch = z.object({
  title: z.string().trim().min(1).max(300).optional(), notes: z.string().max(50_000).optional(), projectId: z.string().optional(),
  statusId: z.string().optional(), status: Category.optional(), assignee: AssigneeRef, assigneeId: AssigneeRef,
  assignees: z.array(z.string().max(80).regex(/^(member|agent):[A-Za-z0-9_-]{1,64}$/)).max(10).optional()
    .openapi({ description: "R84: everyone on the task, main assignee first (member:<id> or agent:<id>); [] unassigns. Wins over assignee." }),
  priority: Priority.optional(), start: date, due: date, labels: z.array(z.string().max(40)).max(20).optional(),
  parentId: z.string().nullable().optional(), position: z.number().finite().optional(),
  fields: FieldValues.optional(),
  repeat: RepeatRule,
  type: z.enum(["task", "story", "bug", "epic"]).optional().openapi({ description: "task, story, bug or epic. An epic can't have a parent; an epic with items keeps its type." }),
  sprintId: z.string().max(64).nullable().optional().openapi({ description: "Round 21: move to a sprint of the task's project; null moves it to the backlog." }),
  points: z.number().min(0).max(1000).nullable().optional().openapi({ description: "Round 21: the estimate, in the project's unit (points or hours); null clears it." }),
  version: z.number().int().optional().openapi({ description: "Send the version you read to reject the write if someone changed the task since." }),
}).openapi("TaskPatch");
export const TaskQuery = z.object({
  projectId: z.string().optional(), status: Category.optional(), statusId: z.string().optional(), threadId: z.string().optional(),
  assignee: z.string().optional().openapi({ description: "me, none, member:<id> or agent:<id>." }), priority: Priority.optional(), label: z.string().optional(),
  dueBefore: z.string().optional(), dueAfter: z.string().optional(), q: z.string().max(200).optional(),
  parentId: z.string().optional(), includeSubtasks: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(1000).optional(),
  sort: z.string().max(80).regex(/^(due|priority|title|created|field:[A-Za-z0-9_-]{1,64})$/).optional().openapi({ description: "due, priority, title, created or field:<fieldId>." }),
  dir: z.enum(["asc", "desc"]).optional(),
  type: z.enum(["task", "story", "bug", "epic"]).optional().openapi({ description: "Only this type: task, story, bug or epic." }),
  triage: z.enum(["pending"]).optional().openapi({ description: "R21: pending lists only items waiting in Triage; without it they are left out." }),
  sprintId: z.string().max(64).optional().openapi({ description: "R26 (MB-72): only tasks in this sprint; none lists the backlog (tasks in no sprint)." }),
});
/** R26 (MB-72): GET /tasks answers 400 to a query parameter it does not know, instead of ignoring it. */
export function unknownTaskParams(query: Record<string, string>, allowed: readonly string[] = Object.keys(TaskQuery.shape)) {
  return Object.keys(query).filter((k) => !allowed.includes(k) && !/^field\.[A-Za-z0-9_-]{1,64}$/.test(k));
}
export const CommentCreate = z.object({ body: z.string().trim().min(1).max(20_000) }).openapi("CommentCreate");
export const ViewCreate = z.object({
  projectId: z.string().nullable().optional(), name: z.string().trim().min(1).max(60), view: z.enum(["board", "list", "calendar", "timeline", "sprints", "workload"]),
  filters: z.record(z.string(), z.string().max(200)).default({})
    // R35: a board view may carry its own swimlanes ("lanes") and grouping ("group") beside the filters.
    .refine((f) => f.lanes === undefined || (SWIMLANES as readonly string[]).includes(f.lanes), { message: `lanes must be one of ${SWIMLANES.join(", ")}.` }),
  shared: z.boolean().optional(),
  /** R84: show it as a tab on Tasks. */
  pinned: z.boolean().optional(),
});
/** R84: change a saved view. */
export const ViewPatch = z.object({
  name: z.string().trim().min(1).max(60).optional(), view: z.enum(["board", "list", "calendar", "timeline", "sprints", "workload"]).optional(),
  filters: z.record(z.string(), z.string().max(200)).optional()
    .refine((f) => !f || f.lanes === undefined || (SWIMLANES as readonly string[]).includes(f.lanes), { message: `lanes must be one of ${SWIMLANES.join(", ")}.` }),
  shared: z.boolean().optional(), pinned: z.boolean().optional(), position: z.number().finite().optional(), projectId: z.string().nullable().optional(),
});

const LinkTarget = z.object({ type: z.enum(["project", "task", "thread", "contact", "deal"]), id: z.string().min(1) });
export const DocCreate = z.object({
  title: z.string().trim().max(200).default("Untitled"),
  content: z.record(z.string(), z.unknown()).optional().openapi({ description: "A Tiptap (ProseMirror) JSON document." }),
  text: z.string().max(200_000).optional().openapi({ description: "Or plain text: one paragraph per line, # headings and - bullets." }),
  projectId: z.string().nullable().optional(), links: z.array(LinkTarget).max(20).optional(),
  parentId: z.string().max(64).nullable().optional().openapi({ description: "R24: put the new page under this page in the docs tree." }),
}).openapi("DocCreate");
export const DocPatch = z.object({
  title: z.string().trim().max(200).optional(), content: z.record(z.string(), z.unknown()).optional(), version: z.number().int().optional(), links: z.array(LinkTarget).max(20).optional(),
  text: z.string().max(200_000).optional().openapi({ description: "Or plain text that replaces the whole body: one paragraph per line, # headings and - bullets." }),
  ifVersion: z.number().int().optional().openapi({ description: "R28: the version you read. A doc changed since then answers 409 with details.currentVersion. Same as version, or an If-Match header." }),
}).openapi("DocPatch");
/** R28: add to the end of a doc. One of markdown or text. */
export const DocAppend = z.object({
  markdown: z.string().min(1).max(200_000).optional().openapi({ description: "Markdown: headings, paragraphs, bullet, numbered and task lists, quotes, code, bold, italic, strike and links." }),
  text: z.string().min(1).max(200_000).optional().openapi({ description: "Or plain text: one paragraph per line, # headings and - bullets." }),
  ifVersion: z.number().int().optional().openapi({ description: "The version you read. A doc changed since then answers 409 with details.currentVersion. Or send an If-Match header." }),
}).refine((b) => (b.markdown === undefined) !== (b.text === undefined), { message: "Send markdown or text (one of them)." }).openapi("DocAppend");

export const ContactCreate = z.object({
  email: z.string().trim().email().max(254), name: z.string().trim().max(120).optional(), phone: z.string().trim().max(40).optional(),
  title: z.string().trim().max(120).optional(), notes: z.string().max(20_000).optional(), companyId: z.string().nullable().optional(),
}).openapi("ContactCreate");
export const ContactPatch = z.object({
  name: z.string().trim().max(120).optional(), phone: z.string().trim().max(40).nullable().optional(), title: z.string().trim().max(120).nullable().optional(),
  notes: z.string().max(20_000).optional(), companyId: z.string().nullable().optional(),
}).openapi("ContactPatch");
export const DealStage = z.enum(["lead", "qualified", "proposal", "won", "lost"]);
export const DealCreate = z.object({
  title: z.string().trim().min(1).max(200), stage: DealStage.optional(), value: z.number().min(0).max(1e10).optional().openapi({ description: "AUD, ex GST." }),
  contactId: z.string().nullable().optional(), companyId: z.string().nullable().optional(), expectedClose: date,
  // R94: win chance (null = the stage default) and the reason it was won or lost.
  probability: z.number().int().min(0).max(100).nullable().optional(), closeReason: z.string().trim().max(200).nullable().optional(),
}).openapi("DealCreate");
export const DealPatch = DealCreate.partial().extend({ position: z.number().finite().optional() }).openapi("DealPatch");

export const AutomationCreate = z.object({
  name: z.string().trim().min(1).max(120), trigger: z.enum(["email_received", "status_changed", "due_soon", "task_created", "assignee_changed", "due_passed", "meeting_ended", "chat_message_posted"]),
  conditions: z.record(z.string(), z.unknown()).default({}), action: z.enum(["create_task", "notify", "assign_thread", "post_to_channel", "assign_task", "set_status", "add_label", "set_priority", "create_subtask_checklist"]), actionConfig: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().optional(),
});
// R22.5: no defaults on a patch. With them, a patch of only { enabled } reset conditions and actionConfig to {}
// (an email rule then failed "Say which emails" and could not be turned off).
export const AutomationPatch = AutomationCreate.extend({ conditions: z.record(z.string(), z.unknown()).optional(), actionConfig: z.record(z.string(), z.unknown()).optional() }).partial();

export const PushDevice = z.object({ token: z.string().min(10).max(200), platform: z.enum(["ios", "android"]) }).openapi("PushDevice");

/** R84: workspace tags. */
export const TagCreate = z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });
export const TagPatch = z.object({ name: z.string().trim().min(1).max(40).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), position: z.number().finite().optional() });
/** R84: a field defined once for the whole workspace. */
export const WorkspaceFieldCreate = z.object({
  name: z.string().trim().min(1).max(60), type: z.enum(["text", "number", "currency", "date", "select", "multiselect", "person", "checkbox", "url"]),
  options: z.array(z.object({ id: z.string().max(40).optional(), label: z.string().trim().min(1).max(60), color: z.string().max(9).optional() })).max(50).optional(),
});
export const WorkspaceFieldPatch = WorkspaceFieldCreate.pick({ name: true, options: true }).partial();

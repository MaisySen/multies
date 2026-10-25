/** Request schemas for the suite, shared by the app routes, the REST API (v1) and MCP. */
import { z } from "@hono/zod-openapi";

export const Category = z.enum(["todo", "doing", "done"]).openapi({ description: "The status group: to do, doing or done." });
export const Priority = z.enum(["none", "low", "medium", "high", "urgent"]);
const date = z.string().max(40).nullable().optional().openapi({ description: "ISO 8601 date or date-time, e.g. 2026-10-31.", example: "2026-10-31" });
export const AssigneeRef = z.string().regex(/^(member|agent):[A-Za-z0-9_-]+$/).nullable().optional()
  .openapi({ description: "member:<userId> or agent:<agentId>, or null for nobody.", example: "agent:agt_k3j2h1g0f9e8d7c6" });

export const StatusInput = z.object({ id: z.string().optional(), name: z.string().trim().min(1).max(40), category: Category, color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });
export const ProjectCreate = z.object({
  name: z.string().trim().min(1).max(80), description: z.string().max(2000).optional(), key: z.string().trim().max(6).regex(/^[A-Za-z0-9]*$/).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), statuses: z.array(StatusInput).min(1).max(20).optional(),
}).openapi("ProjectCreate");
export const ProjectPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(), description: z.string().max(2000).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  archived: z.boolean().optional(), statuses: z.array(StatusInput).min(1).max(20).optional(),
  health: z.enum(["on_track", "at_risk", "off_track"]).nullable().optional().openapi({ description: "Set by hand on the portfolio: on_track, at_risk, off_track, or null for not set." }),
  healthNote: z.string().max(500).optional(), ownerId: z.string().nullable().optional().openapi({ description: "The user id of the project's owner, or null." }),
  triage: z.boolean().optional().openapi({ description: "R21: new mail and form tasks wait in Triage until someone accepts them." }),
}).openapi("ProjectPatch");

export const FieldValues = z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(50), z.null()]))
  .openapi({ description: "Custom field values by field id (or field name). Text and URL: string. Number and currency (AUD): number. Date: YYYY-MM-DD. Single select: option id or label. Multi select: array of option ids or labels. Person: member:<id> or agent:<id>. Checkbox: true or false. null clears a value.", example: { fld_budget: 1250, fld_client: "Harbour Coffee" } });
const FieldOptionInput = z.object({ id: z.string().max(40).optional(), label: z.string().trim().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });
export const FieldCreate = z.object({
  name: z.string().trim().min(1).max(60), type: z.enum(["text", "number", "currency", "date", "select", "multiselect", "person", "checkbox", "url"]),
  options: z.array(FieldOptionInput).max(50).optional(), position: z.number().int().optional(),
}).openapi("FieldCreate");
export const FieldPatch = z.object({ name: z.string().trim().min(1).max(60).optional(), options: z.array(FieldOptionInput).max(50).optional(), position: z.number().int().optional() }).openapi("FieldPatch");
export const GuestInvite = z.object({ email: z.string().trim().email().max(254), name: z.string().trim().max(80).optional(), agentId: z.string().optional() }).openapi("GuestInvite");

export const RepeatRule = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(365).optional().openapi({ description: "Every N days, weeks, months or years (custom). Default 1." }),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional().openapi({ description: "Weekly: days of the week, 0 Sunday to 6 Saturday." }),
  monthDay: z.number().int().min(1).max(31).optional().openapi({ description: "Monthly: day of the month (short months use their last day)." }),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().openapi({ description: "Stop repeating after this date, YYYY-MM-DD." }),
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
}).openapi("TaskCreate");
export const TaskFromEmail = z.object({
  messageId: z.string().optional(), threadId: z.string().optional(),
  title: z.string().trim().max(300).optional(), notes: z.string().max(50_000).optional(), projectId: z.string().optional(),
  assignee: AssigneeRef, priority: Priority.optional(), due: date, labels: z.array(z.string().max(40)).max(20).optional(),
}).refine((v) => v.messageId || v.threadId, { message: "Pass messageId or threadId." }).openapi("TaskFromEmail");
export const TaskPatch = z.object({
  title: z.string().trim().min(1).max(300).optional(), notes: z.string().max(50_000).optional(), projectId: z.string().optional(),
  statusId: z.string().optional(), status: Category.optional(), assignee: AssigneeRef, assigneeId: AssigneeRef,
  priority: Priority.optional(), start: date, due: date, labels: z.array(z.string().max(40)).max(20).optional(),
  parentId: z.string().nullable().optional(), position: z.number().finite().optional(),
  fields: FieldValues.optional(),
  repeat: RepeatRule,
  version: z.number().int().optional().openapi({ description: "Send the version you read to reject the write if someone changed the task since." }),
}).openapi("TaskPatch");
export const TaskQuery = z.object({
  projectId: z.string().optional(), status: Category.optional(), statusId: z.string().optional(), threadId: z.string().optional(),
  assignee: z.string().optional().openapi({ description: "me, none, member:<id> or agent:<id>." }), priority: Priority.optional(), label: z.string().optional(),
  dueBefore: z.string().optional(), dueAfter: z.string().optional(), q: z.string().max(200).optional(),
  parentId: z.string().optional(), includeSubtasks: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(1000).optional(),
  sort: z.string().max(80).regex(/^(due|priority|title|created|field:[A-Za-z0-9_-]{1,64})$/).optional().openapi({ description: "due, priority, title, created or field:<fieldId>." }),
  dir: z.enum(["asc", "desc"]).optional(),
  triage: z.enum(["pending"]).optional().openapi({ description: "R21: pending lists only items waiting in Triage; without it they are left out." }),
});
export const CommentCreate = z.object({ body: z.string().trim().min(1).max(20_000) }).openapi("CommentCreate");
export const ViewCreate = z.object({
  projectId: z.string().nullable().optional(), name: z.string().trim().min(1).max(60), view: z.enum(["board", "list", "calendar", "timeline"]),
  filters: z.record(z.string(), z.string().max(200)).default({}), shared: z.boolean().optional(),
});

const LinkTarget = z.object({ type: z.enum(["project", "task", "thread", "contact", "deal"]), id: z.string().min(1) });
export const DocCreate = z.object({
  title: z.string().trim().max(200).default("Untitled"),
  content: z.record(z.string(), z.unknown()).optional().openapi({ description: "A Tiptap (ProseMirror) JSON document." }),
  text: z.string().max(200_000).optional().openapi({ description: "Or plain text: one paragraph per line, # headings and - bullets." }),
  projectId: z.string().nullable().optional(), links: z.array(LinkTarget).max(20).optional(),
}).openapi("DocCreate");
export const DocPatch = z.object({
  title: z.string().trim().max(200).optional(), content: z.record(z.string(), z.unknown()).optional(), version: z.number().int().optional(), links: z.array(LinkTarget).max(20).optional(),
}).openapi("DocPatch");

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
}).openapi("DealCreate");
export const DealPatch = DealCreate.partial().extend({ position: z.number().finite().optional() }).openapi("DealPatch");

export const AutomationCreate = z.object({
  name: z.string().trim().min(1).max(120), trigger: z.enum(["email_received", "status_changed", "due_soon"]),
  conditions: z.record(z.string(), z.unknown()).default({}), action: z.enum(["create_task", "notify"]), actionConfig: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().optional(),
});
export const AutomationPatch = AutomationCreate.partial();

export const PushDevice = z.object({ token: z.string().min(10).max(200), platform: z.enum(["ios", "android"]) }).openapi("PushDevice");

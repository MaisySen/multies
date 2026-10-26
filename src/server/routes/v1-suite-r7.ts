/**
 * Round 7 in the public API (v1): time tracking, task dependencies, forms, reports and
 * meetings. Agent keys log time under the agent's own name. Meeting invites are mail that
 * leaves the business, so they always go out as an agent and follow its approval rules.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import type { SuiteActor } from "../services/suite/common";
import { addDependency, dependenciesOf, removeDependency, resolveTaskId } from "../services/suite/tasks";
import { addEntry, listEntries, runningTimer, startTimer, stopTimer, timesheet } from "../services/suite/time";
import { createForm, getForm, listForms } from "../services/suite/forms";
import { dashboard } from "../services/suite/reports";
import { createMeeting, getMeeting, joinMeeting, listMeetings, sendInvites } from "../services/suite/meetings";
import { getAgent } from "../services/agents";
import { FormCreate, MeetingCreate, ReportQuery, TimeEntryCreate, TimeQuery, TimeStart, TimeStop } from "./suite-r7";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const errors = { 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed."), 503: err("Not switched on.") } as const;
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const secured = [{ bearerAuth: [] }];
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const Any = z.record(z.string(), z.unknown());

const TimeEntry = z.object({
  id: z.string(), taskId: z.string().nullable(), task: z.object({ id: z.string(), ref: z.string(), title: z.string() }).nullable(), projectId: z.string().nullable(),
  person: z.object({ type: z.enum(["member", "agent"]), id: z.string(), name: z.string() }), startedAt: z.string(), endedAt: z.string().nullable(), running: z.boolean(),
  seconds: z.number().int(), note: z.string(), billable: z.boolean(), source: z.enum(["timer", "manual"]),
}).passthrough().openapi("TimeEntry");

const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;

/** Invites leave the business, so they go as an agent: the key's own, or the one named. */
async function asAgent(c: Context<AppEnv>, agentId?: string): Promise<SuiteActor> {
  const a = actor(c);
  if (a.agentId) {
    if (agentId && agentId !== a.agentId) throw new HttpError(403, "agent_key_scope", "This key belongs to another agent.");
    return a;
  }
  if (!agentId) throw new HttpError(422, "agent_required", "Pass agentId: invites from the API go out as an agent inbox and follow its approval rules.");
  const ag = await getAgent(c.var.deps, a.orgId, agentId);
  return { ...a, agentId: ag.id, name: ag.name };
}

export function registerSuiteR7Routes(api: OpenAPIHono<AppEnv>) {
  // ---------------------------------------------------------------- time
  api.openapi(createRoute({ method: "get", path: "/time", tags: ["Time"], summary: "List time entries", security: secured,
    description: "Filter by date range (from, to), person (me, member:<id>, agent:<id>), project or task. The default range is the last 8 days.",
    request: { query: TimeQuery }, responses: { 200: json(z.object({ entries: z.array(TimeEntry) }), "Entries, newest first."), 401: errors[401] } }),
  async (c) => send(c, { entries: await listEntries(c.var.deps, actor(c), c.req.valid("query")) }));

  api.openapi(createRoute({ method: "get", path: "/time/timesheet", tags: ["Time"], summary: "Timesheet per person and project", security: secured,
    request: { query: TimeQuery }, responses: { 200: json(Any, "Rows per person and project with seconds per day, and totals."), 401: errors[401] } }),
  async (c) => send(c, await timesheet(c.var.deps, actor(c), c.req.valid("query"))));

  api.openapi(createRoute({ method: "get", path: "/time/running", tags: ["Time"], summary: "This key's running timer", security: secured,
    responses: { 200: json(z.object({ entry: TimeEntry.nullable() }), "The running timer, or null."), 401: errors[401], 422: errors[422] } }),
  async (c) => send(c, { entry: await runningTimer(c.var.deps, actor(c)) }));

  api.openapi(createRoute({ method: "post", path: "/time/start", tags: ["Time"], summary: "Start a timer on a task", security: secured,
    description: "Agent keys only, or a person in the app: a timer belongs to someone. A timer already running stops first.",
    request: body(TimeStart), responses: { 201: json(z.object({ entry: TimeEntry }), "The running entry."), 401: errors[401], 404: errors[404], 422: errors[422] } }),
  async (c) => send(c, { entry: await startTimer(c.var.deps, actor(c), c.req.valid("json")) }, 201));

  api.openapi(createRoute({ method: "post", path: "/time/stop", tags: ["Time"], summary: "Stop the running timer", security: secured,
    request: body(TimeStop), responses: { 200: json(z.object({ entry: TimeEntry.nullable() }), "The stopped entry, or null if none was running."), 401: errors[401] } }),
  async (c) => send(c, { entry: await stopTimer(c.var.deps, actor(c), c.req.valid("json")) }));

  api.openapi(createRoute({ method: "post", path: "/time", tags: ["Time"], summary: "Log time by hand", security: secured,
    description: "Minutes on a task (or a project) on a date. Workspace keys pass person (member:<id> or agent:<id>).",
    request: body(TimeEntryCreate), responses: { 201: json(z.object({ entry: TimeEntry }), "The entry."), 401: errors[401], 403: errors[403], 422: errors[422] } }),
  async (c) => send(c, { entry: await addEntry(c.var.deps, actor(c), c.req.valid("json")) }, 201));

  // ---------------------------------------------------------------- dependencies
  api.openapi(createRoute({ method: "get", path: "/tasks/{id}/dependencies", tags: ["Tasks"], summary: "What blocks a task, and what it blocks", security: secured,
    request: { params: Id }, responses: { 200: json(Any, "{ blockedBy, blocking, blocked }"), 401: errors[401], 404: errors[404] } }),
  async (c) => { const a = actor(c); return send(c, await dependenciesOf(c.var.deps, a.orgId, await resolveTaskId(c.var.deps, a.orgId, c.req.valid("param").id))); });

  api.openapi(createRoute({ method: "post", path: "/tasks/{id}/dependencies", tags: ["Tasks"], summary: "Mark a task as blocked by another", security: secured,
    request: { params: Id, ...body(z.object({ blockedBy: z.string().min(1).openapi({ example: "OPS-3" }) })) }, responses: { 201: json(Any, "The task's dependencies."), 401: errors[401], 404: errors[404], 422: errors[422] } }),
  async (c) => send(c, await addDependency(c.var.deps, actor(c), c.req.valid("param").id, c.req.valid("json").blockedBy), 201));

  api.openapi(createRoute({ method: "delete", path: "/tasks/{id}/dependencies/{blockedBy}", tags: ["Tasks"], summary: "Remove a dependency", security: secured,
    request: { params: Id.extend({ blockedBy: z.string().openapi({ param: { name: "blockedBy", in: "path" } }) }) }, responses: { 200: json(Any, "The task's dependencies."), 401: errors[401], 404: errors[404] } }),
  async (c) => { const p = c.req.valid("param"); return send(c, await removeDependency(c.var.deps, actor(c), p.id, p.blockedBy)); });

  // ---------------------------------------------------------------- forms
  api.openapi(createRoute({ method: "get", path: "/forms", tags: ["Forms"], summary: "List forms", security: secured,
    responses: { 200: json(z.object({ forms: z.array(Any) }), "Forms with their public URLs."), 401: errors[401] } }),
  async (c) => send(c, { forms: await listForms(c.var.deps, actor(c).orgId) }));

  api.openapi(createRoute({ method: "post", path: "/forms", tags: ["Forms"], summary: "Create a public form", security: secured,
    description: "Each submission makes a task (target task) or a contact (target contact, needs an email field). The response has the public URL.",
    request: body(FormCreate), responses: { 201: json(z.object({ form: Any }), "The form."), 401: errors[401], 422: errors[422] } }),
  async (c) => send(c, { form: await createForm(c.var.deps, actor(c), c.req.valid("json")) }, 201));

  api.openapi(createRoute({ method: "get", path: "/forms/{id}", tags: ["Forms"], summary: "A form and its recent submissions", security: secured,
    request: { params: Id }, responses: { 200: json(Any, "{ form, submissions }"), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, await getForm(c.var.deps, actor(c).orgId, c.req.valid("param").id)));

  // ---------------------------------------------------------------- reports
  api.openapi(createRoute({ method: "get", path: "/reports/dashboard", tags: ["Reports"], summary: "Tasks, time and deals in numbers", security: secured,
    description: "Tasks by status and assignee, overdue tasks, tasks done per day, time per project and the deals pipeline in AUD (ex GST).",
    request: { query: ReportQuery }, responses: { 200: json(Any, "The dashboard."), 401: errors[401] } }),
  async (c) => send(c, await dashboard(c.var.deps, actor(c), c.req.valid("query"))));

  // ---------------------------------------------------------------- meetings
  api.openapi(createRoute({ method: "get", path: "/meetings", tags: ["Meetings"], summary: "List meetings", security: secured,
    request: { query: z.object({ upcoming: z.enum(["true", "false"]).optional() }) }, responses: { 200: json(z.object({ meetings: z.array(Any) }), "Meetings, newest first."), 401: errors[401] } }),
  async (c) => send(c, { meetings: await listMeetings(c.var.deps, actor(c), { upcoming: c.req.valid("query").upcoming === "true" }) }));

  api.openapi(createRoute({ method: "post", path: "/meetings", tags: ["Meetings"], summary: "Schedule a video meeting", security: secured,
    description: "Start it from a thread, task or contact (source) to fill in the title and guests. With sendInvites the calendar invite goes out as an agent (agentId, or the key's own agent) and waits for approval when the agent's rules say so.",
    request: body(MeetingCreate.extend({ agentId: z.string().optional() })), responses: { 201: json(Any, "{ meeting, invites }"), 401: errors[401], 404: errors[404], 422: errors[422] } }),
  async (c) => {
    const b = c.req.valid("json");
    const a = b.sendInvites ? await asAgent(c, b.agentId) : actor(c);
    return send(c, await createMeeting(c.var.deps, a, b), 201);
  });

  api.openapi(createRoute({ method: "get", path: "/meetings/{id}", tags: ["Meetings"], summary: "Get a meeting", security: secured,
    request: { params: Id }, responses: { 200: json(z.object({ meeting: Any }), "The meeting with its guest link."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, { meeting: await getMeeting(c.var.deps, actor(c), c.req.valid("param").id) }));

  api.openapi(createRoute({ method: "post", path: "/meetings/{id}/invite", tags: ["Meetings"], summary: "Send the calendar invite", security: secured,
    request: { params: Id, ...body(z.object({ agentId: z.string().optional() })) }, responses: { 200: json(Any, "sent, or pending_approval with the approval id"), 401: errors[401], 422: errors[422] } }),
  async (c) => send(c, await sendInvites(c.var.deps, await asAgent(c, c.req.valid("json").agentId), c.req.valid("param").id)));

  api.openapi(createRoute({ method: "post", path: "/meetings/{id}/join", tags: ["Meetings"], summary: "A LiveKit token to join", security: secured,
    request: { params: Id }, responses: { 200: json(Any, "{ url, token, room }"), 401: errors[401], 503: errors[503] } }),
  async (c) => send(c, await joinMeeting(c.var.deps, actor(c), c.req.valid("param").id)));
}

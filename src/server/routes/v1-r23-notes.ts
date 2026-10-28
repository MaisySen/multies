/**
 * Round 23 (R23.5) in the public API (v1): a meeting's agenda and notes doc and its action items.
 * Read only keys can read the notes; making the doc and creating tasks need a full key. Agent keys
 * create tasks as their agent.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { createActionItems, ensureNotesDoc, meetingNotes } from "../services/suite/meeting-notes";
import { ActionItemsCreate } from "./meeting-notes";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: false, content: { "application/json": { schema } } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { parse: (v: unknown) => any }) => schema.parse(await c.req.json().catch(() => ({})));
const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";

const NOTES = "{ meeting: { id, title, startsAt, endsAt, status, invitees, joinUrl, recurrence, source }, timeZone, doc: { id, title, version, content, text } | null, agenda: string[], notes: string[], actionItems: [{ key, text, title, assignee, due, task }], pending, people, summary }";

export function registerMeetingNotesRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Meetings"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/meetings/{id}/notes", "Get a meeting's notes", `The agenda, notes and action items of the meeting's notes doc, with each item's assignee, due date and task once made. doc is null until the doc is made. Returns ${NOTES}. summary is null unless a recording summary exists.`, { request: { params: Id } }),
    async (c) => send(c, await meetingNotes(c.var.deps, actor(c), pid(c))));
  api.openapi(route("post", "/meetings/{id}/notes", "Make a meeting's notes doc", `Makes the notes doc (headings Agenda, Notes, Action items) if the meeting has none yet, and returns the notes as GET does. Safe to call twice.`, { request: { params: Id } }),
    async (c) => { await ensureNotesDoc(c.var.deps, actor(c), pid(c)); return send(c, await meetingNotes(c.var.deps, actor(c), pid(c))); });
  api.openapi(route("post", "/meetings/{id}/action-items", "Turn action items into tasks", "Body: { items?: [{ key?, title?, assignee?, due? }], projectId? }. With no items, every unchecked action item in the notes that is not a task yet becomes one. An item with a key (from GET .../notes) is one already in the notes; title, assignee and due override what was read from it. An item without a key is new: it is added to the notes, then made a task. assignee: member:<userId>, agent:<agentId>, a name or an email in the workspace. due: YYYY-MM-DD. Items that are already tasks are skipped. Returns { created: [task], skipped: [{ key, taskId }], docId }.", { request: { params: Id, ...body(ActionItemsCreate) } }),
    async (c) => send(c, await createActionItems(c.var.deps, actor(c), pid(c), await jsonBody(c, ActionItemsCreate))));
}

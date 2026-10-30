/**
 * R31 in the public API (v1): notification triage and catch-up for the person who made the key (workspace keys
 * only; agent keys have no inbox). Same services as the app routes and the MCP tools.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import type { SuiteActor } from "../services/suite/common";
import { listNotifications } from "../services/suite/notify";
import { markDone, markManyDone, markUndone, snooze, TRIAGE_VIEWS, type TriageView } from "../services/suite/notify-triage";
import { CATCHUP_TYPES, getCatchup, recordVisit, type CatchupType } from "../services/suite/catchup";
import { NotificationIds, SnoozeBody } from "./suite";
import { CatchupVisitBody } from "./catchup-r31";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { parse: (v: unknown) => any }) => schema.parse(await c.req.json().catch(() => ({})));
const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
/** The person behind a workspace key. */
function person(c: Context<AppEnv>) {
  const a = actor(c);
  if (a.agentId || !a.userId) throw new HttpError(403, "workspace_key_only", "Agent keys have no notifications inbox. Use a workspace key.");
  return a;
}
function writable(a: SuiteActor) {
  if (a.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
}

export function registerTriageR31Routes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post", path: string, tag: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: [tag], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/notifications", "Notifications", "List your notifications", "The inbox of the person who made the key. Query: view (inbox, later or done; default inbox), unread (1), category, limit (1 to 200), before (an id, for the next page). Each item has doneAt and snoozedUntil (ISO or null); the answer has unread (Inbox only), counts per category and viewCounts { inbox, later, done }."),
    async (c) => {
      const a = person(c);
      const view = c.req.query("view");
      if (view && !(TRIAGE_VIEWS as readonly string[]).includes(view)) throw new HttpError(422, "validation_failed", "view is inbox, later or done.");
      const unread = c.req.query("unread");
      return send(c, await listNotifications(c.var.deps, a.orgId, a.userId, { view: (view as TriageView) || undefined, unread: unread === "1" || unread === "true", category: c.req.query("category") || undefined, limit: Number(c.req.query("limit")) || undefined, before: c.req.query("before") || undefined }));
    });

  api.openapi(route("post", "/notifications/done", "Notifications", "Mark notifications done", "Body: { ids } (1 to 500). Moves them out of the Inbox to Done and marks them read. Answers { updated, ids }.", { request: body(NotificationIds) }),
    async (c) => { const a = person(c); writable(a); return send(c, await markManyDone(c.var.deps, a.orgId, a.userId, (await jsonBody(c, NotificationIds)).ids)); });

  api.openapi(route("post", "/notifications/{id}/done", "Notifications", "Mark a notification done", "Moves it to Done and marks it read. Idempotent.", { request: { params: Id } }),
    async (c) => { const a = person(c); writable(a); return send(c, await markDone(c.var.deps, a.orgId, a.userId, pid(c))); });

  api.openapi(route("post", "/notifications/{id}/undone", "Notifications", "Move a notification back to the Inbox", "Clears done and any snooze.", { request: { params: Id } }),
    async (c) => { const a = person(c); writable(a); return send(c, await markUndone(c.var.deps, a.orgId, a.userId, pid(c))); });

  api.openapi(route("post", "/notifications/{id}/snooze", "Notifications", "Snooze a notification", "Body: { until } (an ISO time in the future, at most 90 days ahead) or { preset: later_today | tomorrow | next_week } in your time zone (UTC+10 when none is set). It moves to Later and comes back to the top of the Inbox, unread, at that time.", { request: { params: Id, ...body(SnoozeBody) } }),
    async (c) => { const a = person(c); writable(a); return send(c, await snooze(c.var.deps, a.orgId, a.userId, pid(c), await jsonBody(c, SnoozeBody))); });

  api.openapi(route("get", "/catchup", "Catch-up", "What did I miss", "Query: type (channel, task or doc), id, visit (1 to also record this visit). A digest since your last visit: counts (messages, replies, comments, edits, statusChanges, assigneeChanges, mentions), actors, decisions, latest and hasNew. mode is always digest; canSummarise says the workspace has its own AI key."),
    async (c) => {
      const a = person(c);
      const type = c.req.query("type") ?? "";
      const id = c.req.query("id") ?? "";
      if (!(CATCHUP_TYPES as readonly string[]).includes(type) || !id) throw new HttpError(422, "validation_failed", "Send type (channel, task or doc) and id.");
      const visit = c.req.query("visit") === "1" || c.req.query("visit") === "true";
      if (visit) writable(a);
      return send(c, { catchup: await getCatchup(c.var.deps, a, type as CatchupType, id, { visit }) });
    });

  api.openapi(route("post", "/catchup/visit", "Catch-up", "Mark an item caught up", "Body: { type, id, force? }. Sets your last visit to now (force defaults to true; with force false it writes at most once a minute).", { request: body(CatchupVisitBody) }),
    async (c) => { const a = person(c); writable(a); const b = await jsonBody(c, CatchupVisitBody); return send(c, await recordVisit(c.var.deps, a, b.type, b.id, { force: b.force ?? true })); });
}

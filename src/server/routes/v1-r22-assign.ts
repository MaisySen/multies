/**
 * Round 22 (R22.1 and R22.5) in the public API (v1): thread assignment, done or open, the thread list
 * by view, and reply times. Read only keys can list and read stats; writes need a full key (apiKeyAuth
 * refuses a read only key on anything but GET). Agent keys see only their agent's mailboxes.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { listThreads, scopeFor } from "../services/agents";
import type { SuiteActor } from "../services/suite/common";
import { assignThread, getThreadState, replyStats, setThreadStatus, viewerOf } from "../services/mail/thread-state";
import { AssignBody, StatsQuery, StatusBody, ThreadViewQuery } from "./thread-state";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { parse: (v: unknown) => any }) => schema.parse(await c.req.json().catch(() => ({})));
const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";
const ThreadPatch = z.object({
  status: StatusBody.shape.status.optional(),
  userId: z.string().max(64).nullable().optional(),
  assigneeId: z.string().max(64).nullable().optional(),
});
const ListQuery = z.object({
  mailboxId: z.string().max(64).optional(),
  before: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).merge(ThreadViewQuery);

export function registerR22AssignRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "patch", path: string, tag: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: [tag], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 400: err("The assignee can't take this thread."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/threads", "Shared inbox", "List threads by view",
    "Threads across the mailboxes the key can read, newest first. view: open (the default), mine, unassigned, assigned (with assignee=<userId>, or anyone), waiting, done, all. Each thread carries assignee { id, name } or null, status (open, waiting or done) and lastInboundAt. Pass before from nextCursor for the next page."),
  async (c) => {
    const q = ListQuery.parse(c.req.query());
    const a = actor(c);
    return send(c, await listThreads(c.var.deps, a.orgId, await scopeFor(c.var.deps, c.var.auth), { ...q, view: q.view ?? "open", viewerUserId: viewerOf(a) }));
  });
  api.openapi(route("get", "/threads/{id}/state", "Shared inbox", "Read a thread's owner and status", "{ state: { threadId, status, assignee, assignedAt, doneAt } }.", { request: { params: Id } }),
    async (c) => send(c, { state: await getThreadState(c.var.deps, actor(c), pid(c)) }));
  api.openapi(route("post", "/threads/{id}/assign", "Shared inbox", "Assign a thread", "Body: { userId } (a member who can open the thread's mailbox) or { userId: null } to unassign. The assignee gets a notification unless they assigned themselves.", { request: { params: Id, ...body(AssignBody) } }),
    async (c) => send(c, { state: await assignThread(c.var.deps, actor(c), pid(c), (await jsonBody(c, AssignBody)).userId) }));
  api.openapi(route("post", "/threads/{id}/status", "Shared inbox", "Mark a thread done, waiting or reopen it", "Body: { status: open | waiting | done }. New inbound mail puts a waiting or done thread back to open.", { request: { params: Id, ...body(StatusBody) } }),
    async (c) => send(c, { state: await setThreadStatus(c.var.deps, actor(c), pid(c), (await jsonBody(c, StatusBody)).status) }));
  // MB-59: PATCH like every other resource. Same rules as the two POST endpoints, in one call.
  api.openapi(route("patch", "/threads/{id}", "Shared inbox", "Update a thread's owner or status", "Body: { status?: open | waiting | done, userId?: string | null } (assigneeId is accepted as another name for userId). Returns { state }.", { request: { params: Id, ...body(ThreadPatch) } }),
    async (c) => {
      const b = await jsonBody(c, ThreadPatch);
      const userId = b.userId !== undefined ? b.userId : b.assigneeId;
      if (userId === undefined && b.status === undefined) return c.json({ error: { code: "validation_failed", message: "Pass status, userId or both." } }, 422);
      let state = userId !== undefined ? await assignThread(c.var.deps, actor(c), pid(c), userId) : undefined;
      if (b.status !== undefined) state = await setThreadStatus(c.var.deps, actor(c), pid(c), b.status);
      return send(c, { state });
    });
  api.openapi(route("get", "/stats/replies", "Shared inbox", "Reply times",
    "Query: mailboxId, from, to (ISO dates; the last 30 days by default, at most 90), groupBy (mailbox or person). Per row: threads, replied, medianFirstResponseMs, averageFirstResponseMs, resolved, medianResolutionMs, averageResolutionMs; total sums every thread. Calendar hours. At most 2,000 threads are scanned, newest first; sampled: true says the answer was cut."),
  async (c) => send(c, await replyStats(c.var.deps, actor(c), StatsQuery.parse(c.req.query()))));
}

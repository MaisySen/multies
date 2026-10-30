/**
 * Round 22 (R22.3, R22.4) in the public API (v1): thread presence and shared draft replies.
 * Read only keys can read; taking over a draft needs a full key (the v1 middleware refuses
 * other methods for read keys) and is refused for agent keys.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { listThreadDrafts, takeOverDraft, threadPresence } from "../services/suite/thread-collab";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;
const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";

export function registerPresenceRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post", path: string, tag: string, summary: string, description: string) =>
    createRoute({ method, path, tags: [tag], summary, description, security: [{ bearerAuth: [] }], request: { params: Id }, responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 409: err("The draft changed hands just now.") } });

  api.openapi(route("get", "/threads/{id}/presence", "Threads", "Who is in a thread now", "People who have the shared inbox thread open right now: { people: [{ userId, name, state: viewing | replying, since, lastSeen, tabs }], replying: [names] }. Entries expire 40 seconds after the last heartbeat. 404 when the key can't open the thread."),
    async (c) => {
      const v = await threadPresence(c.var.deps, c.var.auth, pid(c), { op: "list" });
      return send(c, { threadId: pid(c), people: v.people, replying: v.people.filter((p) => p.state === "replying").map((p) => p.name) });
    });
  api.openapi(route("get", "/threads/{id}/drafts", "Threads", "List draft replies in a thread", "Draft replies in the thread, in mailboxes the key can open: { drafts: [{ id, mailboxId, subject, snippet, to, author: { userId, name } | null, mine, updatedAt }] }."),
    async (c) => send(c, { drafts: await listThreadDrafts(c.var.deps, c.var.auth, pid(c)) }));
  api.openapi(route("post", "/drafts/{id}/take-over", "Threads", "Take over a draft reply", "Makes the key's person the draft's owner (one row write). The previous author is notified once and their next save of it answers 409. Agent keys get 403."),
    async (c) => send(c, await takeOverDraft(c.var.deps, c.var.auth, pid(c))));
}

/**
 * R26 (DF-3): AI agent members in the public API (v1), the parts v1-people.ts did not have: list
 * them with avatar, paused state and linked inbox, read one, and edit or pause one. A paused agent
 * member's keys are refused until it is resumed. Editing needs a workspace key (agent keys, agent
 * member keys and read only keys get 403). Creating, keys and removal stay in v1-people.ts.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { getAgentMember, listAgentMembers, updateAgentMember } from "../services/suite/agent-members-r26";
import { AgentMemberPatchBody } from "./team";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;

export function registerAgentMemberR26Routes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "patch", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["People"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/agent-members", "List AI agent members", "Agent members with title, bio, avatar (colour and initials), whether they are paused, the agent inbox linked to them (or null: mailbox is optional) and how many keys they have."),
    async (c) => send(c, { agents: await listAgentMembers(c.var.deps, c.var.auth.orgId) }));
  api.openapi(route("get", "/agent-members/{id}", "Get an AI agent member", "One agent member by user id.", { request: { params: Id } }),
    async (c) => send(c, { agent: await getAgentMember(c.var.deps, c.var.auth.orgId, c.req.param("id") ?? "") }));
  api.openapi(route("patch", "/agent-members/{id}", "Edit or pause an AI agent member", "Body: { name?, title?, bio?, avatarColor? (#rrggbb or null), disabled? (true pauses it and its keys are refused; false resumes it), inboxAgentId? (an existing agent inbox, or null) }. Needs a workspace key. Recorded in the audit log.",
    { request: { params: Id, body: { required: true, content: { "application/json": { schema: AgentMemberPatchBody } } } } }),
  async (c) => send(c, { agent: await updateAgentMember(c.var.deps, c.var.auth, c.req.param("id") ?? "", AgentMemberPatchBody.parse(await c.req.json().catch(() => ({})))) }));
}

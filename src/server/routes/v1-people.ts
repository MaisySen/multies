/**
 * People and AI agent members in the public API (v1), plus series edits and the .ics for meetings.
 * An agent member is a workspace member with kind "agent": no mailbox, no seat, its own API keys.
 * Its keys act as the member (role member), so its posts, comments and activity carry its name.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { createAgentMember, createAgentMemberKey, getPerson, listAgentMemberKeys, listPeople, removeAgentMember, revokeAgentMemberKey, updateProfile } from "../services/people";
import type { SuiteActor } from "../services/suite/common";
import { meetingIcs, updateMeeting } from "../services/suite/meetings";
import { MeetingPatch } from "./suite-r7";
import { AgentKeyBody, AgentMemberBody, ProfileBody } from "./team";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const IdKey = Id.extend({ keyId: z.string().min(1).openapi({ param: { name: "keyId", in: "path" } }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const auth = (c: Context<AppEnv>) => c.var.auth as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { parse: (v: unknown) => any }) => schema.parse(await c.req.json().catch(() => ({})));
const pid = (c: Context<AppEnv>, k = "id") => c.req.param(k) ?? "";

export function registerPeopleRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "patch" | "delete", path: string, tag: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: [tag], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 402: err("Plan limit reached."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  // ---------------------------------------------------------------- people
  api.openapi(route("get", "/people", "People", "List people and agents", "Everyone in the workspace with their title and bio: people (kind human), AI agent members (kind agent, no email shown) and mail agents (type mail_agent, with their inbox)."),
    async (c) => send(c, { people: await listPeople(c.var.deps, auth(c).orgId) }));
  api.openapi(route("get", "/people/{id}", "People", "Get a member", "One member by user id, with title and bio.", { request: { params: Id } }),
    async (c) => send(c, { person: await getPerson(c.var.deps, auth(c).orgId, pid(c)) }));
  api.openapi(route("patch", "/people/{id}", "People", "Edit a title or bio", "Body: { title?, bio?, name? }. Workspace keys edit anyone but the owner; an agent member's key edits itself. name is for agent members only.", { request: { params: Id, ...body(ProfileBody) } }),
    async (c) => send(c, { person: await updateProfile(c.var.deps, auth(c), pid(c), await jsonBody(c, ProfileBody)) }));

  // ---------------------------------------------------------------- agent members
  api.openapi(route("post", "/agent-members", "People", "Add an AI agent member", "Body: { name, title?, bio?, scope? }. Returns the member and its first API key (secret shown once). Agent members take no seat and no inbox; the Free plan includes 10. Needs a workspace key.", { request: body(AgentMemberBody) }),
    async (c) => send(c, await createAgentMember(c.var.deps, auth(c), await jsonBody(c, AgentMemberBody)), 201));
  api.openapi(route("delete", "/agent-members/{id}", "People", "Remove an AI agent member", "Removes the member and revokes its keys. What it posted stays under its name.", { request: { params: Id } }),
    async (c) => send(c, { removed: await removeAgentMember(c.var.deps, auth(c), pid(c)) }));
  api.openapi(route("get", "/agent-members/{id}/keys", "People", "List an agent member's keys", "Prefixes and scopes only; secrets are never shown again.", { request: { params: Id } }),
    async (c) => send(c, { keys: await listAgentMemberKeys(c.var.deps, auth(c), pid(c)) }));
  api.openapi(route("post", "/agent-members/{id}/keys", "People", "Create a key for an agent member", "Body: { name?, scope? (full or read) }. The secret is shown once.", { request: { params: Id, ...body(AgentKeyBody) } }),
    async (c) => send(c, await createAgentMemberKey(c.var.deps, auth(c), pid(c), await jsonBody(c, AgentKeyBody)), 201));
  api.openapi(route("delete", "/agent-members/{id}/keys/{keyId}", "People", "Revoke an agent member's key", "The key stops working at once.", { request: { params: IdKey } }),
    async (c) => {
      await revokeAgentMemberKey(c.var.deps, auth(c), pid(c), pid(c, "keyId"));
      return send(c, { revoked: true });
    });

  // ---------------------------------------------------------------- meeting series
  api.openapi(route("patch", "/meetings/{id}", "Meetings", "Edit a meeting or a whole series", "Body: { title?, startsAt?, durationMin?, status?, invitees?, recurrence? }. recurrence is { interval: 1 or 2, days: [mo..su], until: YYYY-MM-DD or count, timezone } or an RRULE string such as FREQ=WEEKLY;BYDAY=MO;COUNT=10; null makes it a one off. Edits apply to the series.", { request: { params: Id, ...body(MeetingPatch) } }),
    async (c) => send(c, { meeting: await updateMeeting(c.var.deps, auth(c) as SuiteActor, pid(c), await jsonBody(c, MeetingPatch)) }));
  api.openapi(createRoute({ method: "get", path: "/meetings/{id}/ics", tags: ["Meetings"], summary: "The meeting as an .ics file", description: "A series carries its RRULE with DTSTART in the series' time zone.", security: [{ bearerAuth: [] }], request: { params: Id },
    responses: { 200: { description: "text/calendar", content: { "text/calendar": { schema: z.string() } } }, 401: err("Missing or invalid API key."), 404: err("Not found.") } }),
  async (c) => new Response(await meetingIcs(c.var.deps, auth(c) as SuiteActor, pid(c)), { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": "attachment; filename=\"meeting.ics\"" } }) as never);
}

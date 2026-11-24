/**
 * Round 32: the meeting waiting room. Cookie session at /api/meeting-lobby (members: list, decide,
 * admit all, the setting), the guest's side at /api/public/meeting-lobby/<token> (ask to join, poll,
 * who is here), the REST API (v1) and the MCP tools meeting_lobby_list and meeting_lobby_decide.
 */
import { Hono } from "hono";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as zz } from "zod";
import type { AppEnv, Deps } from "../context";
import { parseBody, requireAuth } from "../middleware";
import type { SuiteActor } from "../services/suite/common";
import { askToJoin, decideLobby, listLobby, lobbyStatus, setGuestsWait, whoIsHere } from "../services/suite/meeting-lobby-r32";
import type { Scoped } from "./mcp-server";

const Decide = z.object({ lobbyId: z.string().min(1).max(64).optional(), all: z.boolean().optional(), decision: z.enum(["admit", "deny"]) });

export function meetingLobbyRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/:id", async (c) => c.json(await listLobby(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/decide", async (c) => c.json(await decideLobby(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, Decide), c.var.ip)))
    .patch("/:id/settings", async (c) => {
      const b = await parseBody(c, z.object({ guestsWait: z.boolean() }));
      return c.json(await setGuestsWait(c.var.deps, c.var.auth, c.req.param("id"), b.guestsWait, c.var.ip));
    });
}

export function publicMeetingLobbyRoutes() {
  return new Hono<AppEnv>()
    .get("/:token/here", async (c) => c.json(await whoIsHere(c.var.deps, c.req.param("token"))))
    .post("/:token", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { name?: unknown; lobbyId?: unknown };
      return c.json(await askToJoin(c.var.deps, c.req.param("token"), b?.name, c.var.ip ?? "", b?.lobbyId));
    })
    .get("/:token/:lobbyId", async (c) => {
      c.header("cache-control", "no-store");
      return c.json(await lobbyStatus(c.var.deps, c.req.param("token"), c.req.param("lobbyId")));
    });
}

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;

export const LOBBY_SHAPE = "{ meetingId, guestsWait, waiting: [{ id, name, status: pending, askedAt }] }";

export function registerMeetingLobbyV1Routes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "get", path: "/meetings/{id}/lobby", tags: ["Meetings"], summary: "Guests waiting to be let in",
    description: `The meeting's waiting room: guests who opened the guest link and are waiting for someone to let them in, oldest first. Requests older than 15 minutes are left out. Returns ${LOBBY_SHAPE}.`,
    security: [{ bearerAuth: [] }], request: { params: Id },
    responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 404: err("Not found.") },
  }), async (c) => send(c, await listLobby(c.var.deps, actor(c), c.req.param("id") ?? "")));
  api.openapi(createRoute({
    method: "post", path: "/meetings/{id}/lobby/decide", tags: ["Meetings"], summary: "Admit or deny waiting guests",
    description: "Admit or deny one waiting guest (lobbyId) or everyone waiting (all: true). An admitted guest gets into the call on their next check (within a few seconds); a denied guest sees a polite message. Recorded in the audit log. Returns { decided, status, ids }.",
    security: [{ bearerAuth: [] }], request: { params: Id, body: { content: { "application/json": { schema: Decide } }, required: true } },
    responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("Read only key."), 404: err("Not found."), 422: err("Invalid body.") },
  }), async (c) => send(c, await decideLobby(c.var.deps, actor(c), c.req.param("id") ?? "", c.req.valid("json"), c.var.ip)));
}

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerMeetingLobbyTools(server: McpServer, deps: Deps, a: Scoped, writable: () => void, tool: Tool) {
  const actorOf = a as unknown as SuiteActor;
  server.registerTool("meeting_lobby_list", {
    title: "Guests waiting to join a meeting", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "The meeting's waiting room: guests from the guest link waiting for someone to let them in (id, name, askedAt), oldest first, and whether guests wait at all (guestsWait).",
    inputSchema: { meetingId: zz.string().min(1) },
  }, tool(async (x: { meetingId: string }) => listLobby(deps, actorOf, x.meetingId)) as never);
  server.registerTool("meeting_lobby_decide", {
    title: "Admit or deny waiting guests", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Admit or deny one waiting guest (lobbyId from meeting_lobby_list) or everyone waiting (all: true). decision is admit or deny. Recorded in the audit log.",
    inputSchema: { meetingId: zz.string().min(1), lobbyId: zz.string().min(1).max(64).optional(), all: zz.boolean().optional(), decision: zz.enum(["admit", "deny"]) },
  }, tool(async (x: { meetingId: string; lobbyId?: string; all?: boolean; decision: "admit" | "deny" }) => { writable(); return decideLobby(deps, actorOf, x.meetingId, x); }) as never);
}

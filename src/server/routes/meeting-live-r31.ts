/**
 * Round 31: call notes and the "So far" digest. Cookie session at /api/meeting-live, the guest's
 * read only notes at /api/public/meeting-live/<token>/notes, the REST API (v1) and the MCP tool.
 */
import { Hono } from "hono";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as zz } from "zod";
import type { AppEnv, Deps } from "../context";
import { requireAuth } from "../middleware";
import type { SuiteActor } from "../services/suite/common";
import { guestNotes, startCallNotes, summarySoFar, writeSummarySoFar } from "../services/suite/meeting-live-r31";
import type { Scoped } from "./mcp-server";

export function meetingLiveRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .post("/:id/call-notes", async (c) => c.json(await startCallNotes(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/:id/so-far", async (c) => c.json(await summarySoFar(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/so-far/summary", async (c) => c.json(await writeSummarySoFar(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function publicMeetingLiveRoutes() {
  return new Hono<AppEnv>()
    .get("/:token/notes", async (c) => c.json(await guestNotes(c.var.deps, c.req.param("token"))));
}

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;

export const SO_FAR_SHAPE = "{ meetingId, title, kind: \"digest\", label: \"So far\", state: live | waiting | ended, startedAt, elapsedMin, participants: [{ name, joinedAt, minutesIn }], notes: { docId, title, headings, agenda, notes, todos: [{ text, done }] } | null, decisions: [{ text, by, at }], transcript: null, canWriteSummary, lateJoinMs, text }";

export function registerMeetingLiveV1Routes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "get", path: "/meetings/{id}/summary-so-far", tags: ["Meetings"], summary: "Summary so far of a live call or meeting",
    description: `A deterministic digest for someone joining late: who is in the call and since when, minutes elapsed, the notes doc's headings, lines and to-dos, and decisions said in the call's chat ("Decision: ...", "Agreed ..."). Returns ${SO_FAR_SHAPE}. No model is called. transcript is always null (recordings are transcribed after the call).`,
    security: [{ bearerAuth: [] }], request: { params: Id },
    responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 404: err("Not found.") },
  }), async (c) => send(c, await summarySoFar(c.var.deps, actor(c), c.req.param("id") ?? "")));
}

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerMeetingLiveTools(server: McpServer, deps: Deps, a: Scoped, _writable: () => void, tool: Tool) {
  const actorOf = a as unknown as SuiteActor;
  server.registerTool("meeting_summary_so_far", {
    title: "Summary so far of a live call", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "For a live call or meeting: who is in it and since when, minutes elapsed, the notes doc's headings and to-dos, and decisions said in the call's chat. A deterministic digest (no model call); text is the same as one plain block. transcript is always null.",
    inputSchema: { meetingId: zz.string().min(1) },
  }, tool(async (x: { meetingId: string }) => summarySoFar(deps, actorOf, x.meetingId)) as never);
}

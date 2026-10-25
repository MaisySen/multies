/**
 * Round 23 (R23.3) in the public API (v1): who is in a chat call right now. Read only; agents
 * can't start calls (people do, from chat).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { channelCallStatus, meetingCallStatus } from "../services/suite/calls";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;
const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";

export function registerCallRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (path: string, tag: string, summary: string, description: string) =>
    createRoute({ method: "get", path, tags: [tag], summary, description, security: [{ bearerAuth: [] }], request: { params: Id }, responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 404: err("Not found.") } });

  api.openapi(route("/chat/channels/{id}/call", "Chat", "Who is in a channel's call now", "Calls started in the channel or DM in the last 6 hours: { enabled, channelId, live: call | null, calls: [{ meetingId, title, state: live | waiting | ended, participants: [{ name }], count, startedAt, endedAt, durationMin }] }. enabled is false when video is off. Read from the video service and cached for about 10 seconds. 404 when the key can't open the channel (keys can't open DMs or private channels)."),
    async (c) => send(c, await channelCallStatus(c.var.deps, c.var.auth, pid(c))));
  api.openapi(route("/meetings/{id}/call", "Meetings", "Who is in a meeting now", "The same live status for one meeting: { enabled, meetingId, state, participants, count, startedAt, endedAt, durationMin }."),
    async (c) => send(c, await meetingCallStatus(c.var.deps, c.var.auth, pid(c))));
}

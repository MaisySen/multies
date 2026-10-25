/**
 * Round 23 (R23.2) in the public API (v1): a meeting's recordings with their summaries and
 * transcripts. Read only: a read only key can call it. Recording happens in the meeting room.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { listRecordings } from "../services/suite/meeting-recordings";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;

export function registerRecordingRoutes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "get", path: "/meetings/{id}/recordings", tags: ["Meetings"], summary: "A meeting's recordings and transcripts",
    description: "Newest first. Each recording has status (recording, processing, done or failed), startedBy, durationSec, summary, actionItems [{ text, assignee, due }] and transcript (capped at 200 KB; truncated says when it was cut). Calls are transcribed with the workspace's own OpenAI or Groq key; Multies keeps the text, not the audio.",
    security: [{ bearerAuth: [] }], request: { params: Id },
    responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 404: err("Not found.") },
  }), async (c) => send(c, { recordings: await listRecordings(c.var.deps, actor(c), c.req.param("id") ?? "") }));
}

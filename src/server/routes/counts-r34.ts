/**
 * R34: unread counts for badges. GET /api/counts (session) and GET /api/v1/counts (key), and the MCP tool get_counts.
 * Read-only, private 15 s cache, and an ETag so an unchanged poll answers 304 with no body. Query: tz (IANA zone for
 * "due today"; default UTC+10).
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as zod } from "zod";
import { Hono, type Context } from "hono";
import type { AppEnv, Deps } from "../context";
import { requireAuth } from "../middleware";
import { COUNTS_CACHE, countsEtag, getCounts } from "../services/counts-r34";
import type { SuiteActor } from "../services/suite/common";
import type { Scoped } from "./mcp-server";

async function answer(c: Context<AppEnv>) {
  const counts = await getCounts(c.var.deps, c.var.auth as unknown as SuiteActor, { tz: c.req.query("tz") });
  const etag = await countsEtag(counts);
  c.header("Cache-Control", COUNTS_CACHE);
  c.header("ETag", etag);
  c.header("Vary", "Authorization, Cookie");
  const inm = c.req.header("If-None-Match");
  if (inm && inm.split(",").map((s) => s.trim()).includes(etag)) return c.body(null, 304);
  return c.json(counts, 200);
}

export function countsRoutes() {
  return new Hono<AppEnv>().use("*", requireAuth).get("/", (c) => answer(c));
}

const N = z.number().int();
export const CountsSchema = z.object({
  mail: z.object({ inbox: N, important: N, other: N }),
  chat: z.object({ unread: N, mentions: N }),
  notifications: z.object({ unread: N }),
  triage: N,
  tasks: z.object({ dueToday: N, overdue: N }),
  at: z.string(),
}).openapi("Counts");

export function registerCountsR34Routes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "get", path: "/counts", tags: ["Counts"], summary: "Unread counts for badges",
    description: "Every unread count for the key's owner in one cheap read: { mail: { inbox, important, other }, chat: { unread, mentions }, notifications: { unread }, triage, tasks: { dueToday, overdue }, at }. Agent keys get 0 for mail, chat and notifications. Query: tz (an IANA zone for due today; default UTC+10). Private, cached 15 s, with an ETag: send If-None-Match to get a 304 when nothing changed.",
    security: [{ bearerAuth: [] }],
    request: { query: z.object({ tz: z.string().max(64).optional() }) },
    responses: { 200: { description: "OK.", content: { "application/json": { schema: CountsSchema } } }, 304: { description: "Not modified." }, 401: { description: "Missing or invalid API key." } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }), (async (c: Context<AppEnv>) => answer(c)) as any);
}

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
export function registerCountsR34Tools(server: McpServer, deps: Deps, actor: Scoped, tool: Tool) {
  server.registerTool("get_counts", {
    title: "Unread counts", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Your unread counts in one read: mail { inbox, important, other }, chat { unread, mentions }, notifications { unread }, triage (items waiting), tasks { dueToday, overdue } (assigned to you). tz is an IANA zone for due today (default UTC+10).",
    inputSchema: { tz: zod.string().max(64).optional() },
  }, tool(async (x: { tz?: string }) => getCounts(deps, actor as unknown as SuiteActor, { tz: x.tz })) as never);
}

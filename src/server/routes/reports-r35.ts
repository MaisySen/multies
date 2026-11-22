/**
 * R35 (Apple 1.2): reports and blocks.
 * Session: POST /api/reports, GET/POST /api/blocks, DELETE /api/blocks/:userId.
 * Public API (key): the same under /api/v1 with OpenAPI entries. MCP: create_report, list_blocks, add_block, remove_block.
 * Operator console: /api/console/moderation/reports (routes/console/moderation.ts); GET /api/admin/reports/count for the nav badge.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as zod } from "zod";
import { Hono, type Context } from "hono";
import type { AppEnv, Deps } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { operatorSession, requireOperator } from "../auth/operator"; // OPS1
import { HttpError } from "../lib/errors";
import type { SuiteActor } from "../services/suite/common";
import { addBlock, createReport, listBlocks, openReportCount, removeBlock, REPORT_CONTEXTS, REPORT_REASONS } from "../services/suite/reports-r35";
import type { Scoped } from "./mcp-server";
import { idempotentCreate } from "../lib/idempotency"; // R54 (MB-239)
import { mcpCreate } from "./mcp-idempotency"; // R54 (MB-239)

export const ReportBody = zod.object({
  targetType: zod.enum(["message", "user"]),
  messageId: zod.string().min(1).max(64).optional(),
  userId: zod.string().min(1).max(64).optional(),
  context: zod.enum(REPORT_CONTEXTS).optional(),
  reason: zod.enum(REPORT_REASONS),
  note: zod.string().max(500).optional(),
}).refine((b) => (b.targetType === "message" ? !!b.messageId : !!b.userId), { message: "Say which message or person." });
export const BlockBody = zod.object({ userId: zod.string().min(1).max(64) });

const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;

async function block(c: Context<AppEnv>, userId: string) {
  const r = await addBlock(c.var.deps, actor(c), userId);
  return c.json({ blocked: true, userId, blocks: r.blocks }, r.created ? 201 : 200);
}

export function reportsRoutes() {
  return new Hono<AppEnv>().use("*", requireAuth)
    .post("/", async (c) => c.json(await createReport(c.var.deps, actor(c), await parseBody(c, ReportBody)), 201));
}

export function blocksRoutes() {
  return new Hono<AppEnv>().use("*", requireAuth)
    .get("/", async (c) => c.json(await listBlocks(c.var.deps, actor(c))))
    .post("/", async (c) => block(c, (await parseBody(c, BlockBody)).userId))
    .delete("/:userId", async (c) => { await removeBlock(c.var.deps, actor(c), c.req.param("userId")); return c.body(null, 204); });
}

/**
 * The open report count for the operator nav badge (src/web/lib/open-report-count.ts). OPS1 security: the older list
 * and action routes were retired; the queue and its actions live at /api/console/moderation (reason, step up and
 * target rules). Every other /api/admin/reports path answers 404.
 */
export function adminReportsRoutes() {
  return new Hono<AppEnv>()
    .get("/count", operatorSession, requireOperator("moderation.read"), async (c) => c.json(await openReportCount(c.var.deps)));
}

// ---------------------------------------------------------------- public API (v1)

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const BlockSchema = z.object({ userId: z.string(), name: z.string(), avatarUrl: z.string().nullable(), createdAt: z.string() }).openapi("Block");
const BlocksSchema = z.object({ blocks: z.array(BlockSchema) }).openapi("Blocks");
const ReportReqSchema = z.object({
  targetType: z.enum(["message", "user"]), messageId: z.string().optional(), userId: z.string().optional(),
  context: z.enum(REPORT_CONTEXTS).optional(), reason: z.enum(REPORT_REASONS), note: z.string().max(500).optional(),
}).openapi("ReportRequest");

export function registerReportsR35Routes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "post", path: "/reports", tags: ["Moderation"], summary: "Report a chat message or a person", security: [{ bearerAuth: [] }],
    description: "Body: { targetType: message | user, messageId? (for message), userId? (for user), context?: chat | meeting | dm, reason: spam | harassment | hate | sexual | violence | self_harm | other, note? (up to 500) }. Answers 201 { id, status: open }. A message report keeps a copy of the text and author at report time. 20 reports per person a day (429). A message you can't see, or yourself, is 404. The operator reviews reports within one business day.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: { body: { content: { "application/json": { schema: ReportReqSchema as any } } } },
    responses: { 201: { description: "Filed.", content: { "application/json": { schema: z.object({ id: z.string(), status: z.literal("open") }) } } }, 401: err("Missing or invalid API key."), 404: err("No such message or person."), 422: err("Validation failed."), 429: err("Too many reports today.") },
  }),
  async (c) => {
    const parsed = ReportBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(422, "validation_failed", parsed.error.issues[0]?.message ?? "Check the report.", parsed.error.issues);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json(await createReport(c.var.deps, actor(c), parsed.data, await idempotentCreate(c.req.raw, "rpt")) as any, 201) as any;
  });

  api.openapi(createRoute({
    method: "get", path: "/blocks", tags: ["Moderation"], summary: "People you blocked", security: [{ bearerAuth: [] }],
    description: "Answers { blocks: [{ userId, name, avatarUrl, createdAt }] }, newest first. Their chat messages are left out of everything you read, and they can't message you.",
    responses: { 200: { description: "OK.", content: { "application/json": { schema: BlocksSchema } } }, 401: err("Missing or invalid API key.") },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }), (async (c: Context<AppEnv>) => c.json(await listBlocks(c.var.deps, actor(c)), 200)) as any);

  api.openapi(createRoute({
    method: "post", path: "/blocks", tags: ["Moderation"], summary: "Block a person", security: [{ bearerAuth: [] }],
    description: "Body: { userId }. 201 when blocked now, 200 when already blocked. Blocking yourself is 400. The person is not told.",
    request: { body: { content: { "application/json": { schema: z.object({ userId: z.string() }) } } } },
    responses: { 200: { description: "Already blocked.", content: { "application/json": { schema: z.object({ blocked: z.boolean(), userId: z.string(), blocks: z.array(BlockSchema) }) } } }, 201: { description: "Blocked.", content: { "application/json": { schema: z.object({ blocked: z.boolean(), userId: z.string(), blocks: z.array(BlockSchema) }) } } }, 400: err("You can't block yourself."), 401: err("Missing or invalid API key."), 404: err("No such person.") },
  }),
  async (c) => {
    const parsed = BlockBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(422, "validation_failed", "Say who to block.", parsed.error.issues);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return block(c as any, parsed.data.userId) as any;
  });

  api.openapi(createRoute({
    method: "delete", path: "/blocks/{userId}", tags: ["Moderation"], summary: "Unblock a person", security: [{ bearerAuth: [] }],
    description: "Answers 204, or 404 when you had not blocked that person.",
    request: { params: z.object({ userId: z.string() }) },
    responses: { 204: { description: "Unblocked." }, 401: err("Missing or invalid API key."), 404: err("You had not blocked this person.") },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (async (c: Context<AppEnv>) => { await removeBlock(c.var.deps, actor(c), c.req.param("userId")!); return c.body(null, 204); }) as any);
}

// ---------------------------------------------------------------- MCP

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
export function registerReportsR35Tools(server: McpServer, deps: Deps, actorIn: Scoped, writable: () => void, tool: Tool) {
  const a = actorIn as unknown as SuiteActor;
  server.registerTool("create_report", {
    title: "Report a message or person", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Reports a chat message (targetType message, messageId) or a person (targetType user, userId) to the Multies team. reason: spam, harassment, hate, sexual, violence, self_harm or other; note up to 500 characters; context chat, meeting or dm. Answers { id, status: open }. 20 a day.",
    inputSchema: { targetType: zod.enum(["message", "user"]), messageId: zod.string().max(64).optional(), userId: zod.string().max(64).optional(), context: zod.enum(REPORT_CONTEXTS).optional(), reason: zod.enum(REPORT_REASONS), note: zod.string().max(500).optional() },
  }, tool(async (x: zod.infer<typeof ReportBody>) => { writable(); return createReport(deps, a, ReportBody.parse(x), await mcpCreate("rpt")); }) as never);
  server.registerTool("list_blocks", {
    title: "People you blocked", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "The people this key's owner blocked: { blocks: [{ userId, name, avatarUrl, createdAt }] }.",
    inputSchema: {},
  }, tool(async () => listBlocks(deps, a)) as never);
  server.registerTool("add_block", {
    title: "Block a person", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Blocks a person (userId): their chat messages are hidden from you and they can't message you. They are not told. Answers { blocked, created, blocks }.",
    inputSchema: { userId: zod.string().min(1).max(64) },
  }, tool(async (x: { userId: string }) => { writable(); const r = await addBlock(deps, a, x.userId); return { blocked: true, created: r.created, blocks: r.blocks }; }) as never);
  server.registerTool("remove_block", {
    title: "Unblock a person", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Unblocks a person (userId). Answers { ok: true }, or not_found when you had not blocked them.",
    inputSchema: { userId: zod.string().min(1).max(64) },
  }, tool(async (x: { userId: string }) => { writable(); return removeBlock(deps, a, x.userId); }) as never);
}

/**
 * Round 22 (R22.1 and R22.5): thread assignment, done or open, and reply times in the web app (cookie
 * session). The thread list views ride GET /api/agents/threads?view=. The same services back the REST
 * API (v1-r22-assign.ts) and the MCP tools (mcp-r22-assign.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import type { SuiteActor } from "../services/suite/common";
import { assignableMembers, assignThread, getThreadState, replyStats, setThreadStatus, THREAD_STATUSES, THREAD_VIEWS } from "../services/mail/thread-state";

export const ThreadViewQuery = z.object({ view: z.enum(THREAD_VIEWS).optional(), assignee: z.string().max(64).optional() });
export const AssignBody = z.object({ userId: z.string().min(1).max(64).nullable() });
export const StatusBody = z.object({ status: z.enum(THREAD_STATUSES) });
export const StatsQuery = z.object({
  mailboxId: z.string().max(64).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  groupBy: z.enum(["mailbox", "person"]).optional(),
});

export function threadStateRoutes() {
  const actor = (c: { var: { auth: unknown } }) => c.var.auth as SuiteActor;
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/stats/replies", async (c) => c.json(await replyStats(c.var.deps, actor(c), parseQuery(c, StatsQuery))))
    .get("/:id/state", async (c) => {
      const state = await getThreadState(c.var.deps, actor(c), c.req.param("id"));
      return c.json({ state, members: await assignableMembers(c.var.deps, actor(c), c.req.param("id")) });
    })
    .post("/:id/assign", async (c) => c.json({ state: await assignThread(c.var.deps, actor(c), c.req.param("id"), (await parseBody(c, AssignBody)).userId) }))
    .post("/:id/status", async (c) => c.json({ state: await setThreadStatus(c.var.deps, actor(c), c.req.param("id"), (await parseBody(c, StatusBody)).status) }));
}

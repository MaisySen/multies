/**
 * R27 (DF-3 slice 2): agent runs in the app (cookie session). People read a task's runs on the task panel, queue a
 * run for an agent member and cancel one. Agents start, log and finish runs with their own key through REST
 * (v1-r27-agent-runs.ts) or MCP (mcp-r27-agent-runs.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { finishRun, getRun, listRuns, listTaskRuns, RUN_RESULT_MAX, RUN_STEP_KINDS, RUN_STEP_TEXT_MAX, startRun } from "../services/suite/agent-runs";

export const RunStartBody = z.object({
  agentUserId: z.string().min(1).max(80).optional(),
  moveToDoing: z.boolean().optional(),
  note: z.string().max(RUN_STEP_TEXT_MAX).optional(),
});
export const RunStepBody = z.object({ kind: z.enum(RUN_STEP_KINDS).default("note"), text: z.string().min(1).max(RUN_STEP_TEXT_MAX) });
export const RunFinishBody = z.object({
  status: z.enum(["succeeded", "failed", "cancelled"]),
  result: z.string().max(RUN_RESULT_MAX).nullable().optional(),
  moveTo: z.enum(["done", "review"]).nullable().optional(),
  comment: z.boolean().optional(),
});

/** /api/tasks/:id/runs (mounted before taskRoutes). */
export function agentRunTaskRoutes() {
  return new Hono<AppEnv>()
    .use("/:id/runs", requireAuth)
    .get("/:id/runs", async (c) => c.json(await listTaskRuns(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/runs", async (c) => c.json({ run: await startRun(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, RunStartBody)) }, 201));
}

/** /api/agent-runs and /api/agent-runs/:id */
export function agentRunRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    // R29: the workspace's runs, newest first, for the mobile Runs screen (the v1 GET /runs needs a key).
    .get("/", async (c) => c.json(await listRuns(c.var.deps, c.var.auth, { agentUserId: c.req.query("agentUserId") || undefined, status: c.req.query("status") || undefined, limit: Number(c.req.query("limit")) || undefined })))
    .get("/:id", async (c) => c.json({ run: await getRun(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/:id/cancel", async (c) => c.json(await finishRun(c.var.deps, c.var.auth, c.req.param("id"), { status: "cancelled" })));
}

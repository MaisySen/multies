/**
 * R90: the automation builder under /api/flows (cookie session). Everyone in the workspace can see flows
 * and runs; admins create, change, run and retry them (like rules). Approvals are decided by the person
 * the step names, or by an admin. Switched off with FLOWS=off.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import {
  cancelRun, createFlow, decideApproval, deleteFlow, getFlow, getRun, listApprovals, listFlows, listRuns, retryRun, runNow, updateFlow,
} from "../services/suite/flows";
import { checkFlowNow } from "../services/suite/flow-watch";
import { MAX_NODES, type FlowGraph } from "@/shared/flows";

const nodeSchema = z.object({
  id: z.string().min(1).max(40), kind: z.enum(["trigger", "condition", "wait", "approval", "action", "stop"]), label: z.string().max(80).optional(),
  config: z.record(z.string(), z.unknown()).default({}), x: z.number().finite().default(0), y: z.number().finite().default(0),
});
const edgeSchema = z.object({ id: z.string().min(1).max(100), from: z.string().min(1).max(40), to: z.string().min(1).max(40), branch: z.enum(["next", "yes", "no", "error"]).default("next") });
const graphSchema = z.object({ nodes: z.array(nodeSchema).max(MAX_NODES), edges: z.array(edgeSchema).max(MAX_NODES * 3) });
const createSchema = z.object({ name: z.string().min(1).max(80), description: z.string().max(300).optional(), graph: graphSchema });
const patchSchema = z.object({ name: z.string().min(1).max(80).optional(), description: z.string().max(300).nullable().optional(), graph: graphSchema.optional(), enabled: z.boolean().optional() });
const decideSchema = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(500).optional() });
const runSchema = z.object({ note: z.string().max(300).optional() });

export function flowRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await listFlows(c.var.deps, c.var.auth.orgId)))
    .post("/", requireAdmin, async (c) => c.json(await createFlow(c.var.deps, c.var.auth, (await parseBody(c, createSchema)) as { name: string; description?: string; graph: FlowGraph }), 201))
    .get("/runs", async (c) => c.json(await listRuns(c.var.deps, c.var.auth.orgId, { flowId: c.req.query("flowId") || undefined, status: c.req.query("status") || undefined, before: c.req.query("before") || undefined, limit: Number(c.req.query("limit") ?? 50) || 50 })))
    .get("/approvals", async (c) => c.json(await listApprovals(c.var.deps, c.var.auth)))
    .get("/runs/:runId", async (c) => c.json(await getRun(c.var.deps, c.var.auth.orgId, c.req.param("runId"))))
    .post("/runs/:runId/retry", requireAdmin, async (c) => c.json(await retryRun(c.var.deps, c.var.auth, c.req.param("runId"))))
    .post("/runs/:runId/cancel", requireAdmin, async (c) => c.json(await cancelRun(c.var.deps, c.var.auth, c.req.param("runId"))))
    .post("/runs/:runId/decide", async (c) => { const b = await parseBody(c, decideSchema); return c.json(await decideApproval(c.var.deps, c.var.auth, c.req.param("runId"), b.decision, b.note)); })
    .get("/:id", async (c) => c.json(await getFlow(c.var.deps, c.var.auth.orgId, c.req.param("id"))))
    .patch("/:id", requireAdmin, async (c) => c.json(await updateFlow(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, patchSchema)) as { name?: string; description?: string | null; graph?: FlowGraph; enabled?: boolean })))
    .delete("/:id", requireAdmin, async (c) => c.json(await deleteFlow(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/run", requireAdmin, async (c) => c.json(await runNow(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, runSchema)).note)))
    .post("/:id/check", requireAdmin, async (c) => c.json(await checkFlowNow(c.var.deps, c.var.auth.orgId, c.req.param("id"))));
}

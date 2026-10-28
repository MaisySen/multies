/**
 * R27 (DF-3 slice 2): agent runs over MCP. An AI agent member's key starts a run on a task it is assigned to or
 * mentioned on, logs steps and finishes it; any key of the workspace can list runs. The same service backs the app
 * and REST (v1-r27-agent-runs.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { addRunStep, cancelRun, finishRun, listRuns, listTaskRuns, RUN_CANCEL_REASON_MAX, RUN_RESULT_MAX, RUN_STEP_KINDS, RUN_STEP_TEXT_MAX, startRun } from "../services/suite/agent-runs";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerAgentRunTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("start_task_run", {
    title: "Start working on a task (agent run)", annotations: rw,
    description: "With an AI agent member's key: starts your run on a task you are assigned to or mentioned on (or claims a run a person queued for you), so your steps and result show on the task. moveToDoing moves the task to a doing status. With a person's or workspace key: queues a run for agentUserId. One queued or running run per agent and task. Returns the run; keep its id for add_run_step and finish_task_run.",
    inputSchema: { taskId: z.string().min(1).describe("A task id or a reference like OPS-12."), moveToDoing: z.boolean().optional(), note: z.string().max(RUN_STEP_TEXT_MAX).optional().describe("An optional first step."), agentUserId: z.string().max(80).optional().describe("Only when queuing a run for an agent with a person's or workspace key.") },
  }, tool(async (x: { taskId: string; moveToDoing?: boolean; note?: string; agentUserId?: string }) => {
    writable();
    return { run: await startRun(deps, a, x.taskId, { moveToDoing: x.moveToDoing, note: x.note, agentUserId: x.agentUserId }) };
  }) as never);

  server.registerTool("add_run_step", {
    title: "Log a step in your run", annotations: rw,
    description: `Appends one step to your run: kind is ${RUN_STEP_KINDS.join(", ")}; text up to ${RUN_STEP_TEXT_MAX} characters. A run holds up to 200 steps. Only the run's own agent can log steps.`,
    inputSchema: { runId: z.string().min(1), kind: z.enum(RUN_STEP_KINDS).default("note"), text: z.string().min(1).max(RUN_STEP_TEXT_MAX) },
  }, tool(async (x: { runId: string; kind: (typeof RUN_STEP_KINDS)[number]; text: string }) => {
    writable();
    return addRunStep(deps, a, x.runId, { kind: x.kind, text: x.text });
  }) as never);

  server.registerTool("finish_task_run", {
    title: "Finish your run", annotations: rw,
    description: "Finishes a run with status succeeded, failed or cancelled and a short result. moveTo moves the task to done or to its review status; comment posts the result as your comment on the task. A person's or workspace key can only cancel.",
    inputSchema: { runId: z.string().min(1), status: z.enum(["succeeded", "failed", "cancelled"]), result: z.string().max(RUN_RESULT_MAX).optional(), moveTo: z.enum(["done", "review"]).optional(), comment: z.boolean().optional() },
  }, tool(async (x: { runId: string; status: "succeeded" | "failed" | "cancelled"; result?: string; moveTo?: "done" | "review"; comment?: boolean }) => {
    writable();
    return finishRun(deps, a, x.runId, { status: x.status, result: x.result, moveTo: x.moveTo, comment: x.comment });
  }) as never);

  server.registerTool("list_task_runs", {
    title: "List agent runs", annotations: ro,
    description: "With taskId: that task's runs, newest first, with steps and results. Without: runs across the workspace (no steps), filtered by agentUserId and status.",
    inputSchema: { taskId: z.string().optional(), agentUserId: z.string().max(80).optional(), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(), limit: z.number().int().min(1).max(200).optional() },
  }, tool(async (x: { taskId?: string; agentUserId?: string; status?: "queued" | "running" | "succeeded" | "failed" | "cancelled"; limit?: number }) =>
    x.taskId ? listTaskRuns(deps, a, x.taskId, { limit: x.limit }) : listRuns(deps, a, { agentUserId: x.agentUserId, status: x.status, limit: x.limit })) as never);

  // R30: cancel a run (the same rules as POST /api/v1/runs/{id}/cancel).
  server.registerTool("agent_run_cancel", {
    title: "Cancel an agent run", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: `Cancels a queued or running run so no agent picks it up or keeps working on it. A person's key, a full workspace key, or the run's own agent key can; another agent's key can't. reason (up to ${RUN_CANCEL_REASON_MAX} characters) is kept as the run's result. A finished run is refused (run_finished); an already cancelled run comes back unchanged. Returns { run }.`,
    inputSchema: { runId: z.string().min(1).max(80), reason: z.string().max(RUN_CANCEL_REASON_MAX).optional() },
  }, tool(async (x: { runId: string; reason?: string }) => {
    writable();
    return cancelRun(deps, a, x.runId, { reason: x.reason });
  }) as never);
}

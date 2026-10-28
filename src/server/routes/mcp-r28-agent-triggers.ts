/**
 * R28 (DF-3 slice 3): agent run triggers over MCP: list, create and delete (R30: and read a trigger's history). Admin and full workspace keys only; the
 * same service backs the app and REST (v1-r28-agent-triggers.ts). A webhook trigger's secret is returned once.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { DAYS } from "../services/suite/scheduling";
import { createTrigger, deleteTrigger, HISTORY_LIMIT, listTriggers, triggerHistory, TRIGGER_INSTRUCTIONS_MAX, TRIGGER_TITLE_MAX } from "../services/suite/agent-triggers";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
type CreateArgs = {
  agentUserId: string; kind: "schedule" | "webhook"; name: string; taskId?: string; projectId?: string; titleTemplate?: string; instructions?: string;
  everyHours?: number; dailyAt?: string; days?: (typeof DAYS)[number][]; timezone?: string; enabled?: boolean;
};

export function registerAgentTriggerTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;

  server.registerTool("list_agent_triggers", {
    title: "List agent run triggers", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "The workspace's triggers that queue runs for AI agent members (at most 20): kind schedule or webhook, the agent, the task or project, next run, last fired. Admin and workspace keys only.",
    inputSchema: { agentUserId: z.string().max(80).optional() },
  }, tool(async (x: { agentUserId?: string }) => listTriggers(deps, a, { agentUserId: x.agentUserId })) as never);

  server.registerTool("create_agent_trigger", {
    title: "Create an agent run trigger", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Queues runs for an AI agent member on a schedule (everyHours of 1 or more, or dailyAt HH:MM in the workspace zone with optional days) or when a signed webhook arrives (the answer holds the URL and the secret, shown once). Name a task (taskId) or a project (projectId) with a titleTemplate ({trigger}, {date}, {datetime}) for a new task each time. instructions travel with each run. Limits: 20 triggers per workspace, 3 queued runs per agent.",
    inputSchema: {
      agentUserId: z.string().min(1).max(80), kind: z.enum(["schedule", "webhook"]), name: z.string().min(1).max(80),
      taskId: z.string().max(80).optional(), projectId: z.string().max(80).optional(), titleTemplate: z.string().max(TRIGGER_TITLE_MAX).optional(),
      instructions: z.string().max(TRIGGER_INSTRUCTIONS_MAX).optional(), everyHours: z.number().int().min(1).max(744).optional(),
      dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), days: z.array(z.enum(DAYS)).max(7).optional(), timezone: z.string().max(64).optional(), enabled: z.boolean().optional(),
    },
  }, tool(async (x: CreateArgs) => {
    writable();
    return createTrigger(deps, a, x);
  }) as never);

  server.registerTool("delete_agent_trigger", {
    title: "Delete an agent run trigger", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description: "Deletes a trigger; its webhook stops at once. Runs it already queued stay.",
    inputSchema: { triggerId: z.string().min(1).max(80) },
  }, tool(async (x: { triggerId: string }) => {
    writable();
    return deleteTrigger(deps, a, x.triggerId);
  }) as never);

  // R30: the History the Triggers dialog shows (R29), over MCP. Same service and rules as GET /api/v1/agent-triggers/{id}/history.
  server.registerTool("agent_trigger_history", {
    title: "Read an agent trigger's history", annotations: { readOnlyHint: true, openWorldHint: false },
    description: `A trigger's recent fires and refusals, newest first: outcome (fired or refused), source (schedule, webhook or manual), reason and message on a refusal, the run it queued with its task, who fired it, and when. limit is 1 to ${HISTORY_LIMIT} (default 20). Admin and workspace keys only.`,
    inputSchema: { triggerId: z.string().min(1).max(80), limit: z.number().int().min(1).max(HISTORY_LIMIT).optional() },
  }, tool(async (x: { triggerId: string; limit?: number }) => triggerHistory(deps, a, x.triggerId, { limit: x.limit ?? 20 })) as never);
}

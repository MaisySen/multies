/**
 * Round 21 (R21.1): sprints on MCP. Read only keys and read only OAuth tokens can list and read
 * sprints and their burndown but not change anything.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { addToSprint, completeSprint, createSprint, getSprint, listSprints, removeFromSprint, startSprint } from "../services/suite/sprints";
import type { SuiteActor } from "../services/suite/common";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerSprintTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const taskIds = z.array(z.string().min(1).max(64)).min(1).max(500).describe("Task ids or references like OPS-12, up to 500, all in the sprint's project.");

  server.registerTool("list_sprints", {
    title: "List sprints", annotations: ro,
    description: "A project's sprints (planned, active, completed), oldest first, with task and point counts, and the project's estimate unit.",
    inputSchema: { projectId: z.string().min(1) },
  }, tool(async (x: { projectId: string }) => listSprints(deps, a, x.projectId)) as never);

  server.registerTool("get_sprint", {
    title: "Get a sprint", annotations: ro,
    description: "One sprint with its tasks and burndown: per day, the points (or tasks when nothing is estimated) left at the end of that day, and the ideal line.",
    inputSchema: { id: z.string().min(1), timeZone: z.string().max(64).optional().describe("IANA zone for day lines. Defaults to the person's or workspace's zone.") },
  }, tool(async (x: { id: string; timeZone?: string }) => getSprint(deps, a, x.id, { timeZone: x.timeZone })) as never);

  server.registerTool("create_sprint", {
    title: "Plan a sprint", annotations: rw,
    description: "Plan a sprint in a project. Defaults: Sprint N, starting the day after the last sprint ends (or today), two weeks long.",
    inputSchema: {
      projectId: z.string().min(1), name: z.string().max(80).optional(), goal: z.string().max(2000).optional(),
      startAt: z.string().max(40).optional().describe("ISO date or time, e.g. 2026-11-02."), endAt: z.string().max(40).optional(),
    },
  }, tool(async (x: { projectId: string; name?: string; goal?: string; startAt?: string; endAt?: string }) => {
    writable();
    return { sprint: await createSprint(deps, a, x.projectId, x) };
  }) as never);

  server.registerTool("start_sprint", {
    title: "Start a sprint", annotations: rw,
    description: "Start a planned sprint. A project has one active sprint at a time.",
    inputSchema: { id: z.string().min(1) },
  }, tool(async (x: { id: string }) => {
    writable();
    return { sprint: await startSprint(deps, a, x.id) };
  }) as never);

  server.registerTool("complete_sprint", {
    title: "Complete a sprint", annotations: rw,
    description: "Complete the active sprint. Unfinished tasks carry over to the next planned sprint (made if there is none) or to the backlog. Done tasks stay.",
    inputSchema: { id: z.string().min(1), carryOver: z.enum(["next", "backlog"]).optional().describe("Where unfinished tasks go. Default next.") },
  }, tool(async (x: { id: string; carryOver?: "next" | "backlog" }) => {
    writable();
    return completeSprint(deps, a, x.id, { carryOver: x.carryOver });
  }) as never);

  server.registerTool("add_to_sprint", {
    title: "Add tasks to a sprint", annotations: rw,
    description: "Move tasks into a planned or active sprint (from the backlog or another sprint).",
    inputSchema: { id: z.string().min(1).describe("The sprint id."), taskIds },
  }, tool(async (x: { id: string; taskIds: string[] }) => {
    writable();
    return addToSprint(deps, a, x.id, x.taskIds);
  }) as never);

  server.registerTool("remove_from_sprint", {
    title: "Remove tasks from a sprint", annotations: rw,
    description: "Move tasks out of a sprint, back to the project's backlog.",
    inputSchema: { id: z.string().min(1).describe("The sprint id."), taskIds },
  }, tool(async (x: { id: string; taskIds: string[] }) => {
    writable();
    return removeFromSprint(deps, a, x.id, x.taskIds);
  }) as never);
}

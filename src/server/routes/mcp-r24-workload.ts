/**
 * R24.2 Workload in MCP: get_workload, for questions like "who is overloaded next week". A read,
 * so read only keys and tokens can call it.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { getWorkload, MAX_WEEKS } from "../services/suite/workload";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerWorkloadTools(server: McpServer, deps: Deps, actor: Scoped, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("get_workload", {
    title: "Workload per person per week", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Open tasks and estimates per person (plus Unassigned) per week, Monday first, with a capacity flag. overloaded lists each person and week over capacity (default 20 points or 40 hours a week; pass capacity to change it). A task sits in the week of its due date, or its start date when it has none; overdue holds open tasks due before the range. Use from (a date) and weeks (1 to 12) to pick the range, for example from next Monday with weeks 1 for next week.",
    inputSchema: {
      from: z.string().max(40).optional().describe("A date like 2026-11-02; the range starts on the Monday of its week. Default this week."),
      weeks: z.number().int().min(1).max(MAX_WEEKS).default(4),
      projectIds: z.array(z.string().min(1).max(64)).max(50).optional(),
      sprintId: z.string().max(64).optional(),
      people: z.array(z.string().regex(/^(member|agent):[A-Za-z0-9_-]+$|^none$/)).max(50).optional().describe("member:<id>, agent:<id> or none."),
      unit: z.enum(["points", "hours"]).default("points"),
      capacity: z.number().positive().max(10_000).optional(),
      tz: z.string().max(64).optional().describe("An IANA zone; default the workspace zone."),
      includeTasks: z.boolean().default(false).describe("Include each cell's task list; off by default to keep the answer short."),
    },
  }, tool(async (x: { from?: string; weeks: number; projectIds?: string[]; sprintId?: string; people?: string[]; unit: "points" | "hours"; capacity?: number; tz?: string; includeTasks: boolean }) => {
    const w = await getWorkload(deps, a, x);
    if (x.includeTasks) return w;
    const strip = <T extends { tasks: unknown[] }>(c: T) => { const { tasks: _t, ...rest } = c; void _t; return rest; };
    return { ...w, people: w.people.map((p) => ({ ...p, overdue: strip(p.overdue), weeks: p.weeks.map(strip) })) };
  }) as never);
}

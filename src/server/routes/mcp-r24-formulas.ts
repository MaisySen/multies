/**
 * R24.1 Formula and rollup fields on MCP. get_computed_fields reads (read only keys can call it);
 * create_formula_field and create_rollup_field define a field and need a write key.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { HttpError } from "../lib/errors";
import { mcpCreate } from "./mcp-idempotency"; // R53 (MB-239)
import type { SuiteActor } from "../services/suite/common";
import { projectRollups, taskComputed } from "../services/suite/computed";
import { createField } from "../services/suite/fields";
import { ROLLUP_FNS, ROLLUP_SOURCES } from "../services/suite/formula-config";
import { getTask } from "../services/suite/tasks";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerFormulaTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("get_computed_fields", {
    title: "Read formula and rollup values", annotations: ro,
    description: "With taskId (an id or a reference like OPS-12): each formula and rollup field on the task's project with its value. With projectId: the project level rollups over its tasks. A value that can't be worked out is \"#ERROR\" with an error message. Computed when read; nothing is stored.",
    inputSchema: { taskId: z.string().min(1).max(64).optional(), projectId: z.string().min(1).max(64).optional() },
  }, tool(async (x: { taskId?: string; projectId?: string }) => {
    if (x.taskId) { const t = await getTask(deps, a, x.taskId); return taskComputed(deps, t, a.orgId); }
    if (x.projectId) return projectRollups(deps, a, x.projectId);
    throw new HttpError(422, "validation_failed", "Pass taskId or projectId.");
  }) as never);

  server.registerTool("create_formula_field", {
    title: "Add a formula field to a project", annotations: rw,
    description: "A read only field worked out from other values, like {Budget} * 1.1 or if({points} > 5, \"big\", \"small\"). Field names go in braces; built ins: points, due, start, created, completed, status, priority, title, assignee. Functions: if, round, floor, ceil, abs, min, max, sum, concat, len, upper, lower, days_between, today, now, date_add, is_empty, coalesce. Up to 500 characters.",
    inputSchema: { projectId: z.string().min(1).max(64), name: z.string().min(1).max(60), expression: z.string().min(1).max(500) },
  }, tool(async (x: { projectId: string; name: string; expression: string }) => {
    writable();
    return { field: await createField(deps, a, x.projectId, { name: x.name, type: "formula", config: { expression: x.expression } }, await mcpCreate("fld")) };
  }) as never);

  server.registerTool("create_rollup_field", {
    title: "Add a rollup field to a project", annotations: rw,
    description: "Aggregates child tasks: source subtasks (a task's subtasks), epic_children (an epic's items and their subtasks) or project (one value over the whole project, shown in its header). fn: sum, count, count_done, average, min, max or percent_done. field: points, or a number, currency or formula field id or name (not needed for count, count_done and percent_done).",
    inputSchema: {
      projectId: z.string().min(1).max(64), name: z.string().min(1).max(60),
      source: z.enum(ROLLUP_SOURCES), fn: z.enum(ROLLUP_FNS), field: z.string().max(64).optional(),
    },
  }, tool(async (x: { projectId: string; name: string; source: (typeof ROLLUP_SOURCES)[number]; fn: (typeof ROLLUP_FNS)[number]; field?: string }) => {
    writable();
    return { field: await createField(deps, a, x.projectId, { name: x.name, type: "rollup", config: { source: x.source, fn: x.fn, field: x.field ?? null } }, await mcpCreate("fld")) };
  }) as never);
}

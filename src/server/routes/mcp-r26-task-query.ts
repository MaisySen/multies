/**
 * R26 (MB-86): search_tasks over MCP with the task query language (src/shared/task-query.ts). Read only keys can
 * use it. A bad query comes back as an error naming the problem and the character where it starts.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { listTasks } from "../services/suite/tasks";
import { applyTaskQuery, wantsSubtasks } from "../services/suite/task-query";
import { QUERY_MAX_LENGTH } from "../../shared/task-query";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerTaskQueryTools(server: McpServer, deps: Deps, actor: Scoped, _writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("search_tasks", {
    title: "Search tasks with a query", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Finds tasks with the task query language. Terms are ANDed, commas mean any of, a leading minus negates, quotes keep words together. Keys: assignee (me, none, a name or email), status (todo, doing, done, open or a status name), label, priority (urgent, high, medium, low, none; >= works), due (today, 2026-11-02, 7d, -3d, none; < and > work), sprint (current, next, none or a name), type (task, story, bug, epic), project (key or name), created and updated (a date or 7d meaning 7 days ago), points (>=3, none), has (subtasks, checklist, due, assignee, labels, points, parent, notes), is (overdue, open, done, unassigned, subtask, mine), title. Example: assignee:me status:doing label:bug due:<7d -label:wontfix \"login page\".",
    inputSchema: { q: z.string().min(1).max(QUERY_MAX_LENGTH), projectId: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) },
  }, tool(async (x: { q: string; projectId?: string; limit: number }) => {
    const list = await listTasks(deps, a, { projectId: x.projectId, limit: x.limit, queryConds: applyTaskQuery(x.q, { deps, actor: a }), includeSubtasks: wantsSubtasks(x.q) });
    return {
      count: list.length,
      tasks: list.map((t) => ({ id: t.id, ref: t.ref, title: t.title, status: t.statusName, assignee: t.assignee?.name ?? null, priority: t.priority, labels: t.labels, due: t.due, type: t.type, sprintId: t.sprintId, points: t.points, checklist: t.checklist })),
    };
  }) as never);
}

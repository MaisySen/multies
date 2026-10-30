/**
 * R27 (teardown): task watchers and duplicate over MCP. Read only keys and tokens can list watchers; watching,
 * unwatching and duplicating need a write key. Agent keys act as their agent and name the member (userId).
 * The same services back the app and REST (v1-r27-teardown.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { listWatchers, unwatchTask, watchTask } from "../services/suite/task-watchers-r27";
import { duplicateTask } from "../services/suite/task-duplicate-r27";
import type { Scoped } from "./mcp-server";
import { mcpCreate } from "./mcp-idempotency"; // R53 (MB-239)

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerTeardownR27Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("list_task_watchers", {
    title: "List a task's watchers", annotations: ro,
    description: "Who watches a task (they hear about new comments and status changes) and whether you do. taskId takes a task id or a reference like OPS-12.",
    inputSchema: { taskId: z.string().min(1) },
  }, tool(async (x: { taskId: string }) => listWatchers(deps, a, x.taskId)) as never);

  server.registerTool("watch_task", {
    title: "Watch a task", annotations: rw,
    description: "Starts watching a task: you (a member key) or the member named by userId (an agent key must name one). Watching twice changes nothing.",
    inputSchema: { taskId: z.string().min(1), userId: z.string().max(120).optional() },
  }, tool(async (x: { taskId: string; userId?: string }) => { writable(); return watchTask(deps, a, x.taskId, x.userId); }) as never);

  server.registerTool("unwatch_task", {
    title: "Stop watching a task", annotations: rw,
    description: "Stops watching a task: you (a member key) or the member named by userId.",
    inputSchema: { taskId: z.string().min(1), userId: z.string().max(120).optional() },
  }, tool(async (x: { taskId: string; userId?: string }) => { writable(); return unwatchTask(deps, a, x.taskId, x.userId); }) as never);

  server.registerTool("duplicate_task", {
    title: "Duplicate a task", annotations: rw,
    description: "Copies a task (new number, first to-do status) with its notes, assignee, priority, dates, labels, type, estimate, sprint, repeat rule and custom field values. By default also copies subtasks (3 levels, 200 tasks) and the checklist (unticked). Options: title (default \"<title> (copy)\"), projectId, subtasks, checklist, assignee, dependencies (copy \"blocked by\" links, default false).",
    inputSchema: {
      taskId: z.string().min(1), title: z.string().min(1).max(500).optional(), projectId: z.string().max(80).optional(),
      subtasks: z.boolean().optional(), checklist: z.boolean().optional(), assignee: z.boolean().optional(), dependencies: z.boolean().optional(),
    },
  }, tool(async (x: { taskId: string; title?: string; projectId?: string; subtasks?: boolean; checklist?: boolean; assignee?: boolean; dependencies?: boolean }) => {
    writable();
    const { taskId, ...opts } = x;
    return duplicateTask(deps, a, taskId, opts, await mcpCreate("tsk")); // R53: one copy on a retry
  }) as never);
}

/**
 * Round 21 (R21.4): epics on MCP. Read only keys can list and read epics but not change them.
 * Task types (task, story, bug, epic) ride create_task, update_task and list_tasks.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { addToEpic, getEpic, listEpics, MAX_EPIC_BATCH, removeFromEpic } from "../services/suite/task-types";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

const short = (t: { id: string; ref: string; title: string; type: string; status: string; statusName: string; assignee: { name: string } | null; due: string | null }) =>
  ({ id: t.id, ref: t.ref, title: t.title, type: t.type, status: t.status, statusName: t.statusName, assignee: t.assignee?.name ?? null, due: t.due });

export function registerTaskTypeTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("list_epics", {
    title: "List epics", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Epics in the workspace or one project, each with progress: done of total over its items and their subtasks, percent, points when tasks carry points, and the date span of its items.",
    inputSchema: { projectId: z.string().optional() },
  }, tool(async (x: { projectId?: string }) => ({
    epics: (await listEpics(deps, a, { projectId: x.projectId })).map((e) => ({ ...short(e), projectId: e.projectId, progress: e.progress })),
  })) as never);

  server.registerTool("get_epic", {
    title: "Get an epic", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "One epic by id or reference (OPS-7) with its progress and its items (stories, tasks and bugs).",
    inputSchema: { id: z.string().min(1) },
  }, tool(async (x: { id: string }) => {
    const r = await getEpic(deps, a, x.id);
    return { epic: { ...short(r.epic), notes: r.epic.notes, progress: r.epic.progress }, items: r.items.map((t) => ({ ...short(t), subtasks: t.subtasks })) };
  }) as never);

  server.registerTool("add_to_epic", {
    title: "Add tasks to an epic", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Put tasks, stories or bugs in an epic (by id or reference). An item in another epic moves. Pass remove: true to take them out instead.",
    inputSchema: { epicId: z.string().min(1), ids: z.array(z.string().min(1)).min(1).max(MAX_EPIC_BATCH), remove: z.boolean().optional() },
  }, tool(async (x: { epicId: string; ids: string[]; remove?: boolean }) => {
    writable();
    const r = x.remove ? await removeFromEpic(deps, a, x.epicId, x.ids) : await addToEpic(deps, a, x.epicId, x.ids);
    return { moved: r.moved, epic: { ...short(r.epic), progress: r.epic.progress }, items: r.items.map(short) };
  }) as never);
}

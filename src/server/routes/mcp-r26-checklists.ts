/**
 * R26 (MB-85): checklists inside tasks over MCP. Read only keys and tokens can list; adding, ticking, renaming,
 * reordering, deleting and turning an item into a subtask need a write key. Agent keys act as their agent.
 * The same service backs the app and REST (v1-r26-checklists.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { addChecklistItems, checklistItemToSubtask, CHECKLIST_TITLE_MAX, deleteChecklistItem, listChecklist, reorderChecklist, updateChecklistItem } from "../services/suite/checklists";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerChecklistTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("list_checklist", {
    title: "List a task's checklist", annotations: ro,
    description: "The checklist items inside a task, in order, with total and done counts. taskId takes a task id or a reference like OPS-12.",
    inputSchema: { taskId: z.string().min(1) },
  }, tool(async (x: { taskId: string }) => listChecklist(deps, a, x.taskId)) as never);

  server.registerTool("add_checklist_items", {
    title: "Add checklist items to a task", annotations: rw,
    description: "Adds one or more checklist items to the end of a task's checklist (up to 200 per task). Each item can carry an assignee (member:<id> or agent:<id>) and a due date (YYYY-MM-DD).",
    inputSchema: {
      taskId: z.string().min(1),
      items: z.array(z.object({ title: z.string().min(1).max(CHECKLIST_TITLE_MAX), done: z.boolean().optional(), assignee: z.string().max(120).nullable().optional(), due: z.string().max(40).nullable().optional() })).min(1).max(200),
    },
  }, tool(async (x: { taskId: string; items: { title: string; done?: boolean; assignee?: string | null; due?: string | null }[] }) => {
    writable();
    return { items: await addChecklistItems(deps, a, x.taskId, x.items) };
  }) as never);

  server.registerTool("update_checklist_item", {
    title: "Tick, rename or change a checklist item", annotations: rw,
    description: "Changes a checklist item: done (tick or untick), title, assignee (member:<id>, agent:<id> or null), due (YYYY-MM-DD or null).",
    inputSchema: { itemId: z.string().min(1), done: z.boolean().optional(), title: z.string().min(1).max(CHECKLIST_TITLE_MAX).optional(), assignee: z.string().max(120).nullable().optional(), due: z.string().max(40).nullable().optional() },
  }, tool(async (x: { itemId: string; done?: boolean; title?: string; assignee?: string | null; due?: string | null }) => {
    writable();
    const { itemId, ...patch } = x;
    return { item: await updateChecklistItem(deps, a, itemId, patch) };
  }) as never);

  server.registerTool("reorder_checklist", {
    title: "Reorder a task's checklist", annotations: rw,
    description: "Puts a task's checklist in a new order. ids lists every item id of that checklist once.",
    inputSchema: { taskId: z.string().min(1), ids: z.array(z.string().min(1)).max(200) },
  }, tool(async (x: { taskId: string; ids: string[] }) => {
    writable();
    return reorderChecklist(deps, a, x.taskId, x.ids);
  }) as never);

  server.registerTool("delete_checklist_item", {
    title: "Delete a checklist item", annotations: { ...rw, destructiveHint: true },
    description: "Removes an item from its task's checklist.",
    inputSchema: { itemId: z.string().min(1) },
  }, tool(async (x: { itemId: string }) => {
    writable();
    return deleteChecklistItem(deps, a, x.itemId);
  }) as never);

  server.registerTool("checklist_item_to_subtask", {
    title: "Turn a checklist item into a subtask", annotations: rw,
    description: "Creates a subtask of the item's task with the same title, assignee and due date, and removes the item from the checklist.",
    inputSchema: { itemId: z.string().min(1) },
  }, tool(async (x: { itemId: string }) => {
    writable();
    return checklistItemToSubtask(deps, a, x.itemId);
  }) as never);
}

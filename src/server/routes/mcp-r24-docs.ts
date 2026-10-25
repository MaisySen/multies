/**
 * R24.5 Docs tree and backlinks in MCP: get_doc_tree and get_backlinks (reads, so read only keys and
 * tokens can call them) and move_doc (a write).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { getBacklinks, getDocTree, MAX_DEPTH, moveDoc, type TreeNode } from "../services/suite/doc-tree";
import { resolveTaskId } from "../services/suite/tasks";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerR24DocTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("get_doc_tree", {
    title: "Docs page tree", annotations: ro,
    description: `The workspace's docs as a tree of pages and sub pages (id, title, parentId, position, depth, children). Pages nest at most ${MAX_DEPTH} levels deep. Use flat: true for one line per page with its depth instead.`,
    inputSchema: { flat: z.boolean().default(false) },
  }, tool(async (x: { flat: boolean }) => {
    const t = await getDocTree(deps, { orgId: a.orgId });
    if (!x.flat) return t;
    const out: Omit<TreeNode, "children">[] = [];
    const walk = (list: TreeNode[]) => { for (const { children, ...n } of list) { out.push(n); walk(children); } };
    walk(t.tree);
    return { pages: out, count: t.count, truncated: t.truncated };
  }) as never);

  server.registerTool("move_doc", {
    title: "Move a doc in the page tree", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: `Puts a doc under another page (parentId, or null for the top level) and, optionally, right before or after a sibling (beforeId or afterId). With neither it goes last. A page can't go under itself or its own sub pages; ${MAX_DEPTH} levels at most.`,
    inputSchema: { docId: z.string().min(1).max(64), parentId: z.string().min(1).max(64).nullable().optional(), beforeId: z.string().min(1).max(64).optional(), afterId: z.string().min(1).max(64).optional() },
  }, tool(async (x: { docId: string; parentId?: string | null; beforeId?: string; afterId?: string }) => {
    writable();
    if (x.beforeId && x.afterId) throw new Error("Send beforeId or afterId, not both.");
    return moveDoc(deps, a, x.docId, { parentId: x.parentId, beforeId: x.beforeId, afterId: x.afterId });
  }) as never);

  server.registerTool("get_backlinks", {
    title: "Docs that link to a doc or task", annotations: ro,
    description: "Lists the docs whose body links to a doc or a task (task id or ref like OPS-12), newest first, with a short snippet of the text around each link.",
    inputSchema: { type: z.enum(["doc", "task"]), id: z.string().min(1).max(64) },
  }, tool(async (x: { type: "doc" | "task"; id: string }) => {
    const id = x.type === "task" ? await resolveTaskId(deps, a.orgId, x.id) : x.id;
    return getBacklinks(deps, { orgId: a.orgId }, { type: x.type, id });
  }) as never);
}

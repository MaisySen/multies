/**
 * R26 (MB-77, found by Haajir): read back, edit and delete task comments and chat messages over MCP.
 * Read only keys can list; edits and deletes need a write key. Only the author edits (an agent key
 * edits what its agent wrote); the author, an owner or an admin deletes. Other workspaces: not found.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { COMMENT_MAX, deleteTaskComment, editTaskComment, listTaskComments } from "../services/suite/comments-r26";
import { deleteMessage, editMessage } from "../services/suite/chat";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerR26CommentTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const del = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

  server.registerTool("list_task_comments", {
    title: "List a task's comments", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Every comment on a task (id or reference like MB-12), oldest first, with its author and editedAt (null until edited).",
    inputSchema: { taskId: z.string().min(1) },
  }, tool(async (x: { taskId: string }) => listTaskComments(deps, a, x.taskId)) as never);

  server.registerTool("edit_task_comment", {
    title: "Edit a task comment", annotations: rw,
    description: "Replaces the text of a comment you wrote (fix a typo or a wrong number). The comment then shows as edited.",
    inputSchema: { commentId: z.string().min(1), body: z.string().min(1).max(COMMENT_MAX) },
  }, tool(async (x: { commentId: string; body: string }) => { writable(); return { comment: await editTaskComment(deps, a, x.commentId, x.body) }; }) as never);

  server.registerTool("delete_task_comment", {
    title: "Delete a task comment", annotations: del,
    description: "Deletes a task comment. The author, an owner or an admin can.",
    inputSchema: { commentId: z.string().min(1) },
  }, tool(async (x: { commentId: string }) => { writable(); return deleteTaskComment(deps, a, x.commentId); }) as never);

  server.registerTool("edit_chat_message", {
    title: "Edit a chat message", annotations: rw,
    description: "Replaces the text of a chat message you posted, with the same markup as post_message. The message then shows as edited.",
    inputSchema: { messageId: z.string().min(1), body: z.string().min(1).max(20_000) },
  }, tool(async (x: { messageId: string; body: string }) => { writable(); return { message: await editMessage(deps, a, x.messageId, x.body) }; }) as never);

  server.registerTool("delete_chat_message", {
    title: "Delete a chat message", annotations: del,
    description: "Deletes a chat message. The author, an owner or an admin can. Replies keep their place under a deleted placeholder.",
    inputSchema: { messageId: z.string().min(1) },
  }, tool(async (x: { messageId: string }) => { writable(); return deleteMessage(deps, a, x.messageId); }) as never);
}

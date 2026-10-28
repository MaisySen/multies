/**
 * Round 22 (R22.2): internal notes on mail threads over MCP. Read only keys can list; adding and
 * deleting need a write key. Agent keys write as their agent. Notes are team only and never sent.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { addComment, COMMENT_MAX, deleteComment, listComments } from "../services/mail/thread-comments";
import type { Scoped } from "./mcp-server";
import { mcpCreate } from "./mcp-idempotency"; // R53 (MB-239)

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerThreadCommentTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;

  server.registerTool("list_thread_comments", {
    title: "List a thread's internal notes", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Team only notes on a mail thread, oldest first, with who wrote each one and who it mentions, plus the teammates who can be mentioned. Notes are never part of read_thread or any mail that is sent.",
    inputSchema: { threadId: z.string().min(1) },
  }, tool(async (x: { threadId: string }) => listComments(deps, a, x.threadId)) as never);

  server.registerTool("add_thread_comment", {
    title: "Add an internal note to a thread", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Adds a team only note to a mail thread. The outside sender never sees it. Mention teammates with \"@Full Name\" in the text or pass mentions (user ids or emails); mentioned people who can open the thread get a notification.",
    inputSchema: {
      threadId: z.string().min(1),
      body: z.string().min(1).max(COMMENT_MAX),
      mentions: z.array(z.string().min(1).max(254)).max(50).optional().describe("User ids or email addresses of teammates to notify."),
    },
  }, tool(async (x: { threadId: string; body: string; mentions?: string[] }) => {
    writable();
    return { comment: await addComment(deps, a, x.threadId, { body: x.body, mentions: x.mentions }, await mcpCreate("tcm")) };
  }) as never);

  server.registerTool("delete_thread_comment", {
    title: "Delete an internal note", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description: "Deletes a note on a thread. Only the note's author, or a workspace key, can delete it.",
    inputSchema: { threadId: z.string().min(1), commentId: z.string().min(1) },
  }, tool(async (x: { threadId: string; commentId: string }) => {
    writable();
    return deleteComment(deps, a, x.threadId, x.commentId);
  }) as never);
}

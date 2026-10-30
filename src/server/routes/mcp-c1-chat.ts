/**
 * C1: chat channels (WhatsApp first) on MCP, so an AI agent can work the shared inbox's customer chats the way a
 * teammate does. Same rules as the app: the 24 hour reply window (window_closed outside it, use a template),
 * Idempotency-Key on sends, and the workspace setting "Agents may send chat replies without review": while it is
 * off (the default) an agent's reply or template lands as a draft that a person approves with one tap in the chat.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { Scoped } from "./mcp-server";
import { mcpCreate } from "./mcp-idempotency";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

const svc = () => import("../services/channels/service");
const DRAFT_NOTE = "Saved as a draft: a person approves it in the chat before it reaches the customer (the workspace has agent auto send off).";

export function registerChatChannelTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const ro = { readOnlyHint: true, openWorldHint: false };
  const sender = { agentId: actor.agentId ?? null };

  server.registerTool("list_chat_conversations", {
    title: "List customer chats", annotations: ro,
    description: "WhatsApp (and later Messenger and Instagram) conversations in the shared inbox, newest first, with the customer, snippet, unread count, status, assignee and labels.",
    inputSchema: {
      channel: z.string().max(64).optional().describe("A channel id from list_chat_conversations results, to see one number only."),
      status: z.enum(["open", "waiting", "done"]).optional(),
      assignee: z.string().max(64).optional().describe("\"me\", \"none\" or a member's user id."),
      unread: z.boolean().optional().describe("Only chats with unread customer messages."),
      q: z.string().max(200).optional().describe("Search the customer's name, number and message text."),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, tool(async (a: { channel?: string; status?: "open" | "waiting" | "done"; assignee?: string; unread?: boolean; q?: string; limit?: number }) =>
    ({ conversations: await (await svc()).listConversations(deps, actor, { ...a, unread: a.unread === undefined ? undefined : a.unread ? "true" : "false" }) })) as never);

  server.registerTool("get_chat_conversation", {
    title: "Read a customer chat", annotations: ro,
    description: "One chat with its messages (oldest first, up to 200) and the reply window: window.open is false once 24 hours have passed since the customer last wrote, and then only send_chat_template works.",
    inputSchema: { conversationId: z.string().min(1).max(64) },
  }, tool(async (a: { conversationId: string }) => (await svc()).conversationDetail(deps, actor, a.conversationId)) as never);

  server.registerTool("reply_chat", {
    title: "Reply in a customer chat", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Send a text reply to the customer, inside the 24 hour reply window (outside it the answer is window_closed: use send_chat_template). Unless the workspace lets agents send without review, the reply is saved as a draft for a person to approve; the result says which.",
    inputSchema: { conversationId: z.string().min(1).max(64), text: z.string().min(1).max(4096) },
  }, tool(async (a: { conversationId: string; text: string }) => {
    writable();
    const message = await (await svc()).sendMessage(deps, actor, a.conversationId, { text: a.text }, { ...(await mcpCreate("cm")), agent: sender });
    return message.delivery === "draft" ? { message, draft: true, note: DRAFT_NOTE } : { message, draft: false };
  }) as never);

  server.registerTool("list_chat_templates", {
    title: "List approved chat templates", annotations: ro,
    description: "The approved WhatsApp templates for the chat's number, with each one's blanks (params, and paramNames for named blanks). Templates are the only way to write after the 24 hour window.",
    inputSchema: { conversationId: z.string().min(1).max(64) },
  }, tool(async (a: { conversationId: string }) => ({ templates: await (await svc()).listTemplates(deps, actor, a.conversationId) })) as never);

  server.registerTool("send_chat_template", {
    title: "Send an approved template", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Send one approved template (from list_chat_templates) with a value for every blank, in order. Works at any time. Unless the workspace lets agents send without review, it is saved as a draft for a person to approve.",
    inputSchema: {
      conversationId: z.string().min(1).max(64),
      name: z.string().min(1).max(512), language: z.string().min(2).max(15),
      params: z.array(z.string().max(1024)).max(20).default([]).describe("One value per blank, in order (for named blanks, the order of paramNames)."),
    },
  }, tool(async (a: { conversationId: string; name: string; language: string; params: string[] }) => {
    writable();
    const message = await (await svc()).sendTemplate(deps, actor, a.conversationId, { name: a.name, language: a.language, params: a.params ?? [] }, { ...(await mcpCreate("cm")), agent: sender });
    return message.delivery === "draft" ? { message, draft: true, note: DRAFT_NOTE } : { message, draft: false };
  }) as never);

  server.registerTool("update_chat_conversation", {
    title: "Assign, set status or label a chat", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Assign a chat to a member (null to unassign), set its status (open, waiting, done) or replace its labels.",
    inputSchema: {
      conversationId: z.string().min(1).max(64),
      assigneeUserId: z.string().max(64).nullable().optional(),
      status: z.enum(["open", "waiting", "done"]).optional(),
      labels: z.array(z.string().max(40)).max(20).optional(),
    },
  }, tool(async (a: { conversationId: string; assigneeUserId?: string | null; status?: "open" | "waiting" | "done"; labels?: string[] }) => {
    writable();
    const { conversationId, ...b } = a;
    return { conversation: await (await svc()).patchConversation(deps, actor, conversationId, b) };
  }) as never);

  server.registerTool("add_chat_note", {
    title: "Add an internal note to a chat", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "A note for the team on a chat. The customer never sees it.",
    inputSchema: { conversationId: z.string().min(1).max(64), text: z.string().min(1).max(4000) },
  }, tool(async (a: { conversationId: string; text: string }) => {
    writable();
    return { note: await (await svc()).addNote(deps, actor, a.conversationId, a.text) };
  }) as never);
}

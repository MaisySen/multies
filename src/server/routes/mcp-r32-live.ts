/**
 * R32: live chat over MCP. chat_typing shows "<agent> is typing" in a channel while an agent
 * writes a long answer. Ephemeral; nothing is stored. Same service as POST /api/chat/channels/:id/typing.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { sendTyping } from "../realtime/typing";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerChatLiveR32Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("chat_typing", {
    title: "Show typing in a chat channel", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Shows \"<name> is typing\" to people who have the channel open, for about 6 seconds. Call again every 3 seconds or so while you write. Nothing is stored. Answers { ok, sent }; sent is false when called faster than every 3 seconds.",
    inputSchema: { channelId: z.string().min(1).max(64) },
  }, tool(async (x: { channelId: string }) => { writable(); return sendTyping(deps, a, x.channelId); }) as never);
}

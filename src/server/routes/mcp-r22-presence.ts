/**
 * Round 22 (R22.3, R22.4) on MCP: who is viewing or replying in a shared inbox thread right now,
 * the draft replies waiting in it, and taking one over. Read only keys can read; taking over needs a
 * write key, and agent keys can't take over a person's draft.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { listThreadDrafts, takeOverDraft, threadPresence } from "../services/suite/thread-collab";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerPresenceTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("get_thread_presence", {
    title: "Who is in a thread now", annotations: ro,
    description: "People who have a shared inbox thread open right now and whether each is just viewing or writing a reply. Check it before replying so you don't answer on top of a teammate. Entries expire 40 seconds after the last heartbeat.",
    inputSchema: { threadId: z.string().min(1), mailboxId: z.string().min(1).max(64).optional().describe("The mailbox whose copy of the thread to check. Default: the oldest one the key can open.") },
  }, tool(async (x: { threadId: string; mailboxId?: string }) => {
    const v = await threadPresence(deps, actor, x.threadId, { op: "list" }, { mailboxId: x.mailboxId });
    return { threadId: x.threadId, people: v.people, replying: v.people.filter((p) => p.state === "replying").map((p) => p.name) };
  }) as never);

  server.registerTool("list_thread_drafts", {
    title: "List draft replies in a thread", annotations: ro,
    description: "Draft replies saved in a shared inbox thread, in mailboxes this key can open: who wrote each, when it was last saved, and a preview.",
    inputSchema: { threadId: z.string().min(1) },
  }, tool(async (x: { threadId: string }) => ({ drafts: await listThreadDrafts(deps, actor, x.threadId) })) as never);

  server.registerTool("take_over_draft", {
    title: "Take over a draft reply", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Makes the key's person the owner of a teammate's draft reply so they can finish and send it. The previous author is notified once, and their next save of that draft is refused instead of overwriting. Not for agent keys.",
    inputSchema: { draftId: z.string().min(1) },
  }, tool(async (x: { draftId: string }) => {
    writable();
    return takeOverDraft(deps, actor, x.draftId);
  }) as never);
}

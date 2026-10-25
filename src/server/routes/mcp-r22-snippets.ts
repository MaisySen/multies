/**
 * Round 22 (R22.4b): saved replies over MCP. Read only keys and tokens can list and render; creating
 * needs a write key. Agent keys see shared replies and their own, and save as their agent.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { createSnippet, listSnippets, renderSnippetFor } from "../services/suite/snippets";
import { SNIPPET_BODY_MAX, SNIPPET_NAME_MAX, SNIPPET_SUBJECT_MAX } from "@/shared/snippets";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
const VARS = "{{first_name}}, {{name}}, {{email}} (the recipient), {{my_name}}, {{my_first_name}}, {{company}} (the workspace), {{mailbox}} (the sending address), {{date}}";

export function registerSnippetTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;

  server.registerTool("list_snippets", {
    title: "List saved replies", annotations: { readOnlyHint: true, openWorldHint: false },
    description: `The workspace's saved replies (shared ones plus your own private ones), by name, with their shortcut, subject and body. Bodies may hold variables: ${VARS}. Use render_snippet to fill them in for a thread.`,
    inputSchema: { q: z.string().max(200).optional().describe("Filter by name, shortcut or text.") },
  }, tool(async (x: { q?: string }) => listSnippets(deps, a, { q: x.q })) as never);

  server.registerTool("render_snippet", {
    title: "Fill in a saved reply", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Returns a saved reply's subject and body with its variables filled in. Pass threadId to address the thread's newest sender (the thread must be one you can open), or to for a new message. Nothing is sent: use the reply tools to send the text.",
    inputSchema: {
      snippetId: z.string().min(1),
      threadId: z.string().min(1).optional(),
      to: z.string().max(2000).optional().describe("Recipient, e.g. \"Grace Hopper <grace@example.com>\"."),
      mailboxId: z.string().min(1).optional().describe("The mailbox you will send from, for {{mailbox}}."),
    },
  }, tool(async (x: { snippetId: string; threadId?: string; to?: string; mailboxId?: string }) => renderSnippetFor(deps, a, x.snippetId, { threadId: x.threadId, to: x.to, mailboxId: x.mailboxId })) as never);

  server.registerTool("create_snippet", {
    title: "Save a reply", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: `Saves a reusable reply for the workspace. Plain text body; variables: ${VARS}. Shared with the team unless shared is false.`,
    inputSchema: {
      name: z.string().min(1).max(SNIPPET_NAME_MAX),
      body: z.string().min(1).max(SNIPPET_BODY_MAX),
      subject: z.string().max(SNIPPET_SUBJECT_MAX).optional(),
      shortcut: z.string().max(32).optional().describe("One word, used as /word in compose. Unique in the workspace."),
      shared: z.boolean().optional(),
    },
  }, tool(async (x: { name: string; body: string; subject?: string; shortcut?: string; shared?: boolean }) => {
    writable();
    return { snippet: await createSnippet(deps, a, x) };
  }) as never);
}

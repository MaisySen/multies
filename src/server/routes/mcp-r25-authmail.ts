/**
 * R25 (MB-60, found by Haajir): branded auth emails over MCP. There was no auth hook tool before, so
 * this is one tool: update_auth_email_hook sets a hook's logo, colour, reply-to, footer, per type text
 * and second language (the same body as PATCH /api/v1/auth-email-hooks/{id}). Needs a write key; agent
 * keys and agent member keys are refused, and another workspace's hook id is not found.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthContext, Deps } from "../context";
import { updateAuthHook } from "../services/mail/auth-email-hooks";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerAuthMailTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  server.registerTool("update_auth_email_hook", {
    title: "Brand an auth email hook", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Sets how a Supabase auth email hook's emails look: branding { logoUrl (https), brandColor (#RRGGBB), replyTo (email), footer, templates: { signup | invite | magiclink | recovery | email_change | email | reauthentication: { subject, intro, buttonLabel } }, secondaryLanguage: { lang (e.g. ne), templates (same shape), note } }. Plain text only; placeholders {appName}, {code}, {email}. Keys left out stay, null clears one, templates merge per type, branding null goes back to the default email. Also appName and from (another mailbox). Returns the hook, never its secret.",
    inputSchema: {
      hookId: z.string().min(1).describe("The hook id (ahk_...)."),
      appName: z.string().max(80).optional(),
      from: z.string().email().optional(),
      branding: z.record(z.string(), z.unknown()).nullable().optional(),
    },
  }, tool(async (x: { hookId: string; appName?: string; from?: string; branding?: Record<string, unknown> | null }) => {
    writable();
    return { hook: await updateAuthHook(deps, actor as unknown as AuthContext & { agentId?: string | null }, x.hookId, { appName: x.appName, from: x.from, branding: x.branding as never }) };
  }) as never);
}

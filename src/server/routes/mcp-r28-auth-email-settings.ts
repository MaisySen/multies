/**
 * R28: the Sign-up emails settings (R27, the R25 auth email hook) over MCP: get, update, regenerate the signing
 * secret, preview and test send. The same service backs the web page and v1 (auth-email-settings-r27.ts), so the
 * rules match the API: owners, admins and full workspace keys only (member keys, agent keys and agent member keys
 * get 403 forbidden), writes need a write key, at most 5 test sends an hour a workspace (rate_limited after), and
 * the signing secret is in the one answer that made it, never in a later read and never logged. Writes are audited.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import {
  getAuthEmailSettings, previewAuthEmailSettings, putAuthEmailSettings, regenerateAuthEmailSecret, sendAuthEmailTest,
} from "../services/mail/auth-email-settings";
import { AUTH_EMAIL_TYPES } from "../services/mail/auth-email-branding";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
type Actor = Parameters<typeof getAuthEmailSettings>[1];

const TYPES = AUTH_EMAIL_TYPES.join(", ");

export function registerAuthEmailSettingsTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as Actor;
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool("get_auth_email_settings", {
    title: "Get sign-up email settings", annotations: ro,
    description: "The workspace's Sign-up emails settings (the Supabase auth email hook): enabled, senderName, from, appName, supabaseUrl, branding, endpointUrl, secret { set, masked } (never the secret itself) and testSendsLeft this hour, plus the sender mailboxes on verified domains. settings is null before the first update. Owners, admins and full workspace keys only.",
  }, tool(async () => getAuthEmailSettings(deps, a)) as never);

  server.registerTool("update_auth_email_settings", {
    title: "Save sign-up email settings", annotations: { ...rw, idempotentHint: true },
    description: "Creates the settings (from and supabaseUrl needed the first time; that answer carries the signing secret once, as `secret`, in the form Supabase takes) or changes the fields sent: enabled (off: the hook answers 503 and sends nothing), senderName (the From name, null uses the mailbox's), from (a mailbox on a verified domain), appName, supabaseUrl, branding { logoUrl, brandColor, replyTo, footer, templates per type { subject, intro, buttonLabel }, secondaryLanguage { lang, templates, note } } merged, null clears. Same checks as PUT /api/v1/auth-email-settings. Audited.",
    inputSchema: {
      enabled: z.boolean().optional(),
      senderName: z.string().max(80).nullable().optional(),
      from: z.string().email().optional(),
      appName: z.string().max(80).optional(),
      supabaseUrl: z.string().max(200).optional(),
      branding: z.record(z.string(), z.unknown()).nullable().optional(),
    },
  }, tool(async (x: Record<string, unknown>) => { writable(); return putAuthEmailSettings(deps, a, x); }) as never);

  server.registerTool("regenerate_auth_email_secret", {
    title: "Make a new sign-up email signing secret", annotations: { ...rw, destructiveHint: true },
    description: "Makes a new signing secret and returns it once, as `secret`; the old one stops working at once, so paste the new one into Supabase's Send Email Hook straight away. Later reads show it masked. Audited.",
  }, tool(async () => { writable(); return regenerateAuthEmailSecret(deps, a); }) as never);

  server.registerTool("preview_auth_email", {
    title: "Preview a sign-up email", annotations: ro,
    description: `Renders one email type (${TYPES}; default signup) with a sample link and the code 123456: { preview: { type, to, subject, html, text, replyTo } }. Unsaved appName and branding can be tried; email sets the sample recipient. Nothing is sent or stored.`,
    inputSchema: {
      type: z.string().max(40).optional(),
      appName: z.string().max(80).optional(),
      email: z.string().max(254).optional(),
      branding: z.record(z.string(), z.unknown()).nullable().optional(),
    },
  }, tool(async (x: { type?: string; appName?: string; email?: string; branding?: unknown }) => ({ preview: await previewAuthEmailSettings(deps, a, x) })) as never);

  server.registerTool("send_auth_email_test", {
    title: "Send a test sign-up email", annotations: { ...rw, openWorldHint: true },
    description: `Sends one email type (${TYPES}; default signup), as saved, to your own address with "Test:" before the subject. At most 5 an hour for a workspace (rate_limited after, with the minutes to wait). Answers { sent, to, type, testSendsLeft }.`,
    inputSchema: { type: z.string().max(40).optional() },
  }, tool(async (x: { type?: string }) => { writable(); return sendAuthEmailTest(deps, a, { type: x.type }); }) as never);
}

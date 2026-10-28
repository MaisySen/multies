/**
 * Auth email hooks in the public API (round 13): a customer's Supabase project sends its auth
 * emails through a workspace mailbox. See docs/transactional-email.md.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { createAuthHook, deleteAuthHook, listAuthHooks } from "../services/mail/auth-email-hooks";
import { registerAuthHookBrandingRoutes } from "./v1-r25-authmail";
import { registerAuthEmailSettingsRoutes } from "./auth-email-settings-r27";
import { idempotentCreate } from "../lib/idempotency"; // R55 (MB-239): same id on a 5xx retry

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
/**
 * MB-57: the steps a Supabase project needs besides the hook URL. Without a custom SMTP host Supabase
 * keeps its 2 emails an hour limit even though the hook sends the mail, and the third signup in an
 * hour fails. Returned with every new hook so the caller sees it where they set the hook up.
 */
export const AUTH_HOOK_SETUP = [
  "In Supabase: Authentication, Hooks, Send Email Hook (HTTPS): paste hook.url and enable it.",
  "Authentication, Emails, SMTP Settings: turn on custom SMTP with a placeholder host such as smtp.hook-only.invalid (port 587, any user and password). Nothing is sent there while the hook is on, but without it Supabase allows only 2 auth emails an hour and signups fail.",
  "Authentication, Rate Limits: set the email rate limit to what you need, for example 30 an hour.",
] as const;
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const auth = (c: Context<AppEnv>) => c.var.auth as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;

export const AuthHookBody = z.object({
  from: z.string().email().openapi({ description: "A mailbox in this workspace on a verified domain.", example: "no-reply@example.com" }),
  secret: z.string().min(10).max(200).openapi({ description: "The secret Supabase generated for the Send Email Hook (v1,whsec_...).", example: "v1,whsec_..." }),
  supabaseUrl: z.string().url().openapi({ description: "Your Supabase project URL; verification links point here.", example: "https://abcd1234.supabase.co" }),
  appName: z.string().max(80).optional().openapi({ description: "The product name in subjects and bodies. Defaults to the mailbox's display name.", example: "Haajir" }),
  // R25 (MB-60): checked in full by the service (parseBrandingInput); see AuthHookBranding in PATCH.
  branding: z.record(z.string(), z.unknown()).nullable().optional().openapi({ description: "Optional logo, colour, reply-to, footer, per type text and a second language. Same shape as PATCH /auth-email-hooks/{id}." }),
}).openapi("AuthHookCreate");

export function registerAuthHookRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "delete", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Transactional email"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/auth-email-hooks", "List auth email hooks", "Each hook's URL, the mailbox it sends from and when it was last used. Secrets are never shown."),
    async (c) => send(c, { hooks: await listAuthHooks(c.var.deps, auth(c).orgId) }));
  api.openapi(route("post", "/auth-email-hooks", "Send a Supabase project's auth emails through Multies",
    "Body: { from, secret, supabaseUrl, appName? }. Returns the hook URL to paste into Supabase (Authentication, Hooks, Send Email Hook, HTTPS). Needs a workspace key.",
    { request: { body: { required: true, content: { "application/json": { schema: AuthHookBody } } } } }),
  async (c) => send(c, { hook: { ...(await createAuthHook(c.var.deps, auth(c), AuthHookBody.parse(await c.req.json().catch(() => ({}))), await idempotentCreate(c.req.raw, "ahk"))), setup: AUTH_HOOK_SETUP } }, 201));
  api.openapi(route("delete", "/auth-email-hooks/{id}", "Remove an auth email hook", "Calls to its URL fail from then on.", { request: { params: Id } }),
    async (c) => send(c, { deleted: await deleteAuthHook(c.var.deps, auth(c), c.req.param("id") ?? "") }));
  registerAuthHookBrandingRoutes(api); // R25 (MB-60): PATCH and preview
  registerAuthEmailSettingsRoutes(api); // R27: Sign-up emails settings
}

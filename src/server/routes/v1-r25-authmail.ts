/**
 * R25 (MB-60, found by Haajir) in the public API (v1): branded auth emails. PATCH a hook's branding
 * (logo, colour, reply-to, footer, per type text, second language) and preview what a call of one
 * type would send. Read only keys can preview (it writes nothing); PATCH needs a full workspace key
 * or an admin. Another workspace's hook id answers 404.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { previewAuthHook, updateAuthHook } from "../services/mail/auth-email-hooks";
import { AUTH_EMAIL_TYPES } from "../services/mail/auth-email-branding";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const TypeQ = z.object({ type: z.string().optional().openapi({ param: { name: "type", in: "query" }, description: `One of ${AUTH_EMAIL_TYPES.join(", ")}. Defaults to signup.`, example: "signup" }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const auth = (c: Context<AppEnv>) => c.var.auth as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;

const BRANDING_DOC = "branding: { logoUrl (https only), brandColor (#RRGGBB), replyTo (an email address), footer (one line), templates: { signup | invite | magiclink | recovery | email_change | email | reauthentication: { subject, intro, buttonLabel } }, secondaryLanguage: { lang (e.g. ne), templates (same per type shape), note } }. Text is plain (HTML escaped when sent); placeholders {appName}, {code}, {email}. Keys you leave out stay as they are, null clears one, templates merge per type, branding: null goes back to the default email.";

export const AuthHookPatchBody = z.object({
  appName: z.string().max(80).optional().openapi({ description: "The product name in subjects and bodies.", example: "Haajir" }),
  from: z.string().email().optional().openapi({ description: "Send from another mailbox of this workspace.", example: "no-reply@haajir.com" }),
  branding: z.record(z.string(), z.unknown()).nullable().optional().openapi({ description: BRANDING_DOC }),
}).openapi("AuthHookPatch");

const PreviewBody = z.object({
  email: z.string().max(254).optional().openapi({ description: "The address shown for {email}. Defaults to parent@example.com." }),
  branding: z.record(z.string(), z.unknown()).nullable().optional().openapi({ description: "Unsaved branding to try, merged over the saved one. Not stored." }),
}).openapi("AuthHookPreview");

/** Read only keys may POST here: a preview renders an email and writes nothing. */
export const isAuthHookPreview = (method: string, path: string) => method === "POST" && /\/auth-email-hooks\/[^/]+\/preview$/.test(path);

export function registerAuthHookBrandingRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "post" | "patch", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Transactional email"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } });

  api.openapi(route("patch", "/auth-email-hooks/{id}", "Brand an auth email hook",
    `Any of { appName, from, branding }. ${BRANDING_DOC} Returns the hook with its branding (never the secret). Needs a full workspace key.`,
    { request: { params: Id, body: { required: true, content: { "application/json": { schema: AuthHookPatchBody } } } } }),
  async (c) => send(c, { hook: await updateAuthHook(c.var.deps, auth(c), c.req.param("id") ?? "", AuthHookPatchBody.parse(await c.req.json().catch(() => ({})))) }));

  api.openapi(route("post", "/auth-email-hooks/{id}/preview", "Preview an auth email",
    "Returns { type, to, subject, html, text, replyTo } for ?type= (default signup) with a sample link and the code 123456. Nothing is sent. Body (optional): { email?, branding? } to try changes before saving them. Read only keys can call this.",
    { request: { params: Id, query: TypeQ } }),
  async (c) => {
    const body = PreviewBody.parse(await c.req.json().catch(() => ({})));
    return send(c, { preview: await previewAuthHook(c.var.deps, auth(c).orgId, c.req.param("id") ?? "", c.req.query("type") || "signup", body) });
  });
}

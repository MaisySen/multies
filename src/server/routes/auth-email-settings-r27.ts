/**
 * R27: Sign-up emails settings (the R25 auth email hook, MB-60) for the web app (cookie session, admins)
 * at /api/auth-email-settings and in the public API (v1) at /api/v1/auth-email-settings. The same service
 * backs both (services/mail/auth-email-settings.ts). The signing secret appears only in the answer that
 * made it.
 */
import { Hono, type Context } from "hono";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../context";
import { clientIp, requireAuth } from "../middleware";
import {
  getAuthEmailSettings, previewAuthEmailSettings, putAuthEmailSettings, regenerateAuthEmailSecret, sendAuthEmailTest,
} from "../services/mail/auth-email-settings";
import { AUTH_EMAIL_TYPES } from "../services/mail/auth-email-branding";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const auth = (c: Context<AppEnv>) => c.var.auth as any;
const body = async (c: Context<AppEnv>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const previewInput = (b: Record<string, unknown>) => ({ type: str(b.type), appName: str(b.appName), email: str(b.email), branding: b.branding });

export function authEmailSettingsRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await getAuthEmailSettings(c.var.deps, auth(c))))
    .put("/", async (c) => c.json(await putAuthEmailSettings(c.var.deps, auth(c), await body(c), { ip: clientIp(c) })))
    .post("/secret", async (c) => c.json(await regenerateAuthEmailSecret(c.var.deps, auth(c), { ip: clientIp(c) })))
    .post("/preview", async (c) => c.json({ preview: await previewAuthEmailSettings(c.var.deps, auth(c), previewInput(await body(c))) }))
    .post("/test", async (c) => c.json(await sendAuthEmailTest(c.var.deps, auth(c), { type: str((await body(c)).type) }, { ip: clientIp(c) })));
}

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;

export const AuthEmailSettingsPut = z.object({
  enabled: z.boolean().optional().openapi({ description: "Off: the hook answers 503 and sends nothing." }),
  senderName: z.string().max(80).nullable().optional().openapi({ description: "The From name. null uses the mailbox's display name.", example: "Haajir" }),
  from: z.string().email().optional().openapi({ description: "A mailbox on one of the workspace's verified domains.", example: "no-reply@haajir.xyz" }),
  appName: z.string().max(80).optional().openapi({ description: "The product name in subjects and bodies ({appName})." }),
  supabaseUrl: z.string().max(200).optional().openapi({ description: "The Supabase project URL. Needed the first time.", example: "https://abcd1234.supabase.co" }),
  branding: z.record(z.string(), z.unknown()).nullable().optional().openapi({ description: "As in PATCH /auth-email-hooks/{id}: logoUrl, brandColor, replyTo, footer, templates per type { subject, intro, buttonLabel }, secondaryLanguage { lang, templates, note }. Merged; null clears." }),
}).openapi("AuthEmailSettingsPut");
const PreviewBody = z.object({
  type: z.string().optional().openapi({ description: `One of ${AUTH_EMAIL_TYPES.join(", ")}. Defaults to signup.` }),
  appName: z.string().max(80).optional(),
  email: z.string().max(254).optional(),
  branding: z.record(z.string(), z.unknown()).nullable().optional().openapi({ description: "Unsaved branding, merged over the saved one. Not stored." }),
}).openapi("AuthEmailSettingsPreview");
const TestBody = z.object({ type: z.string().optional() }).openapi("AuthEmailSettingsTest");

export function registerAuthEmailSettingsRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "put" | "post", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Transactional email"], summary, description, security: [{ bearerAuth: [] }], ...extra,
      responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("Owners, admins and full workspace keys only."), 404: err("No settings yet."), 422: err("Validation failed."), 429: err("Too many test emails.") } });

  api.openapi(route("get", "/auth-email-settings", "Get sign-up email settings",
    "The workspace's auth email settings: enabled, senderName, from, appName, supabaseUrl, branding, endpointUrl, secret { set, masked } (never the secret), testSendsLeft; plus the sender mailboxes on verified domains. settings is null before the first PUT."),
  async (c) => send(c, await getAuthEmailSettings(c.var.deps, auth(c))));

  api.openapi(route("put", "/auth-email-settings", "Save sign-up email settings",
    "Creates the settings (from and supabaseUrl needed; the answer carries the signing secret once, as `secret`, in the form Supabase takes) or changes the fields sent. Audited.",
    { request: { body: { required: true, content: { "application/json": { schema: AuthEmailSettingsPut } } } } }),
  async (c) => send(c, await putAuthEmailSettings(c.var.deps, auth(c), await body(c), { ip: clientIp(c) })));

  api.openapi(route("post", "/auth-email-settings/secret", "Make a new signing secret",
    "Returns the new secret once, as `secret`; the old one stops working at once. Paste it into Supabase's Send Email Hook. Audited."),
  async (c) => send(c, await regenerateAuthEmailSecret(c.var.deps, auth(c), { ip: clientIp(c) })));

  api.openapi(route("post", "/auth-email-settings/preview", "Preview a sign-up email",
    "Returns { preview: { type, to, subject, html, text, replyTo } } with a sample link and the code 123456. Unsaved appName and branding can be tried. Nothing is sent or stored.",
    { request: { body: { content: { "application/json": { schema: PreviewBody } } } } }),
  async (c) => send(c, { preview: await previewAuthEmailSettings(c.var.deps, auth(c), previewInput(await body(c))) }));

  api.openapi(route("post", "/auth-email-settings/test", "Send a test sign-up email",
    "Sends one type, as saved, to the caller's own address with \"Test:\" before the subject. At most 5 an hour for a workspace (429 after).",
    { request: { body: { content: { "application/json": { schema: TestBody } } } } }),
  async (c) => send(c, await sendAuthEmailTest(c.var.deps, auth(c), { type: str((await body(c)).type) }, { ip: clientIp(c) })));
}

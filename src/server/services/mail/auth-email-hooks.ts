/**
 * Auth emails for a customer's own app, sent through Multies without SMTP.
 *
 * Supabase Auth can hand every auth email (sign up confirmation, magic link, password reset,
 * invite, email change, reauthentication code) to an HTTP endpoint instead of an SMTP server:
 * its Send Email Hook. Multies is that endpoint. Supabase signs each call with a secret it
 * generates (Standard Webhooks), Multies checks the signature, writes the email and sends it
 * from one of the workspace's mailboxes (no-reply@ for example) through the same outbound
 * provider as all other Multies mail.
 */
import { and, desc, eq } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import type { AuthContext, Deps } from "../../context";
import { authEmailHooks, mailboxes } from "../../db/schema";
import { decryptSecret, encryptSecret, newId } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { sendMessage } from "./send";
import { AUTH_EMAIL_TYPES, BrandingInputSchema, mergeBranding, parseBranding, renderAuthEmail, type BrandingInput } from "./auth-email-branding";
import { deferrableWrite } from "../write-priority";

type HookRow = typeof authEmailHooks.$inferSelect;

const bad = (message: string) => new HttpError(422, "validation_failed", message);

export interface AuthHookInput { from: string; secret: string; supabaseUrl: string; appName?: string; branding?: BrandingInput | null }

function presentHook(deps: Deps, h: HookRow, from: string) {
  return {
    id: h.id, kind: h.kind, from, supabaseUrl: h.supabaseUrl, appName: h.appName,
    branding: parseBranding(h.branding),
    url: `${deps.config.appUrl.replace(/\/$/, "")}/api/auth-hooks/supabase/${h.id}`,
    lastUsedAt: h.lastUsedAt?.toISOString() ?? null, createdAt: h.createdAt.toISOString(),
  };
}

function assertManager(a: AuthContext & { agentId?: string | null }) {
  if (a.role === "member" || a.agentId) throw new HttpError(403, "forbidden", "Only a workspace key or an admin can set up auth email hooks.");
}

/** Supabase shows the secret as "v1,whsec_<base64>"; Standard Webhooks wants "whsec_<base64>". */
export function normaliseHookSecret(raw: string): string {
  const s = raw.trim().replace(/^v1,/, "");
  if (!/^whsec_[A-Za-z0-9+/=]{24,}$/.test(s)) throw bad("Paste the secret Supabase shows for the hook: it looks like v1,whsec_ followed by letters and numbers.");
  return s;
}

export async function createAuthHook(deps: Deps, a: AuthContext & { agentId?: string | null }, input: AuthHookInput) {
  assertManager(a);
  const from = input.from.trim().toLowerCase();
  const mb = await deps.db.select().from(mailboxes).where(and(eq(mailboxes.orgId, a.orgId), eq(mailboxes.address, from))).get();
  if (!mb) throw bad(`${from} isn't a mailbox in this workspace. Create it first (no-reply@ works well).`);
  let url: URL;
  try { url = new URL(input.supabaseUrl.trim()); } catch { throw bad("supabaseUrl must be your project URL, for example https://abcd1234.supabase.co"); }
  if (url.protocol !== "https:") throw bad("supabaseUrl must start with https://");
  const secret = normaliseHookSecret(input.secret);
  const row: typeof authEmailHooks.$inferInsert = {
    id: newId("ahk"), orgId: a.orgId, mailboxId: mb.id, kind: "supabase",
    secretEnc: await encryptSecret(deps.config.appSecret, secret), supabaseUrl: url.origin,
    appName: (input.appName?.trim() || mb.displayName || from.split("@")[1]).slice(0, 80),
  };
  const branding = mergeBranding(null, input.branding ? parseBrandingInput(input.branding) : null);
  if (branding) row.branding = JSON.stringify(branding);
  await deps.db.insert(authEmailHooks).values(row);
  const saved = (await deps.db.select().from(authEmailHooks).where(eq(authEmailHooks.id, row.id)).get())!;
  return presentHook(deps, saved, mb.address);
}

export async function listAuthHooks(deps: Deps, orgId: string) {
  const rows = await deps.db.select({ h: authEmailHooks, from: mailboxes.address }).from(authEmailHooks)
    .innerJoin(mailboxes, eq(mailboxes.id, authEmailHooks.mailboxId)).where(eq(authEmailHooks.orgId, orgId)).orderBy(desc(authEmailHooks.createdAt));
  return rows.map((r) => presentHook(deps, r.h, r.from));
}

export async function deleteAuthHook(deps: Deps, a: AuthContext & { agentId?: string | null }, id: string) {
  assertManager(a);
  const h = await deps.db.select().from(authEmailHooks).where(and(eq(authEmailHooks.id, id), eq(authEmailHooks.orgId, a.orgId))).get();
  if (!h) throw notFound("Auth email hook");
  await deps.db.delete(authEmailHooks).where(eq(authEmailHooks.id, id));
  return true;
}

/** Validates a branding body (REST create and PATCH, MCP). Errors come back as one 422 naming the field. */
export function parseBrandingInput(raw: unknown): BrandingInput {
  const r = BrandingInputSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HttpError(422, "validation_failed", `branding${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`, { issues: r.error.issues.map((x) => ({ path: ["branding", ...x.path].join("."), message: x.message })) });
  }
  return r.data;
}

export interface AuthHookPatch { appName?: string; from?: string; branding?: BrandingInput | null }

/**
 * PATCH /api/v1/auth-email-hooks/{id} (R25, MB-60). One UPDATE of the hook row, nothing else
 * written. Branding merges into what is stored (see mergeBranding); null clears it all.
 */
export async function updateAuthHook(deps: Deps, a: AuthContext & { agentId?: string | null }, id: string, input: AuthHookPatch) {
  assertManager(a);
  const h = await deps.db.select().from(authEmailHooks).where(and(eq(authEmailHooks.id, id), eq(authEmailHooks.orgId, a.orgId))).get();
  if (!h) throw notFound("Auth email hook");
  const set: Partial<typeof authEmailHooks.$inferInsert> = {};
  let mb = await deps.db.select().from(mailboxes).where(eq(mailboxes.id, h.mailboxId)).get();
  if (input.from !== undefined) {
    const from = input.from.trim().toLowerCase();
    const next = await deps.db.select().from(mailboxes).where(and(eq(mailboxes.orgId, a.orgId), eq(mailboxes.address, from))).get();
    if (!next) throw bad(`${from} isn't a mailbox in this workspace. Create it first (no-reply@ works well).`);
    if (next.id !== h.mailboxId) set.mailboxId = next.id;
    mb = next;
  }
  if (input.appName !== undefined) {
    const name = input.appName.trim().slice(0, 80);
    if (!name) throw bad("appName can't be empty.");
    if (name !== h.appName) set.appName = name;
  }
  if (input.branding !== undefined) {
    const next = mergeBranding(parseBranding(h.branding), input.branding === null ? null : parseBrandingInput(input.branding));
    const json = next ? JSON.stringify(next) : null;
    if (json !== (h.branding ?? null)) set.branding = json;
  }
  const saved = Object.keys(set).length ? { ...h, ...set } as HookRow : h;
  if (Object.keys(set).length) await deps.db.update(authEmailHooks).set(set).where(and(eq(authEmailHooks.id, id), eq(authEmailHooks.orgId, a.orgId)));
  return presentHook(deps, saved, mb?.address ?? "");
}

/**
 * POST /api/v1/auth-email-hooks/{id}/preview?type=signup (R25, MB-60): the subject, HTML and text a
 * call of that type would send, with a sample link and code. Nothing is sent or written. Pass
 * branding to preview changes before saving them (merged over what is stored, not saved).
 */
export async function previewAuthHook(deps: Deps, orgId: string, id: string, type: string, opts: { email?: string; branding?: unknown } = {}) {
  if (!(AUTH_EMAIL_TYPES as readonly string[]).includes(type)) throw bad(`type must be one of ${AUTH_EMAIL_TYPES.join(", ")}.`);
  const h = await deps.db.select().from(authEmailHooks).where(and(eq(authEmailHooks.id, id), eq(authEmailHooks.orgId, orgId))).get();
  if (!h) throw notFound("Auth email hook");
  const branding = opts.branding !== undefined
    ? mergeBranding(parseBranding(h.branding), opts.branding === null ? null : parseBrandingInput(opts.branding))
    : parseBranding(h.branding);
  const email = (opts.email ?? "").replace(/[\r\n\t]/g, "").trim().toLowerCase().slice(0, 254) || "parent@example.com";
  const codeOnly = type === "reauthentication" || type === "email";
  const link = codeOnly ? null : `${h.supabaseUrl}/auth/v1/verify?token=preview&type=${encodeURIComponent(type)}&redirect_to=`;
  const mail = renderAuthEmail(branding, type, link, "123456", { appName: h.appName, email });
  return { type, to: email, subject: mail.subject, html: mail.html, text: mail.text, replyTo: mail.replyTo ?? null };
}

interface SupabasePayload {
  user?: { email?: string; new_email?: string };
  email_data?: { token?: string; token_hash?: string; redirect_to?: string; email_action_type?: string; site_url?: string; token_new?: string; token_hash_new?: string };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

const COPY: Record<string, { subject: string; lead: string; button: string }> = {
  signup: { subject: "Confirm your email for {app}", lead: "Confirm your email address to finish signing up for {app}.", button: "Confirm email" },
  invite: { subject: "You're invited to {app}", lead: "You have been invited to {app}. Accept the invitation to set up your account.", button: "Accept invitation" },
  magiclink: { subject: "Your sign in link for {app}", lead: "Use this link to sign in to {app}. It works once and expires soon.", button: "Sign in" },
  recovery: { subject: "Reset your {app} password", lead: "Someone asked to reset the password for your {app} account. If it was you, choose a new one.", button: "Reset password" },
  email_change: { subject: "Confirm your email change for {app}", lead: "Confirm this address for your {app} account.", button: "Confirm change" },
  email: { subject: "Your {app} code", lead: "Here is your {app} sign in code.", button: "" },
  reauthentication: { subject: "Your {app} confirmation code", lead: "Enter this code in {app} to confirm it's you.", button: "" },
};

/** One auth email: subject, plain text and simple HTML. Codes only for reauthentication and OTP emails. */
export function authEmail(app: string, type: string, link: string | null, token: string | undefined) {
  const c = COPY[type] ?? { subject: "A message from {app}", lead: "Here is your {app} link.", button: "Open" };
  const fill = (s: string) => s.replaceAll("{app}", app);
  const lines = [fill(c.lead), ""];
  if (link) lines.push(link, "");
  if (token) lines.push(link ? `Or enter this code: ${token}` : `Your code: ${token}`, "");
  lines.push("If you didn't ask for this, you can ignore this email.");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d1d1f;max-width:480px">`
    + `<p>${esc(fill(c.lead))}</p>`
    + (link && c.button ? `<p><a href="${esc(link)}" style="display:inline-block;background:#0071e3;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">${esc(c.button)}</a></p><p style="font-size:13px;color:#6e6e73">Or open this link: ${esc(link)}</p>` : "")
    + (token ? `<p>${link ? "Or enter this code" : "Your code"}: <strong style="font-size:18px;letter-spacing:2px">${esc(token)}</strong></p>` : "")
    + `<p style="font-size:13px;color:#6e6e73">If you didn't ask for this, you can ignore this email.</p></div>`;
  return { subject: fill(c.subject), text: lines.join("\n"), html };
}

/** Handles one signed call from Supabase. Returns what Supabase expects: {} on success, or an error object. */
export async function handleSupabaseHook(deps: Deps, id: string, body: string, headers: Headers): Promise<{ status: 200 | 401 | 404 | 500 | 503; body: unknown }> {
  const h = await deps.db.select({ h: authEmailHooks, mb: mailboxes }).from(authEmailHooks)
    .innerJoin(mailboxes, eq(mailboxes.id, authEmailHooks.mailboxId)).where(eq(authEmailHooks.id, id)).get();
  const fail = (status: 401 | 404 | 500 | 503, message: string) => ({ status, body: { error: { http_code: status, message } } });
  if (!h) return fail(404, "No such hook.");
  // R27: switched off on the Sign-up emails settings page.
  if (h.h.enabled === false) return fail(503, "Auth emails are turned off for this workspace in Multies settings.");
  let payload: SupabasePayload;
  try {
    const secret = await decryptSecret(deps.config.appSecret, h.h.secretEnc);
    payload = new Webhook(secret).verify(body, {
      "webhook-id": headers.get("webhook-id") ?? "", "webhook-timestamp": headers.get("webhook-timestamp") ?? "", "webhook-signature": headers.get("webhook-signature") ?? "",
    }) as SupabasePayload;
  } catch {
    return fail(401, "The hook signature did not verify.");
  }
  const d = payload.email_data ?? {};
  const type = d.email_action_type ?? "";
  const linkFor = (hash: string | undefined) => (hash && type !== "reauthentication" && type !== "email"
    ? `${h.h.supabaseUrl}/auth/v1/verify?token=${encodeURIComponent(hash)}&type=${encodeURIComponent(type)}&redirect_to=${encodeURIComponent(d.redirect_to || d.site_url || "")}`
    : null);
  // Email change with Secure Email Change on sends two emails. The field names are reversed on
  // Supabase's side: token_hash_new goes to the current address with token, token_hash to the new one with token_new.
  const sends: { to: string; link: string | null; token?: string }[] = [];
  if (type === "email_change" && d.token_hash_new && payload.user?.email) {
    sends.push({ to: payload.user.email, link: linkFor(d.token_hash_new), token: d.token });
    if (payload.user.new_email && d.token_hash) sends.push({ to: payload.user.new_email, link: linkFor(d.token_hash), token: d.token_new });
  } else if (type === "email_change" && payload.user?.new_email) {
    sends.push({ to: payload.user.new_email, link: linkFor(d.token_hash), token: d.token });
  } else if (payload.user?.email) {
    sends.push({ to: payload.user.email, link: linkFor(d.token_hash), token: d.token });
  }
  if (!sends.length) return fail(500, "The hook carried no recipient.");
  const actor: AuthContext = { userId: "", email: `auth-hook:${h.h.id}`, name: h.h.appName, orgId: h.h.orgId, role: "admin", sessionId: `authhook:${h.h.id}` };
  try {
    for (const s of sends) {
      const mail = renderAuthEmail(parseBranding(h.h.branding), type, s.link, s.token, { appName: h.h.appName, email: s.to.toLowerCase() });
      await sendMessage(deps, actor, { mailboxId: h.mb.id, to: [s.to.toLowerCase()], subject: mail.subject, text: mail.text, html: mail.html, ...(mail.replyTo ? { replyTo: mail.replyTo } : {}) }, h.h.senderName ? { fromName: h.h.senderName } : {});
    }
  } catch (err) {
    return fail(500, err instanceof Error ? err.message : "Sending failed.");
  }
  if (!h.h.lastUsedAt || deps.now().getTime() - h.h.lastUsedAt.getTime() > 15 * 60_000) {
    await deferrableWrite(deps, "last_used", `hook:${h.h.id}`, () => deps.db.update(authEmailHooks).set({ lastUsedAt: deps.now() }).where(eq(authEmailHooks.id, h.h.id))); // R32: deferrable
  }
  return { status: 200, body: {} };
}

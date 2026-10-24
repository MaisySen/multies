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

type HookRow = typeof authEmailHooks.$inferSelect;

const bad = (message: string) => new HttpError(422, "validation_failed", message);

export interface AuthHookInput { from: string; secret: string; supabaseUrl: string; appName?: string }

function presentHook(deps: Deps, h: HookRow, from: string) {
  return {
    id: h.id, kind: h.kind, from, supabaseUrl: h.supabaseUrl, appName: h.appName,
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
export async function handleSupabaseHook(deps: Deps, id: string, body: string, headers: Headers): Promise<{ status: 200 | 401 | 404 | 500; body: unknown }> {
  const h = await deps.db.select({ h: authEmailHooks, mb: mailboxes }).from(authEmailHooks)
    .innerJoin(mailboxes, eq(mailboxes.id, authEmailHooks.mailboxId)).where(eq(authEmailHooks.id, id)).get();
  const fail = (status: 401 | 404 | 500, message: string) => ({ status, body: { error: { http_code: status, message } } });
  if (!h) return fail(404, "No such hook.");
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
      const mail = authEmail(h.h.appName, type, s.link, s.token);
      await sendMessage(deps, actor, { mailboxId: h.mb.id, to: [s.to.toLowerCase()], subject: mail.subject, text: mail.text, html: mail.html });
    }
  } catch (err) {
    return fail(500, err instanceof Error ? err.message : "Sending failed.");
  }
  if (!h.h.lastUsedAt || deps.now().getTime() - h.h.lastUsedAt.getTime() > 15 * 60_000) {
    await deps.db.update(authEmailHooks).set({ lastUsedAt: deps.now() }).where(eq(authEmailHooks.id, h.h.id));
  }
  return { status: 200, body: {} };
}

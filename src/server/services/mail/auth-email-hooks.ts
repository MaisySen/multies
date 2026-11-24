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
import { authEmailHooks, domains, mailboxes } from "../../db/schema";
import { decryptSecret, encryptSecret, newId } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { sendMessage } from "./send";
import { AUTH_EMAIL_TYPES, BrandingInputSchema, mergeBranding, parseBranding, renderAuthEmail, type BrandingInput } from "./auth-email-branding";
import { deferrableWrite } from "../write-priority";
import { requirePerson } from "../../lib/actor-kind";
import { firstReceipt, releaseReceipt } from "../../lib/webhook-receipts";

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

/**
 * AIS1 (audit row 44): where sign-up emails may come from. An active team mailbox (not someone's personal mailbox, not
 * an AI agent's inbox) on one of the workspace's own verified domains. The platform's shared rows (connected Gmail
 * and other providers, free addresses, the agents' shared domain) belong to the platform, never to the workspace, so
 * their mailboxes never qualify. The Sign-up emails From list, its save, and the v1 hook create and update all use this.
 */
export function senderMailboxCond(orgId: string) {
  return and(eq(mailboxes.orgId, orgId), eq(domains.orgId, orgId), eq(domains.status, "verified"), eq(mailboxes.status, "active"), eq(mailboxes.personal, false), eq(mailboxes.kind, "person"));
}

/** The mailbox at `address` when sign-up emails may come from it (senderMailboxCond), else undefined. */
export async function senderMailbox(deps: Deps, orgId: string, address: string) {
  const row = await deps.db.select({ mb: mailboxes }).from(mailboxes).innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(and(senderMailboxCond(orgId), eq(mailboxes.address, address))).get();
  return row?.mb;
}

/** The words for a hook (or its test send) still pointed at an agent's inbox from before the team-mailbox rule. */
export const AGENT_INBOX_HOOK = "This hook's mailbox is an AI agent's inbox, which can't send sign-up emails. Pick a team mailbox in Multies settings.";

const notASender = (from: string) => bad(`${from} can't send sign-up emails. Use a team mailbox on one of this workspace's verified domains (no-reply@ works well), not an agent's inbox or a connected or personal address.`);

export async function createAuthHook(deps: Deps, a: AuthContext & { agentId?: string | null }, input: AuthHookInput, opts: { id?: string; retry?: boolean } = {}) {
  assertManager(a);
  const from = input.from.trim().toLowerCase();
  // PRIV1b (W1): team mailboxes only. A personal mailbox belongs to its owner; an admin key can't send sign-up mail as them.
  // AIS1 (row 44): and only on the workspace's own verified domains, never an agent's inbox.
  const mb = await senderMailbox(deps, a.orgId, from);
  if (!mb) throw notASender(from);
  if (opts.id && opts.retry) {
    // R55 (MB-239): a retry under the same Idempotency-Key whose first attempt saved the hook gets that hook back. One read, only on a retry.
    const hit = await deps.db.select().from(authEmailHooks).where(and(eq(authEmailHooks.id, opts.id), eq(authEmailHooks.orgId, a.orgId))).get();
    if (hit) return presentHook(deps, hit, mb.address);
  }
  let url: URL;
  try { url = new URL(input.supabaseUrl.trim()); } catch { throw bad("supabaseUrl must be your project URL, for example https://abcd1234.supabase.co"); }
  if (url.protocol !== "https:") throw bad("supabaseUrl must start with https://");
  const secret = normaliseHookSecret(input.secret);
  const row: typeof authEmailHooks.$inferInsert = {
    id: opts.id ?? newId("ahk"), orgId: a.orgId, mailboxId: mb.id, kind: "supabase",
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

/** AIS1 (review 2): what a key or a connected AI app is refused on a hook that still sends from an AI agent's inbox. */
export const AGENT_INBOX_HOOK_EDIT = "Changing sign-up emails that still come from an AI agent's inbox, other than switching them off or moving From to a team mailbox,";

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
    // PRIV1b (W1): as on create, a hook can't move to a personal mailbox. AIS1 (row 44): nor to an agent's inbox or another domain.
    const next = await senderMailbox(deps, a.orgId, from);
    if (!next) throw notASender(from);
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
  // AIS1 (review 2): a hook saved on an AI agent's inbox before row 44 still sends, as the system, outside the agent's
  // rules. A key or a connected AI app may move it to a team mailbox (then mb is that mailbox) or delete it, but not
  // change what it sends while it stays there. A person may. Checked before the write; `mb` is already read.
  if (mb?.kind === "agent" && Object.keys(set).length) requirePerson(a, AGENT_INBOX_HOOK_EDIT);
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
  // PRIV1b (W1): a hook saved before the team-mailbox rule may still point at a personal mailbox; it never sends as one.
  if (h.mb.personal) return fail(503, "This hook's mailbox is a personal mailbox. Pick a team mailbox in Multies settings.");
  // AIS1 (round 2, owner decision): nor as an AI agent. A hook saved on an agent's inbox before senderMailboxCond sent as
  // the system, past the agent's approval rule, send cap and allowed recipients. It stays saved; an admin moves it.
  if (h.mb.kind === "agent") return fail(503, AGENT_INBOX_HOOK);
  let payload: SupabasePayload;
  try {
    const secret = await decryptSecret(deps.config.appSecret, h.h.secretEnc);
    payload = new Webhook(secret).verify(body, {
      "webhook-id": headers.get("webhook-id") ?? "", "webhook-timestamp": headers.get("webhook-timestamp") ?? "", "webhook-signature": headers.get("webhook-signature") ?? "",
    }) as SupabasePayload;
  } catch {
    return fail(401, "The hook signature did not verify.");
  }
  // Round 2: a signed call replayed inside its window is answered as handled and sends nothing again. A failed send
  // below forgets the receipt, so Supabase's retry (same webhook-id) goes through.
  const receipt = `${h.h.id}:${headers.get("webhook-id") ?? ""}`;
  if (!(await firstReceipt(deps.db, "supabase_hook", receipt, deps.now()))) return { status: 200, body: {} };
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
  if (!sends.length) { await releaseReceipt(deps.db, "supabase_hook", receipt); return fail(500, "The hook carried no recipient."); }
  const actor: AuthContext = { userId: "", email: `auth-hook:${h.h.id}`, name: h.h.appName, orgId: h.h.orgId, role: "admin", sessionId: `authhook:${h.h.id}` };
  try {
    for (const s of sends) {
      const mail = renderAuthEmail(parseBranding(h.h.branding), type, s.link, s.token, { appName: h.h.appName, email: s.to.toLowerCase() });
      await sendMessage(deps, actor, { mailboxId: h.mb.id, to: [s.to.toLowerCase()], subject: mail.subject, text: mail.text, html: mail.html, ...(mail.replyTo ? { replyTo: mail.replyTo } : {}) }, h.h.senderName ? { fromName: h.h.senderName } : {});
    }
  } catch (err) {
    await releaseReceipt(deps.db, "supabase_hook", receipt);
    // B8: the caller (Supabase, and through it the person signing up) gets fixed words; the cause stays in our log.
    // An HttpError is one of our own refusals (its words can name the recipient), so only its code is logged.
    deps.log?.error("auth_hook.send_failed", { hookId: h.h.id, error: err instanceof HttpError ? `${err.status} ${err.code}` : (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    if (!(err instanceof HttpError)) deps.reportError?.(err, { where: "auth_hook.send" });
    return fail(500, "Sending failed. Try again in a moment.");
  }
  if (!h.h.lastUsedAt || deps.now().getTime() - h.h.lastUsedAt.getTime() > 15 * 60_000) {
    await deferrableWrite(deps, "last_used", `hook:${h.h.id}`, () => deps.db.update(authEmailHooks).set({ lastUsedAt: deps.now() }).where(eq(authEmailHooks.id, h.h.id))); // R32: deferrable
  }
  return { status: 200, body: {} };
}

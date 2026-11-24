/**
 * R27: the "Sign-up emails" settings page (workspace settings, admins only) over the R25 auth email hook
 * (MB-60). One workspace, one settings record: the newest auth_email_hooks row. The page and the v1 API
 * (GET/PUT /api/v1/auth-email-settings) turn the hook on or off, set the sender name and from-address (a
 * mailbox on one of the workspace's verified domains), the product name, brand colour and logo, the
 * subject and intro line per email type and a second language block, preview each email, send a test to
 * the admin's own address (at most TEST_SENDS_PER_HOUR an hour) and make a new signing secret.
 *
 * The signing secret is shown once, in the answer that made it (create or regenerate), and masked after.
 * It is never written to the audit log, to a log line or to any other answer.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AuthContext, Deps } from "../../context";
import { authEmailHooks, domains, mailboxes, users } from "../../db/schema";
import { decryptSecret, encryptSecret, newId } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { isPersonSession, requirePerson } from "../../lib/actor-kind";
import { AGENT_INBOX_HOOK, AGENT_INBOX_HOOK_EDIT } from "./auth-email-hooks";
import { audit } from "../audit";
import { sendMessage } from "./send";
import { AUTH_EMAIL_TYPES, mergeBranding, parseBranding, renderAuthEmail, type AuthEmailBranding } from "./auth-email-branding";
import { parseBrandingInput, senderMailboxCond } from "./auth-email-hooks";

export const TEST_SENDS_PER_HOUR = 5;
const HOUR = 3_600_000;

type Actor = AuthContext & { agentId?: string | null };
type HookRow = typeof authEmailHooks.$inferSelect;

const bad = (message: string, field?: string) => new HttpError(422, "validation_failed", message, field ? { fields: { [field]: message } } : undefined);
const oneLine = (max: number) => z.string().trim().max(max).refine((s) => ![...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127), "Use one line.");

export const AuthEmailSettingsBody = z.object({
  enabled: z.boolean().optional(),
  senderName: oneLine(80).nullable().optional(),
  from: z.string().trim().toLowerCase().email("from must be an email address.").max(254).optional(),
  appName: oneLine(80).optional(),
  supabaseUrl: z.string().trim().max(200).optional(),
  branding: z.unknown().optional(),
}).strict();
export type AuthEmailSettingsInput = z.infer<typeof AuthEmailSettingsBody>;

/** Owners and admins only: not members, not agent keys, not read only keys. */
export function assertSettingsAdmin(a: Actor) {
  if (a.role === "member" || a.agentId) throw new HttpError(403, "forbidden", "Only workspace owners and admins can change sign-up emails.");
}
function assertWritableKey(a: Actor) {
  if ((a as { scope?: string }).scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
}

/** A new Standard Webhooks secret: whsec_ and 32 random bytes in base64. */
export function newHookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}
/** What the page shows after the first time: the prefix and the last 4 characters. */
export function maskSecret(secret: string): string {
  return `whsec_${"\u2022".repeat(8)}${secret.slice(-4)}`;
}
/** The form Supabase takes in its Send Email Hook settings. */
const supabaseForm = (secret: string) => `v1,${secret}`;

async function currentHook(deps: Deps, orgId: string): Promise<HookRow | undefined> {
  return deps.db.select().from(authEmailHooks).where(eq(authEmailHooks.orgId, orgId)).orderBy(desc(authEmailHooks.createdAt)).limit(1).get();
}

/**
 * Mailboxes on the workspace's verified domains: the addresses auth emails can come from. PRIV1b (W1): team mailboxes
 * only; a person's personal mailbox is theirs, so an admin can neither list it here nor send sign-up emails as it.
 * AIS1 (audit row 44): the workspace's own domains only (a connected Gmail sits on the platform's shared row, which is
 * stored verified, so it used to show up) and never an AI agent's inbox. See senderMailboxCond.
 */
export async function senderMailboxes(deps: Deps, orgId: string) {
  return deps.db.select({ id: mailboxes.id, address: mailboxes.address, displayName: mailboxes.displayName }).from(mailboxes)
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(senderMailboxCond(orgId)).orderBy(mailboxes.address);
}

const recentTests = (h: HookRow, now: number) => {
  try { return (JSON.parse(h.testSends ?? "[]") as number[]).filter((t) => typeof t === "number" && now - t < HOUR); } catch { return []; }
};

async function present(deps: Deps, h: HookRow) {
  const mb = await deps.db.select().from(mailboxes).where(eq(mailboxes.id, h.mailboxId)).get();
  const secret = await decryptSecret(deps.config.appSecret, h.secretEnc).catch(() => "");
  return {
    id: h.id, enabled: h.enabled !== false, senderName: h.senderName ?? null, from: mb?.address ?? "", fromDisplayName: mb?.displayName ?? null,
    appName: h.appName, supabaseUrl: h.supabaseUrl, branding: parseBranding(h.branding) ?? {},
    endpointUrl: `${deps.config.appUrl.replace(/\/$/, "")}/api/auth-hooks/supabase/${h.id}`,
    secret: { set: !!secret, masked: secret ? maskSecret(secret) : null },
    testSendsLeft: Math.max(0, TEST_SENDS_PER_HOUR - recentTests(h, deps.now().getTime()).length),
    lastUsedAt: h.lastUsedAt?.toISOString() ?? null, createdAt: h.createdAt.toISOString(),
  };
}

export async function getAuthEmailSettings(deps: Deps, a: Actor) {
  assertSettingsAdmin(a);
  const h = await currentHook(deps, a.orgId);
  const senders = (await senderMailboxes(deps, a.orgId)).map((m) => ({ address: m.address, displayName: m.displayName }));
  const settings = h ? await present(deps, h) : null;
  return {
    // AIS1 (row 44): a hook saved before the rule keeps sending from where it was, so the owner is told when that From
    // is no longer allowed (an agent's inbox, a connected or personal address, another domain) and can change it.
    settings: settings ? { ...settings, fromAllowed: senders.some((s) => s.address === settings.from) } : null,
    senders,
    types: AUTH_EMAIL_TYPES,
    testSendsPerHour: TEST_SENDS_PER_HOUR,
  };
}

async function senderFor(deps: Deps, orgId: string, from: string) {
  const mb = (await senderMailboxes(deps, orgId)).find((m) => m.address === from);
  if (!mb) throw bad(`${from} isn't a mailbox on one of this workspace's verified domains. Add the domain and a mailbox such as no-reply@ first.`, "from");
  return mb;
}
/** AIS1: whether a hook still sends from an AI agent's inbox (saved there before row 44). One read by primary key. */
async function onAgentInbox(deps: Deps, h: HookRow) {
  return (await deps.db.select({ kind: mailboxes.kind }).from(mailboxes).where(eq(mailboxes.id, h.mailboxId)).get())?.kind === "agent";
}
function cleanSupabaseUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw bad("Use your Supabase project URL, for example https://abcd1234.supabase.co", "supabaseUrl"); }
  if (url.protocol !== "https:") throw bad("The project URL must start with https://", "supabaseUrl");
  return url.origin;
}

/**
 * PUT: creates the settings (and a signing secret, returned once as `secret`) or changes them. Fields left
 * out stay as they are; branding merges as in R25 (null clears it). One audit entry names the fields that
 * changed, never their secret.
 */
export async function putAuthEmailSettings(deps: Deps, a: Actor, raw: unknown, meta: { ip?: string | null } = {}) {
  assertSettingsAdmin(a);
  assertWritableKey(a);
  const parsed = AuthEmailSettingsBody.safeParse(raw ?? {});
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw bad(`${i.path.join(".") || "body"}: ${i.message}`, String(i.path[0] ?? "body"));
  }
  const input = parsed.data;
  const branding = input.branding === undefined ? undefined : input.branding === null ? null : parseBrandingInput(input.branding);
  const h = await currentHook(deps, a.orgId);
  const actor = { orgId: a.orgId, actorUserId: a.userId || null, actorEmail: a.email ?? null, agentId: a.agentId ?? null, ip: meta.ip ?? null };

  if (!h) {
    if (!input.from) throw bad("Pick the address sign-up emails come from.", "from");
    if (!input.supabaseUrl) throw bad("Add your Supabase project URL.", "supabaseUrl");
    const mb = await senderFor(deps, a.orgId, input.from);
    const secret = newHookSecret();
    const merged = mergeBranding(null, branding ?? undefined);
    const row: typeof authEmailHooks.$inferInsert = {
      id: newId("ahk"), orgId: a.orgId, mailboxId: mb.id, kind: "supabase",
      secretEnc: await encryptSecret(deps.config.appSecret, secret), supabaseUrl: cleanSupabaseUrl(input.supabaseUrl),
      appName: (input.appName || mb.displayName || input.from.split("@")[1]).slice(0, 80),
      enabled: input.enabled ?? true, senderName: input.senderName || null, branding: merged ? JSON.stringify(merged) : null,
    };
    await deps.db.insert(authEmailHooks).values(row);
    await audit(deps.db, { ...actor, action: "auth_email_settings.created", targetType: "auth_email_hook", targetId: row.id, metadata: { from: mb.address, enabled: row.enabled } });
    const saved = (await deps.db.select().from(authEmailHooks).where(eq(authEmailHooks.id, row.id)).get())!;
    return { settings: await present(deps, saved), secret: supabaseForm(secret) };
  }

  const set: Partial<typeof authEmailHooks.$inferInsert> = {};
  if (input.enabled !== undefined && input.enabled !== (h.enabled !== false)) set.enabled = input.enabled;
  if (input.senderName !== undefined && (input.senderName || null) !== (h.senderName ?? null)) set.senderName = input.senderName || null;
  if (input.from !== undefined) { const mb = await senderFor(deps, a.orgId, input.from); if (mb.id !== h.mailboxId) set.mailboxId = mb.id; }
  if (input.appName !== undefined) {
    if (!input.appName) throw bad("The product name can't be empty.", "appName");
    if (input.appName !== h.appName) set.appName = input.appName;
  }
  if (input.supabaseUrl !== undefined) { const u = cleanSupabaseUrl(input.supabaseUrl); if (u !== h.supabaseUrl) set.supabaseUrl = u; }
  if (branding !== undefined) {
    const next = mergeBranding(parseBranding(h.branding), branding);
    const json = next ? JSON.stringify(next) : null;
    if (json !== (h.branding ?? null)) set.branding = json;
  }
  // AIS1 (review 2): a hook saved on an AI agent's inbox before row 44 still sends, as the system, outside the agent's
  // rules. A key or a connected AI app may switch it off or move it to a team mailbox (in this same call too), not
  // switch it on or change what it sends while it stays there. Checked before any write.
  if (!isPersonSession(a) && set.mailboxId === undefined && Object.keys(set).some((f) => f !== "enabled" || set.enabled !== false) && await onAgentInbox(deps, h)) {
    requirePerson(a, AGENT_INBOX_HOOK_EDIT);
  }
  const fields = Object.keys(set);
  if (fields.length) {
    await deps.db.update(authEmailHooks).set(set).where(and(eq(authEmailHooks.id, h.id), eq(authEmailHooks.orgId, a.orgId)));
    await audit(deps.db, { ...actor, action: "auth_email_settings.updated", targetType: "auth_email_hook", targetId: h.id, metadata: { fields: fields.map((f) => (f === "mailboxId" ? "from" : f)), ...(set.enabled !== undefined ? { enabled: set.enabled } : {}) } });
  }
  return { settings: await present(deps, { ...h, ...set } as HookRow) };
}

/** POST .../secret: a new signing secret, returned once. The old one stops working at once. */
export async function regenerateAuthEmailSecret(deps: Deps, a: Actor, meta: { ip?: string | null } = {}) {
  assertSettingsAdmin(a);
  assertWritableKey(a);
  const h = await currentHook(deps, a.orgId);
  if (!h) throw notFound("Sign-up email settings");
  // AIS1: a hook saved on an AI agent's inbox before row 44 still sends, as the system, so the agent's approval rule,
  // daily limit and allowed recipients don't apply. A key or a connected AI app must not get a fresh secret for it and
  // sign its own calls. A person may (their own setup, as Compose is). One read by primary key, only for a non-person.
  if (!isPersonSession(a) && await onAgentInbox(deps, h)) {
    requirePerson(a, "A new signing secret for sign-up emails sent from an AI agent's inbox");
  }
  const secret = newHookSecret();
  await deps.db.update(authEmailHooks).set({ secretEnc: await encryptSecret(deps.config.appSecret, secret) }).where(eq(authEmailHooks.id, h.id));
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId || null, actorEmail: a.email ?? null, agentId: a.agentId ?? null, ip: meta.ip ?? null, action: "auth_email_settings.secret_regenerated", targetType: "auth_email_hook", targetId: h.id });
  const saved = (await deps.db.select().from(authEmailHooks).where(eq(authEmailHooks.id, h.id)).get())!;
  return { settings: await present(deps, saved), secret: supabaseForm(secret) };
}

function draftOf(h: HookRow | undefined, draft: { appName?: string; branding?: unknown }) {
  const saved = h ? parseBranding(h.branding) : null;
  const branding: AuthEmailBranding | null = draft.branding === undefined ? saved : mergeBranding(saved, draft.branding === null ? null : parseBrandingInput(draft.branding));
  return { branding, appName: (draft.appName?.trim() || h?.appName || "Your app").slice(0, 80), supabaseUrl: h?.supabaseUrl ?? "https://your-project.supabase.co" };
}
function checkType(type: string) {
  if (!(AUTH_EMAIL_TYPES as readonly string[]).includes(type)) throw bad(`type must be one of ${AUTH_EMAIL_TYPES.join(", ")}.`, "type");
}
function render(type: string, d: ReturnType<typeof draftOf>, email: string) {
  const codeOnly = type === "reauthentication" || type === "email";
  const link = codeOnly ? null : `${d.supabaseUrl}/auth/v1/verify?token=preview&type=${encodeURIComponent(type)}&redirect_to=`;
  return renderAuthEmail(d.branding, type, link, "123456", { appName: d.appName, email });
}

/** POST .../preview: the email one type would send, with unsaved changes merged in. Writes nothing. */
export async function previewAuthEmailSettings(deps: Deps, a: Actor, body: { type?: string; appName?: string; branding?: unknown; email?: string }) {
  assertSettingsAdmin(a);
  const type = body.type || "signup";
  checkType(type);
  const h = await currentHook(deps, a.orgId);
  const email = (body.email ?? "").replace(/[\r\n\t]/g, "").trim().toLowerCase().slice(0, 254) || "parent@example.com";
  const mail = render(type, draftOf(h, body), email);
  return { type, to: email, subject: mail.subject, html: mail.html, text: mail.text, replyTo: mail.replyTo ?? null };
}

/** POST .../test: sends one type, as saved, to the admin's own address. At most TEST_SENDS_PER_HOUR an hour a workspace. */
export async function sendAuthEmailTest(deps: Deps, a: Actor, body: { type?: string }, meta: { ip?: string | null } = {}) {
  assertSettingsAdmin(a);
  assertWritableKey(a);
  const type = body.type || "signup";
  checkType(type);
  let to = (a.email ?? "").trim().toLowerCase();
  // R28: an API key or MCP caller reads as "api-key:<prefix>"; the test goes to the key's creator (still a member).
  if (!to.includes("@") && a.userId) to = ((await deps.db.select({ email: users.email }).from(users).where(eq(users.id, a.userId)).get())?.email ?? "").trim().toLowerCase();
  if (!to || !to.includes("@")) throw bad("Your account has no email address to send the test to.");
  const h = await currentHook(deps, a.orgId);
  if (!h) throw notFound("Sign-up email settings");
  // PRIV1b (W1): an older hook on a personal mailbox never sends a test as its owner. One read by primary key.
  const mb = await deps.db.select({ personal: mailboxes.personal, kind: mailboxes.kind }).from(mailboxes).where(eq(mailboxes.id, h.mailboxId)).get();
  if (mb?.personal) throw bad("Sign-up emails can't come from a personal mailbox. Pick a team mailbox.", "from");
  // AIS1 (round 2): nor an agent's inbox, as the hook itself refuses (handleSupabaseHook).
  if (mb?.kind === "agent") throw new HttpError(503, "sender_not_allowed", AGENT_INBOX_HOOK);
  const now = deps.now().getTime();
  const recent = recentTests(h, now);
  if (recent.length >= TEST_SENDS_PER_HOUR) {
    const wait = Math.ceil((HOUR - (now - Math.min(...recent))) / 60_000);
    throw new HttpError(429, "rate_limited", `That's ${TEST_SENDS_PER_HOUR} test emails this hour. Try again in ${wait} min.`, { retryAfterSeconds: wait * 60 });
  }
  await deps.db.update(authEmailHooks).set({ testSends: JSON.stringify([...recent, now]) }).where(eq(authEmailHooks.id, h.id));
  const mail = render(type, draftOf(h, {}), to);
  const actor: AuthContext = { userId: a.userId, email: a.email, name: a.name, orgId: a.orgId, role: "admin", sessionId: a.sessionId };
  await sendMessage(deps, actor, { mailboxId: h.mailboxId, to: [to], subject: `Test: ${mail.subject}`, text: mail.text, html: mail.html, ...(mail.replyTo ? { replyTo: mail.replyTo } : {}) }, h.senderName ? { fromName: h.senderName } : {});
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId || null, actorEmail: a.email ?? null, agentId: a.agentId ?? null, ip: meta.ip ?? null, action: "auth_email_settings.test_sent", targetType: "auth_email_hook", targetId: h.id, metadata: { type } });
  return { sent: true, to, type, testSendsLeft: TEST_SENDS_PER_HOUR - recent.length - 1 };
}

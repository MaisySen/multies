/**
 * Connecting an existing mailbox (round 18): Gmail, Outlook, Yahoo, iCloud, Zoho, Fastmail, GMX or
 * any IMAP and SMTP server, with an app password (or OAuth, behind MAIL_OAUTH).
 *
 * - The connection is tested (IMAP sign in, then SMTP sign in) before anything is saved.
 * - The password is AES-GCM encrypted with APP_SECRET, never logged, never sent back, and deleted
 *   with the connection.
 * - The mail shows in a Multies mailbox with the person's real address. That mailbox sits on one
 *   shared "connected" domain row owned by the platform workspace, so it never takes a sending
 *   domain slot and inbound routing never treats the address as hosted here.
 * - Sync (sync.ts) copies recent mail in, then new mail on a schedule; replies go out through the
 *   provider's own SMTP (outbound.ts), so they pass SPF and DKIM as the person's own mail.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { assertMailboxNotHeld } from "../mail/archive-r111"; // R111
import type { AuthContext, Deps } from "../../context";
import { mailboxes, mailConnections, messages, mailSyncOutbox } from "../../db/schema";
import { decryptSecret, encryptSecret, newId } from "../../lib/crypto";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../../lib/errors";
import { isPublicHost } from "../../lib/ssrf";
import { audit } from "../audit";
import { ensurePlatformDomain } from "../free-address";
import { getPlan } from "../plans";
import { canOpen, isPersonalOwner, personalInfo, scopeFor } from "../mail-access-priv1a";
import { CONNECT_PRESETS, presetForEmail, serversFor, type ConnectionView, type ConnectPresetId, type ServerSettings } from "@/shared/mail-connect";
import { imapflowConnector, type ImapAuth } from "./imap";
import { nodeSocketOpenerLazy } from "./default-socket";
import { classifyProblem, ConnectFailed } from "./problems";
import { smtpVerify } from "./smtp";
import { backfillProgress } from "./backfill-progress";

/** The shared domain row every connected mailbox sits on. Never resolvable, never sent from. */
export const CONNECTED_DOMAIN = "connected.multies.invalid";

export type Connection = typeof mailConnections.$inferSelect;

export interface ConnectInput {
  email: string;
  password: string;
  preset?: ConnectPresetId;
  /** Defaults to the address. iCloud and some hosts want only the part before @. */
  username?: string;
  displayName?: string;
  imap?: Partial<ServerSettings>;
  smtp?: Partial<ServerSettings>;
}

const EMAIL_RE = /^[^\s@]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function connectEnabled(deps: Deps) { return deps.config.mailConnect.enabled; }

function assertEnabled(deps: Deps) {
  if (!connectEnabled(deps)) throw new HttpError(404, "connect_off", "Connecting an existing mailbox isn't switched on here.");
}

/** Fills presets and checks every field; the result is what gets tested and saved. */
export function resolveSettings(deps: Deps, input: ConnectInput) {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest("Enter the full email address, for example you@gmail.com.");
  if (!input.password || input.password.length > 512) throw badRequest("Enter the app password.");
  const preset: ConnectPresetId = input.preset && CONNECT_PRESETS[input.preset] ? input.preset : presetForEmail(email) ?? "custom";
  const base = serversFor(preset, email);
  const merge = (b: ServerSettings, o: Partial<ServerSettings> | undefined): ServerSettings => ({
    host: (preset === "custom" || o?.host ? o?.host ?? b.host : b.host).trim().toLowerCase(),
    port: Number(o?.port ?? b.port),
    security: o?.security === "starttls" || o?.security === "tls" ? o.security : b.security,
  });
  const imap = merge(base.imap, input.imap);
  const smtp = merge(base.smtp, input.smtp);
  for (const [label, s] of [["incoming (IMAP)", imap], ["outgoing (SMTP)", smtp]] as const) {
    if (!s.host) throw badRequest(`Enter the ${label} server name, for example ${label.startsWith("in") ? "imap" : "smtp"}.example.com.`);
    const privateOk = deps.config.mailConnect.allowPrivateHosts;
    if (!privateOk && (!HOST_RE.test(s.host) || !isPublicHost(s.host))) throw badRequest(`The ${label} server must be a public host name, like mail.example.com.`);
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535 || s.port === 25) throw badRequest(`Use the ${label} port your provider lists (usually ${label.startsWith("in") ? "993" : "465 or 587"}).`);
  }
  const username = (input.username?.trim() || email).slice(0, 320);
  const displayName = (input.displayName?.trim() || email.split("@")[0]).slice(0, 100);
  return { email, preset, imap, smtp, username, displayName, savesSent: CONNECT_PRESETS[preset].savesSent };
}

export type ResolvedSettings = ReturnType<typeof resolveSettings>;

const imapOpts = (deps: Deps) => ({ allowSelfSigned: deps.config.mailConnect.allowSelfSigned });
export const imapConnector = (deps: Deps) => deps.imap ?? imapflowConnector;
export const socketOpener = (deps: Deps) => deps.openSocket ?? nodeSocketOpenerLazy(deps.config.mailConnect.allowSelfSigned);

/** Signs in over IMAP, then SMTP. Throws ConnectFailed with words a person can act on. */
export async function testSettings(deps: Deps, s: Pick<ResolvedSettings, "preset" | "imap" | "smtp" | "username">, auth: { secret: string; xoauth2?: boolean }) {
  const imapAuth: ImapAuth = { user: s.username, secret: auth.secret, xoauth2: auth.xoauth2 };
  try {
    const session = await imapConnector(deps)(s.imap, imapAuth, imapOpts(deps));
    try { await session.folders(); } finally { await session.close(); }
  } catch (err) {
    throw new ConnectFailed(classifyProblem(err, "imap", s.preset, s.imap.host));
  }
  try {
    await smtpVerify(socketOpener(deps), s.smtp, { user: s.username, secret: auth.secret, xoauth2: auth.xoauth2 });
  } catch (err) {
    throw new ConnectFailed(classifyProblem(err, "smtp", s.preset, s.smtp.host));
  }
}

export async function testConnection(deps: Deps, input: ConnectInput) {
  assertEnabled(deps);
  const s = resolveSettings(deps, input);
  await testSettings(deps, s, { secret: input.password });
  return { ok: true as const, preset: s.preset, imap: s.imap, smtp: s.smtp };
}

export function present(c: Connection, mb: { address: string; displayName: string }): ConnectionView {
  return {
    id: c.id, mailboxId: c.mailboxId, email: mb.address, displayName: mb.displayName, provider: c.provider as ConnectPresetId,
    providerLabel: CONNECT_PRESETS[c.provider as ConnectPresetId]?.label ?? "Other server", authKind: c.authKind, status: c.status,
    lastError: c.lastError, lastSyncAt: c.lastSyncAt ? c.lastSyncAt.toISOString() : null, initialDone: c.initialDone,
    messagesSynced: c.messagesSynced, imapHost: c.imapHost, smtpHost: c.smtpHost, createdAt: c.createdAt.toISOString(),
    backfill: backfillProgress(safeState(c.syncState), c.messagesSynced),
    // R41: the demo's sample connection (a .example host); the app offers a one tap Reconnect for it.
    ...(c.imapHost.endsWith(".example") ? { sample: true } : {}),
  };
}

/**
 * Who may manage a connection: the person who connected it, or a workspace owner or admin.
 * PRIV1b (P5, P62): on a personal mailbox the mailbox's owner decides, not whoever connected it: only the owner (nobody
 * on an orphan, P9) changes the sign in or the servers ("change"); admins can still remove it.
 */
async function assertCanManage(deps: Deps, auth: AuthContext, c: Connection, what: "change" | "remove") {
  const own = await isPersonalOwner(deps.db, auth, c.mailboxId);
  if (own === undefined) {
    if (c.createdByUserId === auth.userId || auth.role === "owner" || auth.role === "admin") return;
    throw forbidden("Only the person who connected this mailbox, or a workspace admin, can change it.");
  }
  if (own || (what === "remove" && (auth.role === "owner" || auth.role === "admin"))) return;
  throw forbidden(what === "remove" ? "Only the person this mailbox belongs to, or a workspace admin, can remove it." : "Only the person this mailbox belongs to can change its sign in.");
}

/**
 * PRIV1b (P14, P46): one check for every /:id route. "read" (folders) needs the mailbox open; "run" (sync, older mail,
 * folder choice) needs the owner or a reply share on a personal mailbox, and the connector or an admin on a team one.
 * 404 when the person can't open the mailbox at all.
 */
export async function connectionFor(deps: Deps, auth: AuthContext, id: string, need: "read" | "run") {
  const c = await getConnection(deps, auth, id);
  const personal = need === "run" && (await personalInfo(deps.db, auth.orgId, c.mailboxId)) !== null;
  if (personal && await canOpen(deps.db, auth, c.mailboxId, "reply")) return c;
  if (!await canOpen(deps.db, auth, c.mailboxId, "read")) throw notFound("Connected mailbox");
  if (personal) throw forbidden("This mailbox was shared with you to read only. Ask its owner.");
  if (need === "run" && c.createdByUserId !== auth.userId && auth.role !== "owner" && auth.role !== "admin") throw forbidden("Only the person who connected this mailbox, or a workspace admin, can change it.");
  return c;
}

/** Tests, then saves the connection and its mailbox. The first sync runs right after. */
export async function createConnection(deps: Deps, auth: AuthContext, input: ConnectInput, extra: { secret?: string; authKind?: "password" | "oauth" } = {}) {
  assertEnabled(deps);
  const s = resolveSettings(deps, { ...input, password: input.password || extra.secret || "" });
  const taken = await deps.db.select({ id: mailboxes.id, orgId: mailboxes.orgId }).from(mailboxes).where(eq(mailboxes.address, s.email)).get();
  if (taken) throw conflict(taken.orgId === auth.orgId ? `${s.email} is already in this workspace.` : `${s.email} is already connected to another Multies workspace. Remove it there first.`);
  const secret = extra.secret ?? input.password;
  const authKind = extra.authKind ?? "password";
  if (authKind === "password") await testSettings(deps, s, { secret });
  const plan = await getPlan(deps.db, auth.orgId);
  const domain = await ensurePlatformDomain(deps, CONNECTED_DOMAIN);
  const mailboxId = newId("mbx");
  const id = newId("mcn");
  const [local] = s.email.split("@");
  // PRIV1a: a connected inbox is personal, private to the person who connected it (a workspace key with no person: a team mailbox).
  await deps.db.insert(mailboxes).values({ id: mailboxId, orgId: auth.orgId, domainId: domain.id, localPart: local, address: s.email, displayName: s.displayName, quotaMb: plan.limits.storagePerMailboxMb, personal: !!auth.userId, ownerUserId: auth.userId || null });
  await deps.db.insert(mailConnections).values({
    id, orgId: auth.orgId, mailboxId, provider: s.preset, email: s.email, username: s.username,
    imapHost: s.imap.host, imapPort: s.imap.port, imapSecurity: s.imap.security,
    smtpHost: s.smtp.host, smtpPort: s.smtp.port, smtpSecurity: s.smtp.security,
    authKind, secretEnc: await encryptSecret(deps.config.appSecret, secret), savesSent: s.savesSent,
    status: "active", nextSyncAt: deps.now(), createdByUserId: auth.userId || null,
  });
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "mailbox.connected", targetType: "mailbox", targetId: mailboxId, metadata: { address: s.email, provider: s.preset, authKind } });
  const row = (await deps.db.select().from(mailConnections).where(eq(mailConnections.id, id)).get())!;
  return present(row, { address: s.email, displayName: s.displayName });
}

/**
 * PRIV1b (P14): members get the connections whose mailbox they can open; admins also get the others, reduced to what
 * the admin screens need (no hosts, errors or sync detail). `openable` tells them apart.
 */
export async function listConnections(deps: Deps, auth: AuthContext) {
  const [rows, scope] = await Promise.all([
    deps.db.select({ c: mailConnections, address: mailboxes.address, displayName: mailboxes.displayName }).from(mailConnections)
      .innerJoin(mailboxes, eq(mailboxes.id, mailConnections.mailboxId))
      .where(eq(mailConnections.orgId, auth.orgId)).orderBy(desc(mailConnections.createdAt)),
    scopeFor(deps.db, auth),
  ]);
  const open = scope ? new Set(scope) : null;
  const admin = auth.role === "owner" || auth.role === "admin";
  type Reduced = Pick<ConnectionView, "id" | "mailboxId" | "email" | "status"> & { openable: false };
  return rows.flatMap<(ConnectionView & { openable: true }) | Reduced>((r) => !open || open.has(r.c.mailboxId) ? [{ ...present(r.c, r), openable: true as const }]
    : admin ? [{ id: r.c.id, mailboxId: r.c.mailboxId, email: r.address, status: r.c.status, openable: false as const }] : []);
}

/** PRIV1b (P14, P46): only the connections this person can open, full rows. */
export async function openableConnections(deps: Deps, auth: AuthContext) {
  return (await listConnections(deps, auth)).filter((x): x is ConnectionView & { openable: true } => x.openable);
}

export async function getConnection(deps: Deps, auth: AuthContext, id: string) {
  const c = await deps.db.select().from(mailConnections).where(and(eq(mailConnections.id, id), eq(mailConnections.orgId, auth.orgId))).get();
  if (!c) throw notFound("Connected mailbox");
  return c;
}

/** A new password (or new server settings) for a connection that stopped working. */
export async function reconnect(deps: Deps, auth: AuthContext, id: string, input: { password: string; username?: string; imap?: Partial<ServerSettings>; smtp?: Partial<ServerSettings> }) {
  assertEnabled(deps);
  const c = await getConnection(deps, auth, id);
  await assertCanManage(deps, auth, c, "change");
  // R41: the demo's sample connected mailbox has no provider to check, so Reconnect puts it back to its healthy sample
  // state (one small row update, essential to the demo; nothing is fetched and no password is stored).
  if ((await import("../demo")).isSampleConnection(c)) {
    await deps.db.update(mailConnections).set({ status: "active", lastError: null, initialDone: true, lastSyncAt: deps.now() }).where(eq(mailConnections.id, c.id));
    const smb = (await deps.db.select().from(mailboxes).where(eq(mailboxes.id, c.mailboxId)).get())!;
    return present((await deps.db.select().from(mailConnections).where(eq(mailConnections.id, c.id)).get())!, smb);
  }
  const s = resolveSettings(deps, {
    email: c.email, password: input.password, preset: c.provider as ConnectPresetId, username: input.username ?? c.username,
    imap: { host: c.imapHost, port: c.imapPort, security: c.imapSecurity, ...input.imap },
    smtp: { host: c.smtpHost, port: c.smtpPort, security: c.smtpSecurity, ...input.smtp },
  });
  await testSettings(deps, s, { secret: input.password });
  await deps.db.update(mailConnections).set({
    username: s.username, imapHost: s.imap.host, imapPort: s.imap.port, imapSecurity: s.imap.security,
    smtpHost: s.smtp.host, smtpPort: s.smtp.port, smtpSecurity: s.smtp.security, authKind: "password",
    secretEnc: await encryptSecret(deps.config.appSecret, input.password), status: "active", lastError: null, nextSyncAt: deps.now(),
  }).where(eq(mailConnections.id, c.id));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "mailbox.reconnected", targetType: "mailbox", targetId: c.mailboxId, metadata: { address: c.email } });
  const mb = (await deps.db.select().from(mailboxes).where(eq(mailboxes.id, c.mailboxId)).get())!;
  return present((await deps.db.select().from(mailConnections).where(eq(mailConnections.id, c.id)).get())!, mb);
}

/**
 * Removes a connection: the stored password goes with it, and so does the Multies copy of the
 * mail (the mailbox and its messages). Nothing changes at the provider.
 */
export async function removeConnection(deps: Deps, auth: AuthContext, id: string) {
  const c = await getConnection(deps, auth, id);
  await assertCanManage(deps, auth, c, "remove");
  // R111: a mailbox on legal hold keeps its copy. PRIV1b (P58): but the hold no longer stops the disconnect: the stored
  // password and the sync go now, the mailbox and its held mail stay until the hold is lifted.
  const held = await assertMailboxNotHeld(deps, auth.orgId, c.mailboxId).then(() => false, (err) => {
    if (err instanceof HttpError && err.code === "legal_hold") return true;
    throw err;
  });
  await deps.db.delete(mailConnections).where(eq(mailConnections.id, c.id));
  if (!held) await deps.db.delete(mailboxes).where(and(eq(mailboxes.id, c.mailboxId), eq(mailboxes.orgId, auth.orgId)));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "mailbox.disconnected", targetType: "mailbox", targetId: c.mailboxId, metadata: { address: c.email, ...(held ? { keptForLegalHold: true } : {}) } });
  return { ok: true as const, ...(held ? { keptForLegalHold: true as const } : {}) };
}

export async function connectionForMailbox(deps: Deps, mailboxId: string) {
  return (await deps.db.select().from(mailConnections).where(eq(mailConnections.mailboxId, mailboxId)).get()) ?? null;
}

export async function connectionSecret(deps: Deps, c: Connection) {
  return decryptSecret(deps.config.appSecret, c.secretEnc);
}

/** Connections whose next sync is due, oldest first. One read, no writes. */
export async function dueConnections(deps: Deps, limit = 20) {
  return deps.db.select({ id: mailConnections.id }).from(mailConnections)
    .where(and(sql`${mailConnections.status} in ('active', 'error', 'syncing')`, sql`coalesce(${mailConnections.nextSyncAt}, 0) <= ${deps.now().getTime()}`))
    .orderBy(mailConnections.nextSyncAt).limit(limit);
}

type MessageRow = Pick<typeof messages.$inferSelect, "id" | "mailboxId" | "remoteBox" | "remoteUid">;
export type RemoteAction = (typeof mailSyncOutbox.$inferInsert)["action"];

/** Folder moves: what each queued action does at the provider (round 19 adds spam, inbox and any synced folder). */
const MOVE_DEST: Partial<Record<RemoteAction, string>> = { archive: "archive", trash: "trash", inbox: "inbox", spam: "spam" };

/**
 * Remembers a read, star or move made in Multies on synced mail, so the next sync applies it at
 * the provider. Costs nothing for other mail (the rows are already loaded): one insert per message
 * that came from a connected mailbox. A move also points the message at its new folder straight
 * away (its UID is filled in when the provider answers it), so it lists there at once. A move to a
 * folder the provider doesn't have is applied in Multies only.
 */
export async function queueRemoteChange(deps: Deps, rows: MessageRow[], action: RemoteAction, opts: { dest?: string } = {}) {
  const synced = rows.filter((r) => r.remoteBox && r.remoteUid);
  if (!synced.length) return 0;
  const byMailbox = new Map<string, { id: string; state: { paths?: Record<string, string | undefined>; extra?: string[] } }>();
  for (const mailboxId of new Set(synced.map((r) => r.mailboxId))) {
    const c = await deps.db.select({ id: mailConnections.id, syncState: mailConnections.syncState }).from(mailConnections).where(eq(mailConnections.mailboxId, mailboxId)).get();
    if (c) byMailbox.set(mailboxId, { id: c.id, state: JSON.parse(c.syncState || "{}") });
  }
  const destKey = action === "move" ? opts.dest : MOVE_DEST[action];
  const hasDest = (state: { paths?: Record<string, string | undefined>; extra?: string[] }) => !!destKey && (destKey.startsWith("f:") ? (state.extra ?? []).includes(destKey.slice(2)) : !!state.paths?.[destKey]);
  const values = [];
  const detach: string[] = [];
  for (const r of synced) {
    const conn = byMailbox.get(r.mailboxId);
    if (!conn) continue;
    if (destKey) {
      if (!hasDest(conn.state) || r.remoteBox === destKey) continue;
      detach.push(r.id);
    }
    values.push({ id: newId("mso"), connectionId: conn.id, remoteBox: r.remoteBox!, remoteUid: r.remoteUid!, action, dest: destKey ?? null, messageId: r.id });
  }
  // A few rows per statement: D1 allows 100 bound values per statement.
  for (let i = 0; i < values.length; i += 12) await deps.db.insert(mailSyncOutbox).values(values.slice(i, i + 12));
  if (detach.length && destKey) {
    for (let i = 0; i < detach.length; i += 90) await deps.db.update(messages).set({ remoteBox: destKey, remoteUid: null }).where(inArray(messages.id, detach.slice(i, i + 90)));
  }
  return values.length;
}

function safeState(raw: string | null | undefined) { try { return JSON.parse(raw || "{}") as Parameters<typeof backfillProgress>[0]; } catch { return {}; } }

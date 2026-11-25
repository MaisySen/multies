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
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { assertMailboxNotHeld } from "../mail/archive-r111"; // R111
import type { AuthContext, Deps } from "../../context";
import { apiRateLimits, mailboxes, mailConnections, messages, mailSyncOutbox } from "../../db/schema";
import { decryptSecret, encryptSecret, hmacSha256Hex, newId, safeEqual } from "../../lib/crypto";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../../lib/errors";
import { isPublicHost } from "../../lib/ssrf";
import { audit } from "../audit";
import { ensurePlatformDomain } from "../free-address";
import { getPlan } from "../plans";
import { canOpen, isPersonalOwner, personalInfo, scopeFor } from "../mail-access-priv1a";
import { assertMayRemovePersonal } from "../addresses";
import { CONNECT_PRESETS, cleanAppPassword, presetForEmail, serversFor, type ConnectionLimited, type ConnectionView, type ConnectPresetId, type ConnectProblem, type ServerSettings } from "@/shared/mail-connect";
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
  const password = cleanAppPassword(preset, input.password);
  return { email, preset, imap, smtp, username, displayName, password, savesSent: CONNECT_PRESETS[preset].savesSent };
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
    throw failedTest(deps, classifyProblem(err, "imap", s.preset, s.imap.host), s.preset);
  }
  try {
    await smtpVerify(socketOpener(deps), s.smtp, { user: s.username, secret: auth.secret, xoauth2: auth.xoauth2 });
  } catch (err) {
    throw failedTest(deps, classifyProblem(err, "smtp", s.preset, s.smtp.host), s.preset);
  }
}

/** A failed test is logged with its step, code and preset only: never the provider's words, the password or the address. */
function failedTest(deps: Deps, problem: ConnectProblem, preset: ConnectPresetId) {
  deps.log?.warn("mail_connect.test_failed", { step: problem.step, code: problem.code, preset });
  return new ConnectFailed(problem);
}

export async function testConnection(deps: Deps, input: ConnectInput) {
  assertEnabled(deps);
  const s = resolveSettings(deps, input);
  await testSettings(deps, s, { secret: s.password });
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
 * on an orphan, P9) changes the sign in or the servers ("change").
 * PRIV1b (P59, round 2 owner decision): and only the owner disconnects it ("remove"); once the owner has left, the
 * workspace owner may. Someone who can't open it gets 404, a share 403 (assertMayRemovePersonal).
 */
async function assertCanManage(deps: Deps, auth: AuthContext, c: Connection, what: "change" | "remove") {
  const own = await isPersonalOwner(deps.db, auth, c.mailboxId);
  if (own === undefined) {
    if (c.createdByUserId === auth.userId || auth.role === "owner" || auth.role === "admin") return;
    throw forbidden("Only the person who connected this mailbox, or a workspace admin, can change it.");
  }
  if (own) return;
  if (what === "remove") return assertMayRemovePersonal(deps.db, auth.orgId, c.mailboxId, auth);
  throw forbidden("Only the person this mailbox belongs to can change its sign in.");
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

// ---------------------------------------------------------------- PRIV1b P60: proving the address

/** A connection waiting for its code is removed after this long (the maintenance pass). */
export const PENDING_CONNECTION_MS = 24 * 3_600_000;
const CODE_TTL_MS = 60 * 60_000;
const CODE_MIN_GAP_MS = 60_000;
const CODE_MAX_TRIES = 5;
/** Wave 1 review V5: codes one connection may ask for. */
export const CODES_PER_CONNECTION = 5;
/**
 * Wave 2 review X4: codes one address may receive a day, counted per workspace and per person (so another workspace
 * can't use up the real owner's). Wave 3 review Y7: across everyone, at most WORKSPACES_PER_ADDRESS_DAY distinct
 * workspaces a day may ask (the old cap of 20 codes let the real owner's resends be refused once others used it up).
 */
export const CODES_PER_ADDRESS_WORKSPACE_DAY = 5;
export const CODES_PER_ADDRESS_PERSON_DAY = 5;
export const WORKSPACES_PER_ADDRESS_DAY = 5;
const DAY_MS = 24 * 3_600_000;

/**
 * Wave 1 review V5: counts one emailed code in D1 (api_rate_limits, a fixed 24 hour window swept by maintenance), so
 * restarts and other instances share it. One atomic upsert each; refuses with 429 past a cap, before the code is made
 * or anything else is written. Wave 2 review X4: the address cap was global, so an attacker in another workspace could
 * lock the real owner out every day. Now it counts per (address, workspace) and per (address, person). Wave 3 review
 * Y7: and at most WORKSPACES_PER_ADDRESS_DAY distinct workspaces a day get a place for an address; a workspace with a
 * place gets its CODES_PER_ADDRESS_WORKSPACE_DAY codes (resends included) whatever other workspaces do. Review Z4: a
 * workspace's first code of the day needs no place (so the places can't lock the owner out); the places are for its
 * further codes, taken only after the person and connection caps pass and given back if the request is refused. The
 * flood bound is then CODES_PER_ADDRESS_PERSON_DAY codes per person a day, one per workspace without a place.
 */
export async function claimCodeSend(deps: Deps, who: { email: string; orgId: string; userId?: string | null; connectionId: string | null }) {
  const now = deps.now().getTime();
  const { sha256Hex } = await import("../../lib/crypto");
  const take = async (key: string) => {
    const row = await deps.db.insert(apiRateLimits).values({ key, hits: 1, resetAt: now + DAY_MS })
      .onConflictDoUpdate({ target: apiRateLimits.key, set: {
        hits: sql`case when ${apiRateLimits.resetAt} <= ${now} then 1 else ${apiRateLimits.hits} + 1 end`,
        resetAt: sql`case when ${apiRateLimits.resetAt} <= ${now} then ${now + DAY_MS} else ${apiRateLimits.resetAt} end`,
      } }).returning({ hits: apiRateLimits.hits }).get();
    return row?.hits ?? Number.MAX_SAFE_INTEGER;
  };
  const email = who.email.trim().toLowerCase();
  const addr = await sha256Hex(email);
  const tooMany = () => new HttpError(429, "rate_limited", `We have sent ${who.email} as many codes as we will today. Try again tomorrow.`);
  // Review Z4: the per person and per connection caps first, so a request they refuse never takes a place.
  if (who.userId && await take(`connect-code-addr-user:${addr}:${who.userId}`) > CODES_PER_ADDRESS_PERSON_DAY) throw tooMany();
  if (who.connectionId && await take(`connect-code-conn:${who.connectionId}`) > CODES_PER_CONNECTION) {
    throw new HttpError(429, "rate_limited", "This connection has had as many codes as it can. Remove it and connect the mailbox again.");
  }
  // Review Z4: a workspace's first code for the address today always goes out and takes no place (five other
  // workspaces using every place can't lock the owner out). Y7: further codes need one of the day's few places.
  const wsKey = `connect-code-addr-ws:${addr}:${who.orgId}`;
  const placesKey = `connect-code-addr-wss:${addr}`;
  const placeKey = `connect-code-addr-ws-in:${addr}:${who.orgId}`;
  const live = async (key: string) => { const r = await deps.db.select({ resetAt: apiRateLimits.resetAt }).from(apiRateLimits).where(eq(apiRateLimits.key, key)).get(); return !!r && r.resetAt > now; };
  const giveBack = async () => {
    await deps.db.update(apiRateLimits).set({ hits: sql`max(${apiRateLimits.hits} - 1, 0)` }).where(eq(apiRateLimits.key, placesKey));
    await deps.db.delete(apiRateLimits).where(eq(apiRateLimits.key, placeKey));
  };
  let tookPlace = false;
  if (await live(wsKey) && !(await live(placeKey))) {
    if (await take(placesKey) > WORKSPACES_PER_ADDRESS_DAY) {
      await deps.db.update(apiRateLimits).set({ hits: sql`max(${apiRateLimits.hits} - 1, 0)` }).where(eq(apiRateLimits.key, placesKey));
      throw tooMany();
    }
    await take(placeKey);
    tookPlace = true;
  }
  if (await take(wsKey) > CODES_PER_ADDRESS_WORKSPACE_DAY) {
    if (tookPlace) await giveBack();
    throw tooMany();
  }
}

/**
 * Wave 2 review X2: providers that sign in an address on a company's own domain only once that domain is verified with
 * them (Google Workspace, Microsoft 365), so the address itself as the user name proves it there too.
 */
const DOMAIN_VERIFYING_PRESETS: ReadonlySet<ConnectPresetId> = new Set(["google_workspace", "microsoft365"]);

/** Wave 2 review X2: the user name the provider signs this address in with: the address, or its documented short form. */
function usernameIsAddress(preset: ConnectPresetId, email: string, username: string): boolean {
  const u = username.trim().toLowerCase();
  const e = email.trim().toLowerCase();
  if (u === e) return true;
  // iCloud Mail documents the name before the @ alone as the user name for @icloud.com, @me.com and @mac.com.
  return preset === "icloud" && !u.includes("@") && u === e.split("@")[0];
}

/**
 * PRIV1b (P60): whether signing in proves the address. Only a known provider at its own servers does: Gmail, Outlook and
 * the others check the person's password for that address. "Other server", or a known provider with its servers
 * changed, could be a server anyone runs that accepts any password, so the address is proven by a code instead.
 * Wave 2 review X2: and only when the preset is the address's own provider (or one that verifies the domain, for a
 * company address) and the user name is the address: the Gmail preset with someone else's Gmail user name signs in to
 * their account and proves nothing about ceo@victim.com.
 */
export function serversProveAddress(s: Pick<ResolvedSettings, "preset" | "imap" | "smtp" | "email" | "username">): boolean {
  if (s.preset === "custom") return false;
  const own = presetForEmail(s.email);
  if (own !== s.preset && !(own === null && DOMAIN_VERIFYING_PRESETS.has(s.preset))) return false;
  if (!usernameIsAddress(s.preset, s.email, s.username)) return false;
  const base = serversFor(s.preset, s.email);
  return s.imap.host === base.imap.host.toLowerCase() && s.smtp.host === base.smtp.host.toLowerCase();
}

const connectCodeHash = (deps: Deps, connectionId: string, code: string) => hmacSha256Hex(deps.config.appSecret, `connect-code:${connectionId}:${code}`);

/** Makes a code, keeps its HMAC on the row and emails it to the address through the platform's own sender. */
async function sendConnectCode(deps: Deps, c: Pick<Connection, "id" | "orgId" | "email">) {
  const { newCode } = await import("../tools/esign-v2"); // the 6 digit code the e-signature check uses
  const code = newCode();
  const now = deps.now();
  // Wave 1 review V5: a new code never resets the wrong tries; five wrong codes end the connection's chances.
  await deps.db.update(mailConnections).set({ verifyCodeHash: await connectCodeHash(deps, c.id, code), verifyExpiresAt: new Date(now.getTime() + CODE_TTL_MS), verifySentAt: now })
    .where(eq(mailConnections.id, c.id));
  const { sendSystemEmail } = await import("../system-mail");
  // accountSecurity: inside the platform only to a mailbox at exactly this address, never through an alias or catch all.
  await sendSystemEmail(deps, {
    to: c.email, orgId: c.orgId, accountSecurity: true,
    subject: `Your code to connect ${c.email} to ${deps.config.appName}`,
    text: `Your code is ${code}\n\nSomeone asked to connect ${c.email} to ${deps.config.appName} through a mail server we don't recognise. Enter this code where they connected it to show the address is theirs. It works once, for 1 hour.\n\nIf this wasn't you, ignore this email: without the code the mailbox is not connected and is removed within a day.`,
  });
}

/** Enters the code emailed for a connection waiting on it (P60). Turns the connection and its mailbox on. */
export async function verifyConnection(deps: Deps, auth: AuthContext, id: string, code: unknown) {
  const c = await getConnection(deps, auth, id);
  await assertCanManage(deps, auth, c, "change");
  if (c.status !== "verifying") throw conflict("This mailbox is already confirmed.");
  const now = deps.now();
  const entered = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(entered)) throw badRequest("Enter the 6 digit code from the email.");
  if (!c.verifyCodeHash || !c.verifyExpiresAt || c.verifyExpiresAt.getTime() <= now.getTime()) throw conflict("This code has expired. Ask for a new one.");
  const tooMany = () => new HttpError(429, "too_many_tries", "Too many wrong codes. Remove this connection and connect the mailbox again.");
  if (c.verifyTries >= CODE_MAX_TRIES) throw tooMany();
  // Wave 1 review V5: every guess takes a try in one atomic statement before it is compared, so parallel guesses can't
  // get past the limit (a read then a compare let all of them through).
  const claimed = await deps.db.update(mailConnections).set({ verifyTries: sql`${mailConnections.verifyTries} + 1` })
    .where(and(eq(mailConnections.id, c.id), eq(mailConnections.status, "verifying"), lt(mailConnections.verifyTries, CODE_MAX_TRIES))).returning({ tries: mailConnections.verifyTries }).get();
  if (!claimed) throw tooMany();
  const h = await connectCodeHash(deps, c.id, entered);
  if (!safeEqual(h, c.verifyCodeHash)) {
    const left = CODE_MAX_TRIES - claimed.tries;
    throw badRequest(left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Remove this connection and connect the mailbox again.");
  }
  // Single use: the hash is cleared in the statement that turns it on.
  const won = await deps.db.update(mailConnections).set({ status: "active", verifyCodeHash: null, verifyExpiresAt: null, verifyTries: 0, nextSyncAt: now, verifySuspendedMailbox: false })
    .where(and(eq(mailConnections.id, c.id), eq(mailConnections.verifyCodeHash, h), eq(mailConnections.status, "verifying"))).returning({ id: mailConnections.id });
  if (!won.length) throw conflict("This code was already used.");
  // Wave 2 review X5: only the suspension the wait itself set is cleared; a suspend someone made meanwhile stays.
  if (c.verifySuspendedMailbox) await deps.db.update(mailboxes).set({ status: "active" }).where(and(eq(mailboxes.id, c.mailboxId), eq(mailboxes.orgId, auth.orgId)));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "mailbox.connect_verified", targetType: "mailbox", targetId: c.mailboxId, metadata: { address: c.email } });
  const mb = (await deps.db.select().from(mailboxes).where(eq(mailboxes.id, c.mailboxId)).get())!;
  return present((await deps.db.select().from(mailConnections).where(eq(mailConnections.id, c.id)).get())!, mb);
}

/** A new code for a connection waiting on one, at most one a minute. */
export async function resendConnectionCode(deps: Deps, auth: AuthContext, id: string) {
  const c = await getConnection(deps, auth, id);
  await assertCanManage(deps, auth, c, "change");
  if (c.status !== "verifying") throw conflict("This mailbox is already confirmed.");
  const now = deps.now().getTime();
  if (c.verifySentAt && now - c.verifySentAt.getTime() < CODE_MIN_GAP_MS) {
    const wait = Math.ceil((CODE_MIN_GAP_MS - (now - c.verifySentAt.getTime())) / 1000);
    throw new HttpError(429, "rate_limited", `A code was just sent. You can ask for another in ${wait} seconds.`, { retryAfterSeconds: wait });
  }
  await claimCodeSend(deps, { email: c.email, orgId: c.orgId, userId: auth.userId || null, connectionId: c.id });
  await sendConnectCode(deps, c);
  return { sent: true as const };
}

/** The maintenance pass: connections still waiting for their code after PENDING_CONNECTION_MS go, with their mailbox. */
export async function pruneUnverifiedConnections(deps: Deps, limit = 50): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - PENDING_CONNECTION_MS);
  const rows = await deps.db.select({ id: mailConnections.id, mailboxId: mailConnections.mailboxId, madeMailbox: mailConnections.madeMailbox }).from(mailConnections)
    .where(and(eq(mailConnections.status, "verifying"), lt(mailConnections.createdAt, cutoff))).limit(limit).all();
  for (const r of rows) await dropPending(deps, r);
  return rows.length;
}

/**
 * Removes a connection that never got its code, and the mailbox it made (nothing was synced into it). Wave 1 review
 * V4: a kept copy it took over (a legal hold kept it after its connection was removed) is never deleted with it: it
 * stays, suspended, as it was before. Wave 2 review X6: nor is a mailbox it made that holds any message or a legal
 * hold (mail got in some other way): it stays too, suspended. Two reads, only for a mailbox the connection made.
 */
async function dropPending(deps: Deps, r: { id: string; mailboxId: string; madeMailbox: boolean }) {
  const gone = await deps.db.delete(mailConnections).where(and(eq(mailConnections.id, r.id), eq(mailConnections.status, "verifying"))).returning({ id: mailConnections.id, orgId: mailConnections.orgId, email: mailConnections.email });
  if (!gone.length) return;
  if (r.madeMailbox && !(await mailboxKeeps(deps, gone[0].orgId, r.mailboxId))) await deps.db.delete(mailboxes).where(eq(mailboxes.id, r.mailboxId));
  // Wave 3 review Y6: one it made that must stay keeps its mail, off the address it never proved.
  else if (r.madeMailbox) await keepOffAddress(deps, gone[0].orgId, r.mailboxId, gone[0].email, "dropped");
  else await deps.db.update(mailboxes).set({ status: "suspended" }).where(eq(mailboxes.id, r.mailboxId));
}

/** Wave 3 review Y6: the non-routable address a kept mailbox moves to; the original stays readable in it and in the audit. */
export const releasedAddress = (address: string, mailboxId: string) =>
  `${address.toLowerCase().replace("@", "=").replace(/[^a-z0-9.=_-]/g, "-").slice(0, 120)}+${mailboxId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}@released.invalid`;

/**
 * Wave 3 review Y6: a mailbox made by a connection that never proved its address, kept because it holds mail or a
 * legal hold, stays (suspended, its data untouched) but gives the address up, so its real owner can connect it.
 */
async function keepOffAddress(deps: Deps, orgId: string, mailboxId: string, address: string, why: "dropped" | "removed") {
  const to = releasedAddress(address, mailboxId);
  await deps.db.update(mailboxes).set({ status: "suspended", address: to }).where(eq(mailboxes.id, mailboxId));
  await audit(deps.db, { orgId, actorUserId: null, action: "mailbox.address_released", targetType: "mailbox", targetId: mailboxId, metadata: { address, renamedTo: to, why } }).catch(() => undefined);
}

/** Wave 2 review X6: a mailbox that holds any message or a legal hold is never deleted with a waiting connection. */
async function mailboxKeeps(deps: Deps, orgId: string, mailboxId: string): Promise<boolean> {
  if (await deps.db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, mailboxId)).limit(1).get()) return true;
  return assertMailboxNotHeld(deps, orgId, mailboxId).then(() => false, (err: unknown) => {
    if (err instanceof HttpError && err.code === "legal_hold") return true;
    throw err;
  });
}

/** Tests, then saves the connection and its mailbox. The first sync runs right after. */
export async function createConnection(deps: Deps, auth: AuthContext, input: ConnectInput, extra: { secret?: string; authKind?: "password" | "oauth" } = {}) {
  assertEnabled(deps);
  const s = resolveSettings(deps, { ...input, password: input.password || extra.secret || "" });
  // PRIV1b (P60): a connection still waiting for its code holds no claim on the address: it proved nothing, so a new
  // connect replaces it (Wave 1 review V4: never taking a kept copy from its owner, below). Nothing synced into it.
  const pending = await deps.db.select({ id: mailConnections.id, mailboxId: mailConnections.mailboxId, orgId: mailConnections.orgId, madeMailbox: mailConnections.madeMailbox }).from(mailConnections)
    .innerJoin(mailboxes, eq(mailboxes.id, mailConnections.mailboxId)).where(and(eq(mailboxes.address, s.email), eq(mailConnections.status, "verifying"))).get();
  const taken = await deps.db.select({ id: mailboxes.id, orgId: mailboxes.orgId, domainId: mailboxes.domainId, personal: mailboxes.personal, ownerUserId: mailboxes.ownerUserId }).from(mailboxes).where(eq(mailboxes.address, s.email)).get();
  // PRIV1b (P58): a copy kept for a legal hold after its connection was removed goes back to whoever it belongs to (the
  // personal owner; an admin or key for a team one) when they connect the address again, held or not.
  const mine = !!taken && taken.orgId === auth.orgId && (taken.personal ? !!auth.userId && taken.ownerUserId === auth.userId : !auth.userId || auth.role === "owner" || auth.role === "admin")
    && (await ensurePlatformDomain(deps, CONNECTED_DOMAIN)).id === taken.domainId;
  // Wave 1 review V4: a waiting connection is replaced only when that can't take anything from anyone: in this workspace,
  // or, from another workspace, only when it made its own (empty) mailbox. A kept copy it took over is never deleted:
  // its owner takes it over again, anyone else is refused.
  const replacing = !!pending && !!taken && taken.id === pending.mailboxId && (pending.orgId === auth.orgId || pending.madeMailbox) && (pending.madeMailbox || mine);
  // Wave 2 review X6: a waiting connection's own mailbox that holds mail or a hold stays when it is replaced: its owner
  // takes it over like a kept copy; anyone else is refused, as for an address in use.
  const pendingKeeps = replacing && pending!.madeMailbox && await mailboxKeeps(deps, pending!.orgId, pending!.mailboxId);
  const kept = mine && (replacing ? !pending!.madeMailbox || pendingKeeps : !(await connectionForMailbox(deps, taken!.id))) ? taken!.id : null;
  if (taken && !kept && (!replacing || pendingKeeps)) throw conflict(taken.orgId === auth.orgId ? `${s.email} is already in this workspace.` : `${s.email} is already connected to another Multies workspace. Remove it there first.`);
  const secret = extra.secret ?? s.password;
  const authKind = extra.authKind ?? "password";
  if (authKind === "password") await testSettings(deps, s, { secret });
  // PRIV1b (P60): an unrecognised server proves nothing about the address: the connection waits for an emailed code.
  const needsCode = authKind === "password" && !serversProveAddress(s);
  const id = newId("mcn");
  if (needsCode) await claimCodeSend(deps, { email: s.email, orgId: auth.orgId, userId: auth.userId || null, connectionId: id }); // Wave 1 review V5: before anything is written
  if (replacing) await dropPending(deps, pending!);
  const plan = await getPlan(deps.db, auth.orgId);
  const domain = await ensurePlatformDomain(deps, CONNECTED_DOMAIN);
  const mailboxId = kept ?? newId("mbx");
  const [local] = s.email.split("@");
  // PRIV1a: a connected inbox is personal, private to the person who connected it (a workspace key with no person: a team mailbox).
  if (kept) await deps.db.update(mailboxes).set({ status: needsCode ? "suspended" : "active", displayName: s.displayName }).where(eq(mailboxes.id, kept));
  else await deps.db.insert(mailboxes).values({ id: mailboxId, orgId: auth.orgId, domainId: domain.id, localPart: local, address: s.email, displayName: s.displayName, quotaMb: plan.limits.storagePerMailboxMb, personal: !!auth.userId, ownerUserId: auth.userId || null, ...(needsCode ? { status: "suspended" as const } : {}) });
  await deps.db.insert(mailConnections).values({
    id, orgId: auth.orgId, mailboxId, provider: s.preset, email: s.email, username: s.username,
    imapHost: s.imap.host, imapPort: s.imap.port, imapSecurity: s.imap.security,
    smtpHost: s.smtp.host, smtpPort: s.smtp.port, smtpSecurity: s.smtp.security,
    authKind, secretEnc: await encryptSecret(deps.config.appSecret, secret), savesSent: s.savesSent,
    status: needsCode ? "verifying" : "active", nextSyncAt: needsCode ? null : deps.now(), createdByUserId: auth.userId || null, madeMailbox: !kept, verifySuspendedMailbox: needsCode,
  });
  if (needsCode) await sendConnectCode(deps, { id, orgId: auth.orgId, email: s.email });
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "mailbox.connected", targetType: "mailbox", targetId: mailboxId, metadata: { address: s.email, provider: s.preset, authKind, ...(needsCode ? { waitingForCode: true } : {}) } });
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
  return rows.flatMap<(ConnectionView & { openable: true }) | ConnectionLimited>((r) => !open || open.has(r.c.mailboxId) ? [{ ...present(r.c, r), openable: true as const }]
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
  await testSettings(deps, s, { secret: s.password });
  // Wave 1 review V3 (P60): a connection still waiting for its code keeps waiting (a new password proves nothing about
  // the address), and moving to servers that don't prove the address asks for a new emailed code.
  const hostChanged = s.imap.host !== c.imapHost.toLowerCase() || s.smtp.host !== c.smtpHost.toLowerCase();
  // Wave 2 review X2: a new user name is a new account at the provider, so it has to prove the address too.
  const userChanged = s.username.trim().toLowerCase() !== c.username.trim().toLowerCase();
  const reverify = c.status !== "verifying" && (hostChanged || userChanged) && !serversProveAddress(s);
  const waits = c.status === "verifying" || reverify;
  if (reverify) await claimCodeSend(deps, { email: c.email, orgId: c.orgId, userId: auth.userId || null, connectionId: c.id }); // Wave 1 review V5: before anything is written
  // Wave 2 review X5: the code turns the mailbox back on only when this wait is what suspends it.
  const wasOn = reverify && (await deps.db.select({ status: mailboxes.status }).from(mailboxes).where(eq(mailboxes.id, c.mailboxId)).get())?.status === "active";
  await deps.db.update(mailConnections).set({
    username: s.username, imapHost: s.imap.host, imapPort: s.imap.port, imapSecurity: s.imap.security,
    smtpHost: s.smtp.host, smtpPort: s.smtp.port, smtpSecurity: s.smtp.security, authKind: "password",
    secretEnc: await encryptSecret(deps.config.appSecret, s.password), status: waits ? "verifying" : "active", lastError: null, nextSyncAt: waits ? null : deps.now(),
    ...(reverify ? { verifySuspendedMailbox: wasOn } : {}),
  }).where(eq(mailConnections.id, c.id));
  if (reverify) {
    await deps.db.update(mailboxes).set({ status: "suspended" }).where(and(eq(mailboxes.id, c.mailboxId), eq(mailboxes.orgId, auth.orgId)));
    await sendConnectCode(deps, c);
  }
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "mailbox.reconnected", targetType: "mailbox", targetId: c.mailboxId, metadata: { address: c.email, ...(waits ? { waitingForCode: true } : {}) } });
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
  // Wave 3 review Y6: a held mailbox this connection made while still waiting for its code keeps its mail, off the address.
  else if (c.status === "verifying" && c.madeMailbox) await keepOffAddress(deps, auth.orgId, c.mailboxId, c.email, "removed");
  // PRIV1b (P58): the kept copy can't send (no connection to send through); connecting the address again reattaches it.
  else await deps.db.update(mailboxes).set({ status: "suspended" }).where(and(eq(mailboxes.id, c.mailboxId), eq(mailboxes.orgId, auth.orgId)));
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

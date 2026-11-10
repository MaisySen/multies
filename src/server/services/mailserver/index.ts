/**
 * Mail app access (IMAP and SMTP for Outlook, Apple Mail, Thunderbird and phones),
 * served by Stalwart. Multies provisions a server account per mailbox on first use,
 * and people sign in to their mail apps with app passwords created here.
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { AuthContext, Deps } from "../../context";
import { appPasswords, domains, mailboxes, mailServerAccounts } from "../../db/schema";
import { decryptSecret, encryptSecret, newId, randomToken } from "../../lib/crypto";
import { HttpError, conflict, forbidden, notFound } from "../../lib/errors";
import { assertMailboxAccess } from "../team";
import { isPersonalOwner } from "../mail-access-priv1a";
import { StalwartClient, StalwartError, type Credentials } from "./stalwart";

export const MAX_APP_PASSWORDS_PER_MAILBOX = 20;

export function mailServerClient(deps: Deps): StalwartClient | null {
  const c = deps.config.mailServer;
  if (!c.enabled || !c.url || !c.adminUser || !c.adminSecret) return null;
  return new StalwartClient({ url: c.url, admin: { user: c.adminUser, secret: c.adminSecret }, fetch: deps.fetch });
}

function requireClient(deps: Deps): StalwartClient {
  const client = mailServerClient(deps);
  if (!client) throw new HttpError(409, "mail_server_not_connected", "Mail app access is not set up on this server yet.");
  return client;
}

/** Turns a mail server failure into a clean API error. */
export async function viaMailServer<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StalwartError) throw new HttpError(502, "mail_server_error", e.message);
    throw e;
  }
}

/** What a mail app needs, plus whether the server is connected. */
export function mailAccessSettings(deps: Deps) {
  const c = deps.config.mailServer;
  return {
    enabled: c.enabled,
    missing: c.missing,
    imap: { host: c.clientHost, port: c.imapPort, security: "ssl" as const },
    smtp: { host: c.clientHost, port: c.smtpPort, security: c.smtpSecurity },
  };
}

async function mailboxWithDomain(deps: Deps, orgId: string, mailboxId: string) {
  const row = await deps.db.select({ m: mailboxes, domainName: domains.name }).from(mailboxes)
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, orgId))).get();
  if (!row) throw notFound("Mailbox");
  return row;
}

/** The mailbox's server account, created on first use. Returns credentials to act as it. */
export async function ensureServerAccount(deps: Deps, orgId: string, mailboxId: string): Promise<{ accountId: string; creds: Credentials }> {
  const { m, domainName } = await mailboxWithDomain(deps, orgId, mailboxId);
  const existing = await deps.db.select().from(mailServerAccounts).where(eq(mailServerAccounts.mailboxId, m.id)).get();
  if (existing) {
    return { accountId: existing.serverAccountId, creds: { user: m.address, secret: await decryptSecret(deps.config.appSecret, existing.secretEnc) } };
  }
  const client = requireClient(deps);
  const secret = randomToken(32);
  const domainId = await client.ensureDomain(domainName);
  const found = await client.findAccount(m.localPart, domainId);
  if (found) {
    // An account with this address exists on the server but not in our records (for
    // example after a restore). We cannot read its password, so we adopt it with a new one.
    await client.call([["x:Account/set", { update: { [found]: { credentials: { 0: { "@type": "Password", secret } } } } }, "s"]]);
  }
  const accountId = found ?? await client.createUser({
    localPart: m.localPart, domainId, secret, quotaBytes: m.quotaMb * 1024 * 1024, description: `Multies mailbox ${m.id}`,
  });
  await deps.db.insert(mailServerAccounts).values({
    mailboxId: m.id, orgId, serverAccountId: accountId, secretEnc: await encryptSecret(deps.config.appSecret, secret),
  }).onConflictDoNothing();
  return { accountId, creds: { user: m.address, secret } };
}

export function presentAppPassword(p: typeof appPasswords.$inferSelect) {
  return { id: p.id, mailboxId: p.mailboxId, name: p.name, hint: p.hint, createdAt: p.createdAt, createdByUserId: p.createdByUserId };
}

export async function listAppPasswords(deps: Deps, auth: AuthContext, mailboxId: string) {
  await mailboxWithDomain(deps, auth.orgId, mailboxId);
  await assertMailboxAccess(deps.db, auth, mailboxId);
  // PRIV1b (P6): on a personal mailbox the owner sees every app password; anyone else sees only their own.
  const own = await isPersonalOwner(deps.db, auth, mailboxId);
  const rows = await deps.db.select().from(appPasswords)
    .where(and(eq(appPasswords.orgId, auth.orgId), eq(appPasswords.mailboxId, mailboxId), own === false ? eq(appPasswords.createdByUserId, auth.userId) : undefined))
    .orderBy(desc(appPasswords.createdAt));
  return rows.map(presentAppPassword);
}

/** Creates an app password. The secret is returned once and never stored by Multies. */
export async function createAppPassword(deps: Deps, auth: AuthContext, mailboxId: string, name: string) {
  const { m } = await mailboxWithDomain(deps, auth.orgId, mailboxId);
  await assertMailboxAccess(deps.db, auth, mailboxId);
  // PRIV1b (P6): an app password is full IMAP and SMTP (send as, delete), past every share level, so on a personal
  // mailbox only its owner makes one.
  if (await isPersonalOwner(deps.db, auth, mailboxId) === false) throw forbidden("Only the person this mailbox belongs to can create app passwords for it.");
  if (m.status !== "active") throw conflict("This mailbox is suspended.");
  const count = (await deps.db.select({ id: appPasswords.id }).from(appPasswords).where(eq(appPasswords.mailboxId, m.id))).length;
  if (count >= MAX_APP_PASSWORDS_PER_MAILBOX) throw conflict(`A mailbox can have up to ${MAX_APP_PASSWORDS_PER_MAILBOX} app passwords. Revoke one you no longer use.`);
  const client = requireClient(deps);
  const { creds } = await viaMailServer(() => ensureServerAccount(deps, auth.orgId, m.id));
  const made = await viaMailServer(() => client.createAppPassword(creds, `${name} (Multies)`));
  const id = newId("apw");
  await deps.db.insert(appPasswords).values({
    id, orgId: auth.orgId, mailboxId: m.id, createdByUserId: auth.userId, name, serverCredentialId: made.id, hint: made.secret.slice(-4),
  });
  const row = await deps.db.select().from(appPasswords).where(eq(appPasswords.id, id)).get();
  return { appPassword: presentAppPassword(row!), secret: made.secret, username: m.address, settings: mailAccessSettings(deps) };
}

export async function revokeAppPassword(deps: Deps, auth: AuthContext, id: string) {
  const p = await deps.db.select().from(appPasswords).where(and(eq(appPasswords.id, id), eq(appPasswords.orgId, auth.orgId))).get();
  if (!p) throw notFound("App password");
  // PRIV1b (P6, P42): on a personal mailbox its owner revokes any app password on it; anyone else only their own.
  const own = await isPersonalOwner(deps.db, auth, p.mailboxId);
  if (own === undefined) {
    await assertMailboxAccess(deps.db, auth, p.mailboxId);
    if (auth.role === "member" && p.createdByUserId !== auth.userId) throw forbidden("Only the person who created this app password, or an admin, can revoke it.");
  } else if (!own && p.createdByUserId !== auth.userId) {
    await assertMailboxAccess(deps.db, auth, p.mailboxId);
    throw forbidden("Only the person who created this app password, or the person this mailbox belongs to, can revoke it.");
  }
  await destroyAppPasswordRow(deps, p);
  return presentAppPassword(p);
}

async function destroyAppPasswordRow(deps: Deps, p: typeof appPasswords.$inferSelect) {
  const client = mailServerClient(deps);
  if (client) {
    const { creds } = await viaMailServer(() => ensureServerAccount(deps, p.orgId, p.mailboxId));
    await viaMailServer(() => client.destroyAppPassword(creds, p.serverCredentialId));
  }
  await deps.db.delete(appPasswords).where(eq(appPasswords.id, p.id));
}

/**
 * PRIV1b (P6, P42): app passwords on personal mailboxes made by someone other than the owner (the workspace owner when
 * the mailbox has none): ones a delegate made before P6, ones from before the mailbox became personal (0164), ones of
 * an owner who left. As a SQL condition on app_passwords joined to mailboxes as m.
 */
// PRIV1b (M1): coalesce, since created_by_user_id is SET NULL when its maker's account goes; NULL = owner would be
// NULL and keep the row forever.
const FOREIGN = sql`m.personal = 1 and not (
  (exists (select 1 from members x where x.user_id = m.owner_user_id and x.organization_id = m.org_id) and coalesce(${appPasswords.createdByUserId}, '') = m.owner_user_id)
  or (not exists (select 1 from members x where x.user_id = m.owner_user_id and x.organization_id = m.org_id)
    and exists (select 1 from members o where o.user_id = ${appPasswords.createdByUserId} and o.organization_id = m.org_id and o.role = 'owner')))`;

async function destroyForeign(deps: Deps, where: SQL, limit: number) {
  const m = alias(mailboxes, "m");
  const rows = await deps.db.select({ p: appPasswords }).from(appPasswords).innerJoin(m, eq(m.id, appPasswords.mailboxId))
    .where(and(FOREIGN, where)).limit(limit);
  let gone = 0;
  for (const { p } of rows) {
    try { await destroyAppPasswordRow(deps, p); gone++; } catch (err) { deps.reportError?.(err, { where: "app_passwords.destroy_foreign", appPassword: p.id }); }
  }
  return gone;
}

/**
 * PRIV1b (P6): destroys the app passwords on one personal mailbox that its owner didn't make. Called when a share is
 * removed (and for the lifecycle paths: owner left, mailbox handed over). Nothing for a team mailbox.
 */
export async function destroyForeignAppPasswords(deps: Deps, orgId: string, mailboxId: string) {
  return destroyForeign(deps, and(eq(appPasswords.orgId, orgId), eq(appPasswords.mailboxId, mailboxId))!, MAX_APP_PASSWORDS_PER_MAILBOX * 5);
}

/** PRIV1b (P42): the same for the whole deployment, a few a pass, from the maintenance run. One indexed read when none. */
export async function sweepForeignAppPasswords(deps: Deps, limit = 20) {
  return destroyForeign(deps, sql`1 = 1`, limit);
}

/** Removes the mailbox's server account (and with it every app password). Call before deleting the mailbox. */
export async function deprovisionMailbox(deps: Deps, orgId: string, mailboxId: string) {
  const acct = await deps.db.select().from(mailServerAccounts)
    .where(and(eq(mailServerAccounts.mailboxId, mailboxId), eq(mailServerAccounts.orgId, orgId))).get();
  if (!acct) return false;
  const client = requireClient(deps);
  await viaMailServer(() => client.destroyAccount(acct.serverAccountId));
  await deps.db.delete(mailServerAccounts).where(eq(mailServerAccounts.mailboxId, mailboxId));
  return true;
}

/** Keeps the server's disk quota in line with the mailbox's. */
export async function syncQuota(deps: Deps, orgId: string, mailboxId: string, quotaMb: number) {
  const acct = await deps.db.select().from(mailServerAccounts)
    .where(and(eq(mailServerAccounts.mailboxId, mailboxId), eq(mailServerAccounts.orgId, orgId))).get();
  const client = mailServerClient(deps);
  if (!acct || !client) return;
  await viaMailServer(() => client.setUserQuota(acct.serverAccountId, quotaMb * 1024 * 1024));
}

/**
 * Copies an inbound message into the mailbox's server account so mail apps see it.
 * Only for mailboxes that have mail app access turned on. Failures are reported,
 * never bounced: the message is already safely stored in Multies.
 */
export async function mirrorInbound(deps: Deps, mailboxId: string, raw: Uint8Array, opts: { spam?: boolean } = {}) {
  const client = mailServerClient(deps);
  if (!client) return false;
  const acct = await deps.db.select().from(mailServerAccounts).where(eq(mailServerAccounts.mailboxId, mailboxId)).get();
  if (!acct) return false;
  try {
    const m = await deps.db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
    if (!m) return false;
    const creds = { user: m.address, secret: await decryptSecret(deps.config.appSecret, acct.secretEnc) };
    await client.importToInbox(creds, raw, opts);
    return true;
  } catch (e) {
    deps.reportError?.(e, { where: "mirrorInbound", mailboxId });
    return false;
  }
}

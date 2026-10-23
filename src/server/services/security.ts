import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import type { Deps } from "../context";
import type { DB } from "../db";
import { authTokens, recoveryCodes, sessions, users } from "../db/schema";
import { decryptSecret, encryptSecret, hashPassword, newId, randomBytes, randomToken, sha256Hex, verifyPassword } from "../lib/crypto";
import { badRequest, HttpError, notFound } from "../lib/errors";
import { newTotpSecret, otpauthUri, verifyTotp } from "../lib/totp";
import { describeUserAgent } from "@/shared/user-agent";
import { sendSystemEmail } from "./system-mail";

type Kind = "password_reset" | "email_verify" | "mfa_ticket";
const TTL: Record<Kind, number> = {
  password_reset: 60 * 60_000,
  email_verify: 3 * 24 * 60 * 60_000,
  mfa_ticket: 10 * 60_000,
};
const MAX_MFA_ATTEMPTS = 5;

async function issueToken(db: DB, userId: string, kind: Kind, now: Date, data?: string) {
  // One live token of each kind per user: issuing a new one retires the old.
  await db.update(authTokens).set({ usedAt: now }).where(and(eq(authTokens.userId, userId), eq(authTokens.kind, kind), isNull(authTokens.usedAt)));
  const token = randomToken(32);
  await db.insert(authTokens).values({ id: newId("tok"), userId, kind, tokenHash: await sha256Hex(token), data: data ?? null, expiresAt: new Date(now.getTime() + TTL[kind]) });
  return token;
}

async function findToken(db: DB, token: string, kind: Kind, now: Date) {
  const row = await db.select().from(authTokens)
    .where(and(eq(authTokens.tokenHash, await sha256Hex(token)), eq(authTokens.kind, kind))).get();
  if (!row || row.usedAt || row.expiresAt <= now) return null;
  return row;
}

const userById = (db: DB, id: string) => db.select().from(users).where(eq(users.id, id)).get();

/** Delivery outcome as the UI sees it; `devLink` only in development mode. */
export interface LinkDelivery { emailed: boolean; devLink?: string }

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Starts a reset. The response never says whether the account exists. The link is
 * only ever emailed — except in development mode, where it is returned for testing.
 */
export async function requestPasswordReset(deps: Deps, email: string): Promise<LinkDelivery> {
  const { db, config } = deps;
  const user = await db.select().from(users).where(eq(users.email, email.toLowerCase())).get();
  if (!user) return { emailed: deps.outbound.name !== "log" };
  const token = await issueToken(db, user.id, "password_reset", deps.now());
  const link = `${config.appUrl}/reset-password/${token}`;
  const mail = await sendSystemEmail(deps, {
    to: user.email,
    subject: `Reset your ${config.appName} password`,
    text: `Someone (hopefully you) asked to reset the password for ${user.email}.\n\nThe link works for one hour. If you didn't ask for this, ignore this email; your password stays the same.`,
    action: { label: "Choose a new password", url: link },
  });
  return { emailed: mail.delivered, ...(config.mode === "development" ? { devLink: link } : {}) };
}

/** A reset link minted by the platform operator for a user who can't receive mail. */
export async function operatorResetLink(deps: Deps, userId: string) {
  const user = await userById(deps.db, userId);
  if (!user) throw notFound("User");
  return `${deps.config.appUrl}/reset-password/${await issueToken(deps.db, user.id, "password_reset", deps.now())}`;
}

export async function describeResetToken(db: DB, token: string, now: Date) {
  const row = await findToken(db, token, "password_reset", now);
  if (!row) throw new HttpError(410, "token_invalid", "This reset link has expired or was already used. Request a new one.");
  const user = await userById(db, row.userId);
  const [local, domain] = (user?.email ?? "").split("@");
  return { email: `${local.slice(0, 2)}${"•".repeat(Math.max(1, local.length - 2))}@${domain}`, mfa: !!user?.totpEnabledAt };
}

/** Completes a reset: new password, every session signed out, the email counts as verified. */
export async function completePasswordReset(db: DB, token: string, password: string, now: Date) {
  const row = await findToken(db, token, "password_reset", now);
  if (!row) throw new HttpError(410, "token_invalid", "This reset link has expired or was already used. Request a new one.");
  await db.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id));
  const user = (await userById(db, row.userId))!;
  await db.update(users).set({
    passwordHash: await hashPassword(password), passwordChangedAt: now, emailVerifiedAt: user.emailVerifiedAt ?? now,
  }).where(eq(users.id, row.userId));
  await db.delete(sessions).where(eq(sessions.userId, row.userId));
  return user;
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export async function sendVerificationEmail(deps: Deps, userId: string): Promise<LinkDelivery & { alreadyVerified?: boolean }> {
  const { db, config } = deps;
  const user = await userById(db, userId);
  if (!user) throw notFound("User");
  if (user.emailVerifiedAt) return { emailed: false, alreadyVerified: true };
  const token = await issueToken(db, user.id, "email_verify", deps.now(), user.email);
  const link = `${config.appUrl}/verify-email/${token}`;
  const mail = await sendSystemEmail(deps, {
    to: user.email,
    subject: `Confirm your email for ${config.appName}`,
    text: `Hi ${user.name.split(" ")[0]}, confirm that ${user.email} is your address so we can reach you about your account.`,
    action: { label: "Confirm email", url: link },
  });
  return { emailed: mail.delivered, ...(config.mode === "development" ? { devLink: link } : {}) };
}

export async function verifyEmail(db: DB, token: string, now: Date) {
  const row = await findToken(db, token, "email_verify", now);
  if (!row) throw new HttpError(410, "token_invalid", "This confirmation link has expired or was already used.");
  const user = await userById(db, row.userId);
  if (!user || user.email !== row.data) throw new HttpError(410, "token_invalid", "This link is for an address that's no longer on the account.");
  await db.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id));
  await db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, user.id));
  return user;
}

// ---------------------------------------------------------------------------
// Two-factor authentication (TOTP + recovery codes)
// ---------------------------------------------------------------------------

export async function beginTotpSetup(deps: Deps, userId: string) {
  const user = await userById(deps.db, userId);
  if (!user) throw notFound("User");
  if (user.totpEnabledAt) throw badRequest("Two-factor authentication is already on.");
  const secret = newTotpSecret();
  await deps.db.update(users).set({ totpPendingEnc: await encryptSecret(deps.config.appSecret, secret) }).where(eq(users.id, userId));
  return { secret, uri: otpauthUri(secret, user.email, deps.config.appName) };
}

function newRecoveryCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = randomBytes(10);
  const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
const normCode = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, "");

async function replaceRecoveryCodes(db: DB, userId: string) {
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  const codes = Array.from({ length: 10 }, newRecoveryCode);
  for (const c of codes) await db.insert(recoveryCodes).values({ id: newId("rc"), userId, codeHash: await sha256Hex(normCode(c)) });
  return codes;
}

export async function confirmTotpSetup(deps: Deps, userId: string, code: string) {
  const user = await userById(deps.db, userId);
  if (!user?.totpPendingEnc) throw badRequest("Start two-factor setup first.");
  const secret = await decryptSecret(deps.config.appSecret, user.totpPendingEnc);
  const step = await verifyTotp(secret, code, deps.now());
  if (step === null) throw new HttpError(422, "validation_failed", "That code didn't match. Check your phone's clock and try the newest code.", { fields: { code: "That code didn't match." } });
  await deps.db.update(users).set({ totpSecretEnc: user.totpPendingEnc, totpPendingEnc: null, totpEnabledAt: deps.now(), totpLastStep: step }).where(eq(users.id, userId));
  return replaceRecoveryCodes(deps.db, userId);
}

async function checkPassword(db: DB, userId: string, password: string) {
  const user = await userById(db, userId);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new HttpError(422, "validation_failed", "That password is incorrect.", { fields: { password: "That password is incorrect." } });
  }
  return user;
}

export async function disableTotp(db: DB, userId: string, password: string) {
  await checkPassword(db, userId, password);
  await db.update(users).set({ totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null }).where(eq(users.id, userId));
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
}

export async function regenerateRecoveryCodes(db: DB, userId: string, password: string) {
  const user = await checkPassword(db, userId, password);
  if (!user.totpEnabledAt) throw badRequest("Turn on two-factor authentication first.");
  return replaceRecoveryCodes(db, userId);
}

export async function remainingRecoveryCodes(db: DB, userId: string) {
  return (await db.select({ id: recoveryCodes.id }).from(recoveryCodes).where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))).length;
}

/** After a correct password on a 2FA account: a short-lived ticket instead of a session. */
export async function issueMfaTicket(db: DB, userId: string, now: Date) {
  return issueToken(db, userId, "mfa_ticket", now, "0");
}

/** Redeems a ticket with a TOTP code or a recovery code. Returns the user id on success. */
export async function redeemMfaTicket(deps: Deps, ticket: string, code: string): Promise<{ userId: string; usedRecoveryCode: boolean }> {
  const { db } = deps;
  const now = deps.now();
  const row = await findToken(db, ticket, "mfa_ticket", now);
  if (!row) throw new HttpError(401, "mfa_expired", "That sign-in attempt expired. Enter your password again.");
  const user = await userById(db, row.userId);
  if (!user?.totpSecretEnc) throw new HttpError(401, "mfa_expired", "That sign-in attempt expired. Enter your password again.");
  const fail = async () => {
    const attempts = Number(row.data ?? "0") + 1;
    await db.update(authTokens).set({ data: String(attempts), usedAt: attempts >= MAX_MFA_ATTEMPTS ? now : null }).where(eq(authTokens.id, row.id));
    if (attempts >= MAX_MFA_ATTEMPTS) throw new HttpError(401, "mfa_expired", "Too many wrong codes. Enter your password again.");
    throw new HttpError(422, "validation_failed", "That code didn't work.", { fields: { code: "That code didn't work." } });
  };
  const clean = code.trim();
  if (/^\d{6}$/.test(clean.replace(/\s/g, ""))) {
    const secret = await decryptSecret(deps.config.appSecret, user.totpSecretEnc);
    const step = await verifyTotp(secret, clean, now, user.totpLastStep);
    if (step === null) return fail();
    await db.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id));
    await db.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id));
    return { userId: user.id, usedRecoveryCode: false };
  }
  const hash = await sha256Hex(normCode(clean));
  const rc = await db.select().from(recoveryCodes).where(and(eq(recoveryCodes.userId, user.id), eq(recoveryCodes.codeHash, hash), isNull(recoveryCodes.usedAt))).get();
  if (!rc) return fail();
  await db.update(recoveryCodes).set({ usedAt: now }).where(eq(recoveryCodes.id, rc.id));
  await db.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id));
  return { userId: user.id, usedRecoveryCode: true };
}

// ---------------------------------------------------------------------------
// Sessions & devices
// ---------------------------------------------------------------------------

export async function listSessions(db: DB, userId: string, currentId: string, now: Date) {
  const rows = await db.select().from(sessions).where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now))).orderBy(desc(sessions.lastSeenAt));
  return rows.map((s) => ({
    id: s.id, ip: s.ip, userAgent: s.userAgent, device: describeUserAgent(s.userAgent),
    createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === currentId,
  }));
}

export async function revokeSession(db: DB, userId: string, sessionId: string, currentId: string) {
  if (sessionId === currentId) throw badRequest("To end this session, sign out.");
  const s = await db.select().from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId))).get();
  if (!s) throw notFound("Session");
  await db.delete(sessions).where(and(eq(sessions.id, sessionId), ne(sessions.id, currentId)));
}

export async function securityOverview(db: DB, userId: string) {
  const user = await userById(db, userId);
  if (!user) throw notFound("User");
  return {
    emailVerified: !!user.emailVerifiedAt,
    emailVerifiedAt: user.emailVerifiedAt,
    twoFactor: { enabled: !!user.totpEnabledAt, enabledAt: user.totpEnabledAt, recoveryCodesLeft: user.totpEnabledAt ? await remainingRecoveryCodes(db, userId) : 0 },
    passwordChangedAt: user.passwordChangedAt ?? user.createdAt,
  };
}

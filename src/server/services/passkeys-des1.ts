/**
 * DES1 passkeys (WebAuthn) for the web app, flag PASSKEY_DES1. Our own session layer, so the identity provider's
 * shared tenant (staging and production) is not changed.
 *
 * - The relying party is this deployment's APP_URL: rpId is its host, the expected origin is its origin, exactly.
 * - User verification is required on add and on sign in (Face ID, fingerprint, the device PIN or the security key PIN).
 * - Challenges are single use and short lived: a random nonce in an HttpOnly cookie names a row in `verifications`
 *   (stored as a SHA-256 hash), and the row is deleted in the same statement that reads it, so a replay finds nothing.
 * - Only public material is stored (credential id, COSE public key, counter, transports). A counter that goes back is
 *   refused and audited (a cloned authenticator).
 * - The WebAuthn library is loaded inside these calls only (dynamic import), so the Worker's startup cost is unchanged.
 * - Recovery is the normal sign in. Nothing here can sign anyone in without a verified passkey assertion.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Deps } from "../context";
import { members, sessions, users, verifications } from "../db/schema";
import { passkeysDes1 } from "../db/schema-des1";
import { HttpError } from "../lib/errors";
import { newId } from "../lib/crypto";
import { audit } from "./audit";

export const PK_COOKIE = "mymail_pk_des1";
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const MAX_PASSKEYS = 10;
/** A passkey can be removed only from a session signed in during the last 15 minutes (Better Auth's freshAge). */
export const FRESH_MS = 15 * 60_000;
const ALGS = [-7, -8, -257]; // ES256, EdDSA, RS256

type Purpose = "reg" | "auth";
interface Stored { c: string; p: Purpose; u?: string }

export function relyingParty(appUrl: string): { rpID: string; origin: string } {
  const u = new URL(appUrl);
  return { rpID: u.hostname, origin: u.origin };
}

const lib = () => import("@simplewebauthn/server");

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function sha(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}
const ident = async (nonce: string) => `pkdes1:${await sha(nonce)}`;
export const isNonce = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(v);

async function saveChallenge(deps: Deps, stored: Stored): Promise<string> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = deps.now().getTime();
  await deps.db.insert(verifications).values({ id: newId("vrf"), identifier: await ident(nonce), value: JSON.stringify(stored), expiresAt: new Date(now + CHALLENGE_TTL_MS) });
  return nonce;
}

/** Burns the challenge: one atomic delete; a second use (or a racing one) finds nothing. */
async function takeChallenge(deps: Deps, nonce: unknown, purpose: Purpose): Promise<Stored> {
  if (!isNonce(nonce)) throw new HttpError(400, "challenge_missing", "That took too long. Try again.");
  const row = await deps.db.delete(verifications).where(eq(verifications.identifier, await ident(nonce)))
    .returning({ value: verifications.value, expiresAt: verifications.expiresAt }).get();
  if (!row) throw new HttpError(400, "challenge_used", "That took too long. Try again.");
  if (new Date(row.expiresAt).getTime() <= deps.now().getTime()) throw new HttpError(400, "challenge_expired", "That took too long. Try again.");
  let s: Stored;
  try { s = JSON.parse(row.value) as Stored; } catch { throw new HttpError(400, "challenge_used", "That took too long. Try again."); }
  if (s.p !== purpose || typeof s.c !== "string") throw new HttpError(400, "challenge_used", "That took too long. Try again.");
  return s;
}

/** A short device hint for the list, from what the authenticator told us (no tracking, no AAGUID lookups). */
export function deviceHint(row: { transports: string | null; deviceType: string | null; backedUp: boolean }): string {
  let t: string[];
  try { t = row.transports ? (JSON.parse(row.transports) as string[]) : []; } catch { t = []; }
  if (row.backedUp || row.deviceType === "multiDevice") return "Synced passkey";
  if (t.includes("usb") || t.includes("nfc") || t.includes("ble")) return "Security key";
  if (t.includes("internal")) return "This device only";
  return "Passkey";
}

export function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? [...v].filter((ch) => { const n = ch.charCodeAt(0); return n > 31 && n !== 127; }).join("").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return s || fallback;
}

export function defaultName(ua: string | undefined): string {
  const u = ua ?? "";
  if (/iPhone|iPad/.test(u)) return "iPhone or iPad";
  if (/Mac OS X/.test(u)) return "Mac";
  if (/Android/.test(u)) return "Android phone";
  if (/Windows/.test(u)) return "Windows computer";
  if (/CrOS/.test(u)) return "Chromebook";
  return "Passkey";
}

async function firstOrg(deps: Deps, userId: string): Promise<string | null> {
  const s = await deps.db.select({ org: sessions.activeOrganizationId }).from(sessions)
    .where(and(eq(sessions.userId, userId), sql`${sessions.activeOrganizationId} is not null`)).orderBy(desc(sessions.updatedAt)).limit(1).get();
  if (s?.org) {
    const m = await deps.db.select({ id: members.id }).from(members).where(and(eq(members.userId, userId), eq(members.organizationId, s.org))).get();
    if (m) return s.org;
  }
  const m = await deps.db.select({ org: members.organizationId }).from(members).where(eq(members.userId, userId)).orderBy(asc(members.createdAt)).limit(1).get();
  return m?.org ?? null;
}

async function note(deps: Deps, orgId: string | null, e: { userId: string; email?: string | null; action: string; targetId?: string; ip?: string | null; metadata?: Record<string, unknown> }) {
  if (!orgId) { deps.log?.info(e.action, { user: e.userId }); return; }
  await audit(deps.db, { orgId, actorUserId: e.userId, actorEmail: e.email ?? null, action: e.action, targetType: "passkey", targetId: e.targetId, ip: e.ip ?? null, metadata: e.metadata });
}

export interface Who { userId: string; email: string; name: string; orgId: string; sessionId: string }

export async function listPasskeys(deps: Deps, userId: string) {
  const rows = await deps.db.select().from(passkeysDes1).where(eq(passkeysDes1.userId, userId)).orderBy(asc(passkeysDes1.createdAt)).limit(MAX_PASSKEYS + 5).all();
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, device: deviceHint(r) }));
}

export async function registrationOptions(deps: Deps, who: Who) {
  const existing = await deps.db.select({ credentialId: passkeysDes1.credentialId, transports: passkeysDes1.transports }).from(passkeysDes1).where(eq(passkeysDes1.userId, who.userId)).all();
  if (existing.length >= MAX_PASSKEYS) throw new HttpError(409, "passkey_limit", `You can keep up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
  const { generateRegistrationOptions } = await lib();
  const { rpID } = relyingParty(deps.config.appUrl);
  const options = await generateRegistrationOptions({
    rpName: deps.config.appName || "Multies",
    rpID,
    userName: who.email,
    userDisplayName: who.name || who.email,
    userID: new TextEncoder().encode(who.userId),
    attestationType: "none",
    timeout: CHALLENGE_TTL_MS,
    excludeCredentials: existing.map((e) => ({ id: e.credentialId, transports: parseTransports(e.transports) })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    supportedAlgorithmIDs: ALGS,
  });
  const nonce = await saveChallenge(deps, { c: options.challenge, p: "reg", u: who.userId });
  return { options, nonce };
}

function parseTransports(t: string | null) {
  try { return t ? (JSON.parse(t) as ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[]) : undefined; } catch { return undefined; }
}

export async function registerPasskey(deps: Deps, who: Who, nonce: unknown, body: { response?: unknown; name?: unknown }, meta: { ip?: string | null; ua?: string }) {
  const stored = await takeChallenge(deps, nonce, "reg");
  if (stored.u !== who.userId) throw new HttpError(400, "challenge_used", "That took too long. Try again.");
  if (!body.response || typeof body.response !== "object") throw new HttpError(400, "bad_request", "Something went wrong. Try again.");
  const { verifyRegistrationResponse } = await lib();
  const rp = relyingParty(deps.config.appUrl);
  let v;
  try {
    v = await verifyRegistrationResponse({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
      expectedChallenge: stored.c, expectedOrigin: rp.origin, expectedRPID: rp.rpID,
      requireUserVerification: true, supportedAlgorithmIDs: ALGS,
    });
  } catch (err) {
    deps.log?.warn("passkey.add_refused", { reason: String(err instanceof Error ? err.message : err).slice(0, 120) });
    await note(deps, who.orgId, { userId: who.userId, email: who.email, action: "passkey.add_refused", ip: meta.ip });
    throw new HttpError(400, "passkey_refused", "That passkey could not be checked. Try again.");
  }
  if (!v.verified || !v.registrationInfo) throw new HttpError(400, "passkey_refused", "That passkey could not be checked. Try again.");
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const count = await deps.db.select({ n: sql<number>`count(*)` }).from(passkeysDes1).where(eq(passkeysDes1.userId, who.userId)).get();
  if ((count?.n ?? 0) >= MAX_PASSKEYS) throw new HttpError(409, "passkey_limit", `You can keep up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
  const dup = await deps.db.select({ id: passkeysDes1.id }).from(passkeysDes1).where(eq(passkeysDes1.credentialId, credential.id)).get();
  if (dup) throw new HttpError(409, "passkey_exists", "This passkey is already added.");
  const id = newId("pk");
  const now = deps.now();
  await deps.db.insert(passkeysDes1).values({
    id, userId: who.userId, credentialId: credential.id, publicKey: b64url(credential.publicKey), counter: credential.counter,
    transports: credential.transports?.length ? JSON.stringify(credential.transports) : null,
    deviceType: credentialDeviceType, backedUp: !!credentialBackedUp, name: cleanName(body.name, defaultName(meta.ua)), createdAt: now,
  });
  await note(deps, who.orgId, { userId: who.userId, email: who.email, action: "passkey.added", targetId: id, ip: meta.ip });
  return { id };
}

export async function authenticationOptions(deps: Deps) {
  const { generateAuthenticationOptions } = await lib();
  const { rpID } = relyingParty(deps.config.appUrl);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required", timeout: CHALLENGE_TTL_MS, allowCredentials: [] });
  const nonce = await saveChallenge(deps, { c: options.challenge, p: "auth" });
  return { options, nonce };
}

/** Verifies a sign in assertion and answers the person it belongs to; the caller opens the session. */
export async function verifyAuthentication(deps: Deps, nonce: unknown, body: { response?: unknown }, meta: { ip?: string | null }) {
  const stored = await takeChallenge(deps, nonce, "auth");
  const resp = body.response as { id?: unknown } | undefined;
  const credId = resp && typeof resp.id === "string" && resp.id.length <= 1400 ? resp.id : null;
  const generic = () => new HttpError(401, "passkey_refused", "That passkey did not work here. Sign in another way, then add it again in Account and security.");
  if (!credId) throw generic();
  const row = await deps.db.select().from(passkeysDes1).where(eq(passkeysDes1.credentialId, credId)).get();
  if (!row) { deps.log?.warn("passkey.unknown_credential", {}); throw generic(); }
  const user = await deps.db.select({ id: users.id, email: users.email, banned: users.banned }).from(users).where(eq(users.id, row.userId)).get();
  const orgId = await firstOrg(deps, row.userId);
  const fail = async (reason: string) => {
    await note(deps, orgId, { userId: row.userId, email: user?.email, action: reason === "counter" ? "passkey.counter_regression" : "passkey.sign_in_failed", targetId: row.id, ip: meta.ip, metadata: { reason } });
    return generic();
  };
  if (!user || user.banned) throw await fail("user");
  const { verifyAuthenticationResponse } = await lib();
  const rp = relyingParty(deps.config.appUrl);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
      expectedChallenge: stored.c, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
      credential: { id: row.credentialId, publicKey: fromB64url(row.publicKey), counter: row.counter, transports: parseTransports(row.transports) },
    });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    deps.log?.warn("passkey.sign_in_refused", { reason: msg.slice(0, 120) });
    throw await fail(/counter/i.test(msg) ? "counter" : "verify");
  }
  if (!v.verified) throw await fail("verify");
  const next = v.authenticationInfo.newCounter;
  // The library refuses a counter that did not go up when either side is not zero; this keeps the rule here as well.
  if ((next > 0 || row.counter > 0) && next <= row.counter) throw await fail("counter");
  await deps.db.update(passkeysDes1).set({ counter: next, lastUsedAt: deps.now(), backedUp: !!v.authenticationInfo.credentialBackedUp }).where(eq(passkeysDes1.id, row.id));
  await note(deps, orgId, { userId: row.userId, email: user.email, action: "passkey.signed_in", targetId: row.id, ip: meta.ip });
  return { userId: row.userId, orgId, passkeyId: row.id };
}

async function own(deps: Deps, userId: string, id: string) {
  const row = await deps.db.select({ id: passkeysDes1.id, name: passkeysDes1.name }).from(passkeysDes1).where(and(eq(passkeysDes1.id, id), eq(passkeysDes1.userId, userId))).get();
  if (!row) throw new HttpError(404, "not_found", "Passkey not found.");
  return row;
}

export async function renamePasskey(deps: Deps, who: Who, id: string, name: unknown, meta: { ip?: string | null }) {
  const row = await own(deps, who.userId, id);
  const clean = cleanName(name, "");
  if (!clean) throw new HttpError(400, "bad_name", "Give the passkey a name.");
  await deps.db.update(passkeysDes1).set({ name: clean }).where(eq(passkeysDes1.id, row.id));
  await note(deps, who.orgId, { userId: who.userId, email: who.email, action: "passkey.renamed", targetId: row.id, ip: meta.ip });
  return { ok: true };
}

export async function removePasskey(deps: Deps, who: Who, id: string, meta: { ip?: string | null }) {
  const row = await own(deps, who.userId, id);
  const s = await deps.db.select({ createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.id, who.sessionId)).get();
  const age = s ? deps.now().getTime() - new Date(s.createdAt).getTime() : Infinity;
  if (!(age >= 0 && age <= FRESH_MS)) throw new HttpError(403, "reauth_required", "For your safety, sign in again to remove a passkey.");
  await deps.db.delete(passkeysDes1).where(and(eq(passkeysDes1.id, row.id), eq(passkeysDes1.userId, who.userId)));
  await note(deps, who.orgId, { userId: who.userId, email: who.email, action: "passkey.removed", targetId: row.id, ip: meta.ip });
  return { ok: true };
}

/**
 * R99: app passwords for calendar and contacts sync. One person in one workspace; shown once, only a SHA-256
 * hash kept (the password is random, about 99 bits, so a slow hash adds nothing), named, last used shown,
 * revoked at once by deleting the row. The account password never opens /dav.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { davAppPasswords, members, users } from "../../db/schema";
import { safeEqual, sha256Hex } from "../../lib/crypto";
import { forbidden, HttpError, notFound } from "../../lib/errors";
import { audit } from "../audit";
import { isPerson } from "../suite/calendar-sync";
import { sortableId, type SuiteActor } from "../suite/common";
import { featureOn } from "../console/flags";

export const MAX_APP_PASSWORDS = 10;
/** last_used_at is written at most this often, so a phone polling every few minutes costs no write. */
export const LAST_USED_EVERY_MS = 10 * 60_000;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function davEnabled(deps: Deps) { return featureOn(deps, "davSync"); } // OPS1 feature flags: the platform wide value (a global switch)
export function assertDavEnabled(deps: Deps) {
  if (!davEnabled(deps)) throw new HttpError(404, "feature_off", "Calendar and contacts sync is not turned on here yet.");
}

/** Four groups of five letters and digits, without look alike characters (0, o, 1, l, i). */
export function newAppPassword(): string {
  const out: string[] = [];
  const buf = new Uint8Array(64);
  while (out.length < 20) {
    crypto.getRandomValues(buf);
    for (const b of buf) { if (b < 248 && out.length < 20) out.push(ALPHABET[b % ALPHABET.length]); }
  }
  return [0, 5, 10, 15].map((i) => out.slice(i, i + 5).join("")).join("-");
}
/** What the hash is taken of: lower case, without spaces or dashes (people retype it on a phone). */
export const canonical = (pw: string) => pw.toLowerCase().replace(/[\s-]/g, "");
export const hashAppPassword = (pw: string) => sha256Hex(`dav:${canonical(pw)}`);

export interface AppPasswordView { id: string; name: string; hint: string; createdAt: string; lastUsedAt: string | null }
const present = (r: typeof davAppPasswords.$inferSelect): AppPasswordView => ({
  id: r.id, name: r.name, hint: r.hint, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
});

/** People only: not a workspace key, not an agent. Guests are not members, so they never reach these routes. */
async function personOnly(deps: Deps, actor: SuiteActor) {
  if (!isPerson(actor)) throw forbidden("App passwords belong to a person. Sign in to Multies to make one.");
  const m = await deps.db.select({ kind: members.kind }).from(members).where(and(eq(members.organizationId, actor.orgId), eq(members.userId, actor.userId))).get();
  if (!m || m.kind !== "human") throw forbidden("Only people in this workspace can sync their calendar and contacts.");
}

export const davServerUrl = (deps: Deps) => `${deps.config.appUrl.replace(/\/$/, "")}/dav/`;

export async function listAppPasswords(deps: Deps, actor: SuiteActor) {
  assertDavEnabled(deps);
  await personOnly(deps, actor);
  const rows = await deps.db.select().from(davAppPasswords).where(and(eq(davAppPasswords.orgId, actor.orgId), eq(davAppPasswords.userId, actor.userId)))
    .orderBy(desc(davAppPasswords.createdAt)).limit(MAX_APP_PASSWORDS + 5);
  return { passwords: rows.map(present), server: davServerUrl(deps), username: actor.email, max: MAX_APP_PASSWORDS };
}

export async function createAppPassword(deps: Deps, actor: SuiteActor, input: { name: string }, ip?: string | null) {
  assertDavEnabled(deps);
  await personOnly(deps, actor);
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) throw new HttpError(422, "validation_failed", "Give it a name, like the device you will use it on.");
  const mine = await deps.db.select({ id: davAppPasswords.id }).from(davAppPasswords).where(and(eq(davAppPasswords.orgId, actor.orgId), eq(davAppPasswords.userId, actor.userId))).limit(MAX_APP_PASSWORDS + 1);
  if (mine.length >= MAX_APP_PASSWORDS) throw new HttpError(422, "too_many", `You can have up to ${MAX_APP_PASSWORDS} app passwords. Revoke one you no longer use.`);
  const password = newAppPassword();
  const now = deps.now();
  const row = { id: sortableId("dap", now.getTime()), orgId: actor.orgId, userId: actor.userId, name, tokenHash: await hashAppPassword(password), hint: password.slice(-4), createdAt: now, lastUsedAt: null };
  await deps.db.insert(davAppPasswords).values(row);
  await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId, actorEmail: actor.email, action: "dav.app_password.created", targetType: "dav_app_password", targetId: row.id, metadata: { name }, ip: ip ?? null });
  return { password, item: present(row), server: davServerUrl(deps), username: actor.email };
}

export async function revokeAppPassword(deps: Deps, actor: SuiteActor, id: string, ip?: string | null) {
  assertDavEnabled(deps);
  await personOnly(deps, actor);
  const row = await deps.db.select().from(davAppPasswords).where(and(eq(davAppPasswords.id, id), eq(davAppPasswords.orgId, actor.orgId), eq(davAppPasswords.userId, actor.userId))).get();
  if (!row) throw notFound("App password");
  await deps.db.delete(davAppPasswords).where(eq(davAppPasswords.id, row.id));
  await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId, actorEmail: actor.email, action: "dav.app_password.revoked", targetType: "dav_app_password", targetId: row.id, metadata: { name: row.name }, ip: ip ?? null });
  return { id: row.id, revoked: true as const };
}

/** Who an app password signs in, checked on every request (a person who left the workspace is refused at once). */
export interface DavPrincipal { passwordId: string; orgId: string; userId: string; email: string; name: string; role: "owner" | "admin" | "member" }

/** Reads "Basic base64(user:password)". Null when the header is missing or not Basic. */
export function basicCredentials(header: string | undefined | null): { user: string; password: string } | null {
  const m = header?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!m || m[1].length > 1024) return null;
  let decoded: string;
  try { decoded = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))); } catch { return null; }
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i).trim(), password: decoded.slice(i + 1) };
}

export async function authenticate(deps: Deps, header: string | undefined | null): Promise<DavPrincipal | null> {
  const cred = basicCredentials(header);
  if (!cred || !cred.user || canonical(cred.password).length !== 20) return null;
  const hash = await hashAppPassword(cred.password);
  const row = await deps.db.select({ p: davAppPasswords, email: users.email, name: users.name, role: members.role, kind: members.kind }).from(davAppPasswords)
    .innerJoin(users, eq(users.id, davAppPasswords.userId))
    .innerJoin(members, and(eq(members.userId, davAppPasswords.userId), eq(members.organizationId, davAppPasswords.orgId)))
    .where(eq(davAppPasswords.tokenHash, hash)).get();
  if (!row || row.kind !== "human" || !safeEqual(row.p.tokenHash, hash)) return null;
  if (row.email.toLowerCase() !== cred.user.toLowerCase()) return null;
  const now = deps.now();
  if (!row.p.lastUsedAt || now.getTime() - row.p.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
    await deps.db.update(davAppPasswords).set({ lastUsedAt: now }).where(eq(davAppPasswords.id, row.p.id));
  }
  return { passwordId: row.p.id, orgId: row.p.orgId, userId: row.p.userId, email: row.email, name: row.name ?? row.email, role: row.role };
}

export const actorOfPrincipal = (p: DavPrincipal): SuiteActor => ({ orgId: p.orgId, userId: p.userId, email: p.email, name: p.name, role: p.role });

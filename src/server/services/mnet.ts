import { and, eq, gt, isNull, sql, getTableColumns, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../context";
import { mnetDevices, members, organizations, sessions, users } from "../db/schema";
import { randomToken, toB64 } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import { authHeaders } from "../lib/host-cookie";
import { authFor } from "../auth";
import { audit } from "./audit";
import { ssoBlocks } from "../auth/session";

const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((s) => {
  try { const b = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0)); return b.length === 32 && toB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === s; } catch { return false; }
});
export const mnetLaunch = z.object({
  redirectUri: z.string().max(120).refine((s) => {
    // Literal IPv4 loopback only. No arbitrary hosts, credentials, fragments,
    // alternate numeric forms, redirects or caller-chosen callback paths.
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/mnet\/callback$/.test(s)) return false;
    const u = new URL(s);
    return Number(u.port) >= 1024 && Number(u.port) <= 65535 && u.href === s;
  }),
  deviceKey: digest, challenge: digest, state: digest,
  platform: z.enum(["linux", "windows", "macos"]),
}).strict();
export const mnetRequest = mnetLaunch.extend({
  workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
}).strict();
export const mnetProof = z.object({ code: digest, verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), ...mnetRequest.shape }).strict();
export const mnetCheck = z.object({ workspaceId: mnetRequest.shape.workspaceId, capability: z.literal("list"), deviceKey: digest.optional() }).strict().refine((r) => r.deviceKey === undefined);
export const hash = async (s: string) => toB64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const denied = () => new HttpError(403, "mnet_denied", "Mnet access is unavailable.");
const now = (d: Deps) => d.now();

// Correlated check in the same statement as a grant transition or device read.
// A prior SELECT alone would leave a revocation race between checking and use.
export function liveEligibility(
  d: Deps,
  userId: string | SQLWrapper,
  workspaceId: string | SQLWrapper,
  sessionId: string | SQLWrapper,
  membershipId?: string | SQLWrapper | null,
) {
  const exactMembership = membershipId === undefined ? sql`` : sql`AND m.id = ${membershipId}`;
  return sql`EXISTS (SELECT 1 FROM users u
    JOIN members m ON m.user_id = u.id AND m.organization_id = ${workspaceId}
    JOIN organizations o ON o.id = m.organization_id
    JOIN sessions s ON s.user_id = u.id AND s.id = ${sessionId}
    WHERE u.id = ${userId} AND COALESCE(u.banned, 0) = 0 AND u.email_verified = 1
      AND COALESCE(o.is_demo, 0) = 0 AND o.suspended_at IS NULL
      AND m.kind = 'human' AND m.disabled_at IS NULL AND s.impersonated_by IS NULL
      AND s.expires_at > ${now(d).getTime()}
      ${exactMembership}
      AND (COALESCE(o.require_sso, 0) = 0 OR m.role = 'owner' OR s.login_method IN ('auth0', 'google')))`;
}

// No resolveAuth/requireAuth: those may bootstrap a workspace. Resolve only an
// existing person's session, then explicitly check the requested membership.
export async function mnetPerson(d: Deps, headers: Headers) {
  const s = await authFor(d).api.getSession({ headers: authHeaders(headers, d.config.mode === "production"), query: { disableCookieCache: true } });
  if (!s) throw new HttpError(401, "mnet_sign_in", "Sign in to Multies to continue.");
  const row = await d.db.select().from(sessions).where(and(eq(sessions.id, s.session.id), gt(sessions.expiresAt, now(d)))).get();
  if (!row || row.impersonatedBy) throw denied();
  return row;
}
export async function eligible(d: Deps, userId: string, workspaceId: string, sessionId: string, membershipId?: string | null) {
  if (membershipId === null) throw denied();
  const row = await d.db.select({ user: users, org: organizations, member: members, session: sessions }).from(users)
    .innerJoin(members, and(eq(members.userId, users.id), eq(members.organizationId, workspaceId)))
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .innerJoin(sessions, and(eq(sessions.userId, users.id), eq(sessions.id, sessionId)))
    .where(and(eq(users.id, userId), membershipId === undefined ? undefined : eq(members.id, membershipId))).get();
  if (!row || row.user.banned || !row.user.emailVerified || row.org.isDemo || row.org.suspendedAt || row.member.kind !== "human" || row.member.disabledAt || row.session.impersonatedBy || row.session.expiresAt <= now(d) || ssoBlocks(row.org.requireSso, row.member.role, row.session.loginMethod)) throw denied();
  return row;
}
export async function mnetLaunchInfo(d: Deps, headers: Headers, request: z.infer<typeof mnetLaunch>) {
  const s = await mnetPerson(d, headers);
  const rows = await d.db.select({ id: organizations.id, name: organizations.name }).from(organizations)
    .where(liveEligibility(d, s.userId, organizations.id, s.id)).limit(101);
  const user = await d.db.select({ email: users.email }).from(users).where(eq(users.id, s.userId)).get();
  return { request, email: user!.email, workspaces: rows.slice(0, 100), truncated: rows.length > 100, capabilities: ["list"], inputAuthorized: false };
}
export async function prepareMnet(d: Deps, headers: Headers, request: z.infer<typeof mnetRequest>) {
  const s = await mnetPerson(d, headers);
  const { member } = await eligible(d, s.userId, request.workspaceId, s.id);
  const id = randomToken();
  const at = now(d).getTime();
  // Prune this person's old handoffs only. Keep recent records for diagnostics;
  // immutable audit rows remain separate. Cap current handoffs atomically.
  await d.db.run(sql`DELETE FROM mnet_devices WHERE user_id = ${s.userId} AND COALESCE(credential_expires_at, expires_at) < ${at - 86_400_000}`);
  await d.db.run(sql`INSERT INTO mnet_devices
    (id, user_id, session_id, workspace_id, membership_id, device_key, challenge, state, platform, redirect_uri, status, expires_at)
    SELECT ${id}, ${s.userId}, ${s.id}, ${request.workspaceId}, ${member.id}, ${request.deviceKey}, ${request.challenge}, ${request.state}, ${request.platform}, ${request.redirectUri}, 'pending', ${at + 120_000}
    WHERE (SELECT COUNT(*) FROM mnet_devices WHERE user_id = ${s.userId}
      AND membership_id IS NOT NULL
      AND status IN ('pending', 'approved', 'active') AND COALESCE(credential_expires_at, expires_at) > ${at}) < 20
      AND ${liveEligibility(d, s.userId, request.workspaceId, s.id, member.id)}`);
  const inserted = await d.db.select({ id: mnetDevices.id }).from(mnetDevices).where(eq(mnetDevices.id, id)).get();
  if (!inserted) throw new HttpError(429, "mnet_capacity", "Too many current Mnet sign in requests. Wait for an existing request to expire or revoke a device approval.");
  return { id, audience: "mnet", request, capabilities: ["list"], inputAuthorized: false, expiresIn: 120 };
}
export async function decideMnet(d: Deps, headers: Headers, id: string, allow: boolean) {
  const s = await mnetPerson(d, headers);
  const row = await d.db.select().from(mnetDevices).where(and(eq(mnetDevices.id, id), eq(mnetDevices.userId, s.userId))).get();
  if (!row) throw denied();
  await eligible(d, s.userId, row.workspaceId, s.id);
  const code = randomToken();
  const changed = await d.db.update(mnetDevices).set({ status: allow ? "approved" : "declined", codeHash: allow ? await hash(code) : null }).where(and(
    eq(mnetDevices.id, id), eq(mnetDevices.userId, s.userId), eq(mnetDevices.sessionId, s.id),
    eq(mnetDevices.status, "pending"), gt(mnetDevices.expiresAt, now(d)),
    liveEligibility(d, s.userId, row.workspaceId, s.id, mnetDevices.membershipId),
  )).returning({ id: mnetDevices.id }).get();
  if (!changed) throw denied();
  await audit(d.db, { orgId: row.workspaceId, actorUserId: s.userId, action: allow ? "mnet.approved" : "mnet.declined", targetType: "mnet_device", targetId: row.id, at: now(d) });
  const redirect = new URL(row.redirectUri);
  redirect.searchParams.set("state", row.state);
  redirect.searchParams.set("workspaceId", row.workspaceId);
  if (allow) redirect.searchParams.set("code", code);
  else redirect.searchParams.set("error", "access_denied");
  return allow ? { code, redirectTo: redirect.href, expiresIn: Math.max(0, Math.floor((row.expiresAt.getTime() - now(d).getTime()) / 1000)), state: row.state, audience: "mnet" } : { declined: true, redirectTo: redirect.href };
}
export async function exchangeMnet(d: Deps, proof: z.infer<typeof mnetProof>) {
  const codeHash = await hash(proof.code);
  const row = await d.db.select().from(mnetDevices).where(eq(mnetDevices.codeHash, codeHash)).get();
  if (!row || row.status !== "approved" || row.workspaceId !== proof.workspaceId || row.deviceKey !== proof.deviceKey || row.platform !== proof.platform || row.redirectUri !== proof.redirectUri || row.state !== proof.state || row.challenge !== proof.challenge || row.challenge !== await hash(proof.verifier)) throw denied();
  await eligible(d, row.userId, row.workspaceId, row.sessionId);
  const credential = randomToken();
  const expires = new Date(now(d).getTime() + 600_000);
  const won = await d.db.update(mnetDevices).set({ status: "active", credentialHash: await hash(credential), credentialExpiresAt: expires, codeHash: null }).where(and(
    eq(mnetDevices.id, row.id), eq(mnetDevices.codeHash, codeHash), eq(mnetDevices.status, "approved"),
    isNull(mnetDevices.credentialHash), gt(mnetDevices.expiresAt, now(d)),
    liveEligibility(d, row.userId, row.workspaceId, row.sessionId, mnetDevices.membershipId),
  )).returning({ id: mnetDevices.id }).get();
  if (!won) throw denied();
  return { credential, tokenType: "Bearer", expiresIn: 600, audience: "mnet", deviceKey: row.deviceKey, workspaceId: row.workspaceId, capabilities: ["list"], inputAuthorized: false };
}
export async function mnetCredential(d: Deps, token: string) {
  if (!digest.safeParse(token).success) throw denied();
  const row = await d.db.select({ ...getTableColumns(mnetDevices), sessionExpiresAt: sessions.expiresAt }).from(mnetDevices)
    .innerJoin(sessions, eq(sessions.id, mnetDevices.sessionId)).where(and(
      eq(mnetDevices.credentialHash, await hash(token)), eq(mnetDevices.status, "active"), gt(mnetDevices.credentialExpiresAt, now(d)),
      liveEligibility(d, mnetDevices.userId, mnetDevices.workspaceId, mnetDevices.sessionId, mnetDevices.membershipId),
    )).get();
  if (!row) throw denied();
  return row;
}
export async function checkMnet(d: Deps, token: string, request: z.infer<typeof mnetCheck>) {
  const checkedAt = now(d);
  const owner = await mnetCredential(d, token);
  if (owner.workspaceId !== request.workspaceId) throw denied();
  return { userId: owner.userId, workspaceId: owner.workspaceId, deviceKey: request.deviceKey ?? "", audience: "mnet", accountState: "active", workspaceState: "active", membershipState: "active", verifiedEmail: true, demo: false, guest: false, ssoBlocked: false, allowed: [request.capability], checkedAt, expiresAt: new Date(Math.min(checkedAt.getTime() + 30_000, owner.credentialExpiresAt!.getTime(), owner.sessionExpiresAt.getTime())) };
}
export async function listMnet(d: Deps, token: string) {
  const owner = await mnetCredential(d, token);
  const rows = await d.db.select({ id: mnetDevices.id, deviceKey: mnetDevices.deviceKey, platform: mnetDevices.platform }).from(mnetDevices).where(and(
    eq(mnetDevices.userId, owner.userId), eq(mnetDevices.workspaceId, owner.workspaceId),
    eq(mnetDevices.status, "active"), gt(mnetDevices.credentialExpiresAt, now(d)),
    liveEligibility(d, mnetDevices.userId, mnetDevices.workspaceId, mnetDevices.sessionId, mnetDevices.membershipId),
    sql`EXISTS (SELECT 1 FROM mnet_devices auth WHERE auth.id = ${owner.id}
      AND auth.status = 'active' AND auth.credential_hash = ${owner.credentialHash}
      AND auth.credential_expires_at > ${now(d).getTime()}
      AND ${liveEligibility(d, sql`auth.user_id`, sql`auth.workspace_id`, sql`auth.session_id`, sql`auth.membership_id`)})`,
  )).limit(101);
  // A current credential always includes its own approval in this query.
  if (!rows.length) throw denied();
  return { workspaceId: owner.workspaceId, devices: rows.slice(0, 100), truncated: rows.length > 100, ownDevicesOnly: true, inputAuthorized: false };
}
export async function ownMnetDevices(d: Deps, headers: Headers) {
  const s = await mnetPerson(d, headers);
  const rows = await d.db.select({ id: mnetDevices.id, deviceKey: mnetDevices.deviceKey, platform: mnetDevices.platform, expiresAt: mnetDevices.credentialExpiresAt, workspace: organizations.name }).from(mnetDevices)
    .innerJoin(organizations, eq(organizations.id, mnetDevices.workspaceId))
    .where(and(
      eq(mnetDevices.userId, s.userId), eq(mnetDevices.status, "active"), gt(mnetDevices.credentialExpiresAt, now(d)),
      liveEligibility(d, mnetDevices.userId, mnetDevices.workspaceId, mnetDevices.sessionId, mnetDevices.membershipId),
      liveEligibility(d, s.userId, mnetDevices.workspaceId, s.id),
    )).limit(101);
  return { devices: rows.slice(0, 100), truncated: rows.length > 100 };
}
export async function revokeMnet(d: Deps, headers: Headers, id: string) {
  const s = await mnetPerson(d, headers);
  const row = await d.db.select().from(mnetDevices).where(and(eq(mnetDevices.id, id), eq(mnetDevices.userId, s.userId))).get();
  if (!row) throw denied();
  // The owner can revoke an old grant even after losing workspace access.
  await d.db.update(mnetDevices).set({ status: "revoked", credentialHash: null, codeHash: null }).where(and(eq(mnetDevices.id, id), eq(mnetDevices.userId, s.userId)));
  await audit(d.db, { orgId: row.workspaceId, actorUserId: s.userId, action: "mnet.revoked", targetType: "mnet_device", targetId: row.id, at: now(d) });
  return { revoked: true };
}

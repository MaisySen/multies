import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../context";
import { mnetEnrollmentDecisions, organizations, users } from "../db/schema";
import { randomToken } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import { audit } from "./audit";
import { mnetPerson, eligible, liveEligibility } from "./mnet";
import { enrollmentOperatorSchema } from "./mnet-enrollment-config";

const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((s) => {
 try { const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "="); return raw.length === 32 && btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === s && [...raw].some((c) => c.charCodeAt(0) !== 0); } catch { return false; }
});
// Full public key, not a claimed thumbprint. Possession is NOT established here.
export const enrollmentLaunch = z.object({ attemptId: digest, devicePublicKey: digest, platform: z.enum(["linux", "windows", "macos"]) }).strict();
export const enrollmentRequest = enrollmentLaunch.extend({
 workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
 // Comparison guard for exactly what the browser displayed, never trusted config.
 displayed: z.object({ issuer: z.string().max(2048), registrarOrigin: z.string().max(2048), audience: z.string().max(256), mappingRevision: z.string().max(128), networkId: z.string().max(128) }).strict(),
}).strict();
const refused = () => new HttpError(403, "mnet_enrollment_denied", "Computer joining approval is unavailable.");
function operator(d: Deps) {
 const parsed = enrollmentOperatorSchema.safeParse(d.config.mnetEnrollmentOperator);
 if (d.config.mode !== "development" || !d.config.mnetEnrollmentConsent || !parsed.success) throw new HttpError(404, "not_found", "Not found.");
 return parsed.data;
}
function binding(d: Deps, workspaceId: string, userId: string) {
 const config = operator(d), b = config.bindings.find((b) => b.workspaceId === workspaceId && b.principals.includes(userId));
 if (!b) throw refused();
 return { config, b };
}
export async function enrollmentInfo(d: Deps, headers: Headers, request: z.infer<typeof enrollmentLaunch>) {
 const config = operator(d), person = await mnetPerson(d, headers);
 const workspaces: { id: string; name: string; networkId: string }[] = [];
 for (const b of config.bindings.filter((b) => b.principals.includes(person.userId))) {
  const row = await d.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(and(eq(organizations.id, b.workspaceId), liveEligibility(d, person.userId, b.workspaceId, person.id))).get();
  if (row) workspaces.push({ ...row, networkId: b.networkId });
 }
 const user = await d.db.select({ email: users.email }).from(users).where(eq(users.id, person.userId)).get();
 return { request, email: user?.email ?? "", workspaces, registrarOrigin: config.registrarOrigin, issuer: config.issuer, audience: config.audience, mappingRevision: config.revision, purpose: "mnet-enrollment", inputAuthorized: false, registrarConnected: false };
}
export async function prepareEnrollment(d: Deps, headers: Headers, request: z.infer<typeof enrollmentRequest>) {
 const person = await mnetPerson(d, headers), { config, b } = binding(d, request.workspaceId, person.userId);
 if (request.displayed.issuer !== config.issuer || request.displayed.registrarOrigin !== config.registrarOrigin || request.displayed.audience !== config.audience || request.displayed.mappingRevision !== config.revision || request.displayed.networkId !== b.networkId) throw refused();
 const { member } = await eligible(d, person.userId, b.workspaceId, person.id);
 const id = randomToken(), at = d.now().getTime();
 // Never prune/reuse attempt IDs here. A timeout cannot resurrect uncertain authority.
 await d.db.run(sql`INSERT INTO mnet_enrollment_decisions
 (id,user_id,session_id,workspace_id,membership_id,attempt_id,device_public_key,issuer,registrar_origin,audience,network_id,mapping_revision,status,expires_at)
 SELECT ${id},${person.userId},${person.id},${b.workspaceId},${member.id},${request.attemptId},${request.devicePublicKey},${config.issuer},${config.registrarOrigin},${config.audience},${b.networkId},${config.revision},'pending',${at + 120000}
 WHERE NOT EXISTS (SELECT 1 FROM mnet_enrollment_decisions WHERE attempt_id=${request.attemptId})
 AND (SELECT COUNT(*) FROM mnet_enrollment_decisions WHERE user_id=${person.userId} AND membership_id IS NOT NULL AND expires_at>${at})<20
 AND ${liveEligibility(d, person.userId, b.workspaceId, person.id, member.id)}
 ON CONFLICT(attempt_id) DO NOTHING`);
 const won = await d.db.select({ id: mnetEnrollmentDecisions.id }).from(mnetEnrollmentDecisions).where(eq(mnetEnrollmentDecisions.id, id)).get();
 if (!won) throw refused();
 return { id, purpose: "mnet-enrollment", expiresAt: new Date(at + 120000), inputAuthorized: false, registrarConnected: false };
}
export async function decideEnrollment(d: Deps, headers: Headers, id: string, allow: boolean) {
 const person = await mnetPerson(d, headers);
 const row = await d.db.select().from(mnetEnrollmentDecisions).where(and(eq(mnetEnrollmentDecisions.id, id), eq(mnetEnrollmentDecisions.userId, person.userId), eq(mnetEnrollmentDecisions.sessionId, person.id))).get();
 if (!row) throw refused();
 const { config, b } = binding(d, row.workspaceId, person.userId);
 if (row.issuer !== config.issuer || row.registrarOrigin !== config.registrarOrigin || row.audience !== config.audience || row.mappingRevision !== config.revision || row.networkId !== b.networkId) throw refused();
 const changed = await d.db.update(mnetEnrollmentDecisions).set({ status: allow ? "approved" : "declined" }).where(and(eq(mnetEnrollmentDecisions.id, id), eq(mnetEnrollmentDecisions.status, "pending"), eq(mnetEnrollmentDecisions.userId, person.userId), eq(mnetEnrollmentDecisions.sessionId, person.id), gt(mnetEnrollmentDecisions.expiresAt, d.now()), liveEligibility(d, person.userId, row.workspaceId, person.id, mnetEnrollmentDecisions.membershipId))).returning({ id: mnetEnrollmentDecisions.id }).get();
 if (!changed) throw refused();
 await audit(d.db, { orgId: row.workspaceId, actorUserId: person.userId, action: allow ? "mnet.enrollment_approved" : "mnet.enrollment_declined", targetType: "mnet_enrollment", targetId: id, at: d.now() });
 return { decision: allow ? "approved" : "declined", purpose: "mnet-enrollment", inputAuthorized: false, registrarConnected: false, enrolled: false };
}

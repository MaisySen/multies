import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../context";
import { mnetEnrollmentHandoffs as journal, organizations, users } from "../db/schema";
import { randomToken } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import { eligible, hash, liveEligibility, mnetPerson } from "./mnet";
import { enrollmentHandoffCore } from "./mnet-enrollment-handoff-shape";
import { enrollmentOperatorSchema } from "./mnet-enrollment-config";
import { enrollmentHandoffFixtureSchema } from "./mnet-enrollment-handoff-config";
import { enrollmentRequest } from "./mnet-enrollment";

// This is browser/native handoff only, not service authentication or key proof.
// There is intentionally no registrar consumer, reserve/status/ack or node API.
export const handoffLaunch = enrollmentHandoffCore.extend({ credentialDigest: enrollmentHandoffCore.shape.attemptId }).strict();
export const handoffRequest = handoffLaunch.extend({ workspaceId: enrollmentRequest.shape.workspaceId, displayed: enrollmentRequest.shape.displayed }).strict();
export const handoffExchange = handoffLaunch.extend({ code: enrollmentHandoffCore.shape.attemptId, verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) }).strict();
const denied = () => new HttpError(403, "mnet_enrollment_denied", "Computer joining handoff is unavailable. Start a new request in Mnet.");
export function handoffConfig(d: Deps) {
 const operator = enrollmentOperatorSchema.safeParse(d.config.mnetEnrollmentOperator), policy = enrollmentHandoffFixtureSchema.safeParse(d.config.mnetEnrollmentHandoffFixture);
 if (d.config.mode !== "development" || !d.config.mnetEnrollmentHandoff || !operator.success || !policy.success) throw new HttpError(404, "not_found", "Not found.");
 return { operator: operator.data, policy: policy.data };
}
function binding(d: Deps, workspaceId: string, userId: string) {
 const { operator, policy } = handoffConfig(d), b = operator.bindings.find((b) => b.workspaceId === workspaceId && b.principals.includes(userId));
 if (!b) throw denied();
 return { policy, displayed: { issuer: operator.issuer, registrarOrigin: operator.registrarOrigin, audience: operator.audience, mappingRevision: operator.revision, networkId: b.networkId } };
}
const tupleEqual = (a: z.infer<typeof enrollmentRequest>["displayed"], b: z.infer<typeof enrollmentRequest>["displayed"]) => a.issuer === b.issuer && a.registrarOrigin === b.registrarOrigin && a.audience === b.audience && a.mappingRevision === b.mappingRevision && a.networkId === b.networkId;
type Row = typeof journal.$inferSelect;
const rowTuple = (r: Row) => ({ issuer: r.issuer!, registrarOrigin: r.registrarOrigin!, audience: r.audience!, mappingRevision: r.mappingRevision!, networkId: r.networkId! });

// Request-driven fixture cleanup, not a production retention worker. No deleting
// attempt tombstones, no timeouts resetting authority, no session/user/org FK.
export async function sweepHandoffs(d: Deps) {
 const { policy } = handoffConfig(d), at = d.now();
 await d.db.update(journal).set({ status: "expired", terminalAt: at, codeHash: null, ticketHash: null }).where(sql`(${journal.status}='pending' AND ${journal.expiresAt}<=${at.getTime()}) OR (${journal.status}='approved' AND ${journal.codeExpiresAt}<=${at.getTime()}) OR (${journal.status}='issued' AND ${journal.ticketExpiresAt}<=${at.getTime()})`);
 await d.db.update(journal).set({ status: "withdrawn", terminalAt: at, codeHash: null, ticketHash: null }).where(and(sql`${journal.status} IN ('pending','approved','issued')`, sql`NOT ${liveEligibility(d, journal.userId, journal.workspaceId, journal.sessionId, journal.membershipId)}`));
 await d.db.update(journal).set({ principalAuthority:null,principalNamespace:null,sessionBinding:null, userId: null, sessionId: null, workspaceId: null, membershipId: null, attemptId: null, devicePublicKey: null, credentialDigest: null, issuer: null, registrarOrigin: null, audience: null, networkId: null, mappingRevision: null, challenge: null, state: null, platform: null, redirectUri: null, codeHash: null, ticketHash: null, scrubbedAt: at }).where(and(isNull(journal.scrubbedAt), sql`${journal.status} IN ('declined','expired','withdrawn')`, sql`${journal.terminalAt}<=${at.getTime() - policy.fullRowRetentionMs}`));
}
async function validateCurrentRow(d: Deps, r: Row) {
 try {
  const selected = binding(d, r.workspaceId!, r.userId!);
  if (!tupleEqual(rowTuple(r), selected.displayed)) throw denied();
  await eligible(d, r.userId!, r.workspaceId!, r.sessionId!, r.membershipId);
  return selected;
 } catch (error) {
  // Infrastructure failure is not evidence of revoked eligibility. Fail closed
  // for this request without destroying a still-valid owner's one-use code.
  if (!(error instanceof HttpError) || error.status !== 403) throw error;
  // Only called after original session or exact code+PKCE tuple is established.
  await d.db.update(journal).set({ status: "withdrawn", terminalAt: d.now(), codeHash: null, ticketHash: null }).where(and(eq(journal.id, r.id), sql`${journal.status} IN ('pending','approved','issued')`));
  throw error;
 }
}
export async function handoffInfo(d: Deps, headers: Headers, request: z.infer<typeof handoffLaunch>) {
 const { operator } = handoffConfig(d), person = await mnetPerson(d, headers);
 await sweepHandoffs(d);
 const workspaces: { id: string; name: string; networkId: string }[] = [];
 for (const b of operator.bindings.filter((b) => b.principals.includes(person.userId))) {
  const row = await d.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(and(eq(organizations.id, b.workspaceId), liveEligibility(d, person.userId, b.workspaceId, person.id))).get();
  if (row) workspaces.push({ ...row, networkId: b.networkId });
 }
 const user = await d.db.select({ email: users.email }).from(users).where(eq(users.id, person.userId)).get();
 return { request, email: user?.email ?? "", workspaces, registrarOrigin: operator.registrarOrigin, issuer: operator.issuer, audience: operator.audience, mappingRevision: operator.revision, purpose: "mnet-enrollment", registrarConnected: false, enrolled: false, inputAuthorized: false };
}
export async function prepareHandoff(d: Deps, headers: Headers, request: z.infer<typeof handoffRequest>) {
 const person = await mnetPerson(d, headers), selected = binding(d, request.workspaceId, person.userId);
 if (!tupleEqual(request.displayed, selected.displayed)) throw denied();
 const { member } = await eligible(d, person.userId, request.workspaceId, person.id);
 await sweepHandoffs(d);
 const id = randomToken(), attemptHash = await hash(request.attemptId), at = d.now().getTime();
 const provenanceConfig=handoffConfig(d).operator.provenance;
 const sessionBinding=provenanceConfig ? randomToken():null;
 // Compare current config again after async work. Config is server-owned input.
 if (!tupleEqual(selected.displayed, binding(d, request.workspaceId, person.userId).displayed)) throw denied();
 await d.db.run(sql`INSERT INTO mnet_enrollment_handoffs
 (id,attempt_hash,version,purpose,session_binding,principal_authority,principal_namespace,user_id,session_id,workspace_id,membership_id,attempt_id,device_public_key,credential_digest,issuer,registrar_origin,audience,network_id,mapping_revision,challenge,state,platform,redirect_uri,status,created_at,expires_at)
 SELECT ${id},${attemptHash},1,'mnet-enrollment',${sessionBinding},${provenanceConfig?.principalAuthority??null},${provenanceConfig?.principalNamespace??null},${person.userId},${person.id},${request.workspaceId},${member.id},${request.attemptId},${request.devicePublicKey},${request.credentialDigest},${selected.displayed.issuer},${selected.displayed.registrarOrigin},${selected.displayed.audience},${selected.displayed.networkId},${selected.displayed.mappingRevision},${request.challenge},${request.state},${request.platform},${request.redirectUri},'pending',${at},${at + selected.policy.consentMs}
 WHERE (SELECT COUNT(*) FROM mnet_enrollment_handoffs WHERE user_id=${person.userId} AND status IN ('pending','approved','issued'))<${selected.policy.capacity}
 AND (SELECT COUNT(*) FROM mnet_enrollment_handoffs)<${selected.policy.maxRows}
 AND ${liveEligibility(d, person.userId, request.workspaceId, person.id, member.id)}
 ON CONFLICT(attempt_hash) DO NOTHING`);
 if (!await d.db.select({ id: journal.id }).from(journal).where(eq(journal.id, id)).get()) throw denied();
 return { id, purpose: "mnet-enrollment", expiresAt: new Date(at + selected.policy.consentMs), registrarConnected: false, enrolled: false, inputAuthorized: false };
}
export async function decideHandoff(d: Deps, headers: Headers, id: string, allow: boolean) {
 handoffConfig(d); const person = await mnetPerson(d, headers); await sweepHandoffs(d);
 const r = await d.db.select().from(journal).where(and(eq(journal.id, id), eq(journal.userId, person.userId), eq(journal.sessionId, person.id), eq(journal.status, "pending"))).get();
 if (!r) throw denied();
 const selected = await validateCurrentRow(d, r), code = allow ? randomToken() : null, codeHash = code ? await hash(code) : null, at = d.now();
 if (!tupleEqual(rowTuple(r), binding(d, r.workspaceId!, r.userId!).displayed)) throw denied();
 const expires = new Date(Math.min(r.expiresAt.getTime(), at.getTime() + selected.policy.codeMs));
 const won = await d.db.update(journal).set({ status: allow ? "approved" : "declined", codeHash, codeExpiresAt: allow ? expires : null, terminalAt: allow ? null : at }).where(and(eq(journal.id, id), eq(journal.status, "pending"), gt(journal.expiresAt, at), liveEligibility(d, r.userId!, r.workspaceId!, r.sessionId!, journal.membershipId))).returning({ id: journal.id }).get();
 if (!won) throw denied();
 const redirect = new URL(r.redirectUri!); redirect.searchParams.set("state", r.state!); redirect.searchParams.set("attemptId", r.attemptId!);
 if (code) redirect.searchParams.set("code", code); else redirect.searchParams.set("error", "access_denied");
 return { redirectTo: redirect.href, purpose: "mnet-enrollment", registrarConnected: false, enrolled: false, inputAuthorized: false };
}
export async function exchangeHandoff(d: Deps, proof: z.infer<typeof handoffExchange>,responseVersion?:2) {
 handoffConfig(d); await sweepHandoffs(d);
 const codeHash = await hash(proof.code), r = await d.db.select().from(journal).where(and(eq(journal.codeHash, codeHash), eq(journal.status, "approved"))).get();
 // No wrong tuple/verifier may consume another native intent's valid code.
 if (!r || r.version !== proof.version || r.purpose !== proof.purpose || r.attemptId !== proof.attemptId || r.devicePublicKey !== proof.devicePublicKey || r.credentialDigest !== proof.credentialDigest || r.challenge !== proof.challenge || r.state !== proof.state || r.platform !== proof.platform || r.redirectUri !== proof.redirectUri || r.challenge !== await hash(proof.verifier)) throw denied();
 const provenance=responseVersion===2?handoffProvenance(d,r):undefined;
 const selected = await validateCurrentRow(d, r), ticket = randomToken(), ticketHash = await hash(ticket), at = d.now();
 if (!tupleEqual(rowTuple(r), binding(d, r.workspaceId!, r.userId!).displayed)) throw denied();
 if(responseVersion===2)handoffProvenance(d,r);
 const expires = new Date(at.getTime() + selected.policy.ticketMs);
 const won = await d.db.update(journal).set({ status: "issued", codeHash: null, ticketHash, ticketExpiresAt: expires }).where(and(eq(journal.id, r.id), eq(journal.status, "approved"), eq(journal.codeHash, codeHash), isNull(journal.ticketHash), gt(journal.expiresAt, at), gt(journal.codeExpiresAt, at), liveEligibility(d, r.userId!, r.workspaceId!, r.sessionId!, journal.membershipId))).returning({ id: journal.id }).get();
 if (!won) throw denied();
 if(responseVersion===2)handoffProvenance(d,r);
 return { ...(provenance?{responseVersion:2,provenance,launch:proofLaunch(proof)}:{}),ticket, id: r.id, expiresAt: expires, binding: { workspaceId: r.workspaceId!, ...rowTuple(r) }, purpose: "mnet-enrollment", registrarConnected: false, enrolled: false, inputAuthorized: false };
}

// Source identity is explicitly local to configured Multies authority, never an
// external OIDC subject. No raw session ID/token leaves this source boundary.
export function handoffProvenance(d:Deps,r:Row){
 const config=handoffConfig(d).operator.provenance;
 if(!config||r.principalAuthority!==config.principalAuthority||r.principalNamespace!==config.principalNamespace||!r.userId||!r.sessionId||!r.sessionBinding||!handoffLaunch.shape.attemptId.safeParse(r.sessionBinding).success)throw denied();
 return {principalAuthority:config.principalAuthority,principalNamespace:config.principalNamespace,principalId:r.userId,sessionBinding:r.sessionBinding};
}
function proofLaunch(proof:z.infer<typeof handoffExchange>){
 const {code:_code,verifier:_verifier,...launch}=proof;return launch;
}

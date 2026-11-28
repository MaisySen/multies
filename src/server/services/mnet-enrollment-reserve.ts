import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../context";
import { mnetEnrollmentHandoffs as journal } from "../db/schema";
import { randomToken, safeEqual } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import { hash, liveEligibility } from "./mnet";
import { handoffConfig, handoffLaunch, handoffProvenance } from "./mnet-enrollment-handoff";
import { enrollmentRequest } from "./mnet-enrollment";
import { serviceFixtureSchema } from "./mnet-enrollment-service-config";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const reserveRequest = z.object({ ticket: handoffLaunch.shape.attemptId, handoffId: handoffLaunch.shape.attemptId, reserveId: handoffLaunch.shape.attemptId, launch: handoffLaunch, binding: enrollmentRequest.shape.displayed.extend({workspaceId:id}).strict() }).strict();
const denied=()=>new HttpError(403,"mnet_service_denied","Enrollment service request refused.");
export function enrollmentServiceConfig(d:Deps){
 handoffConfig(d);const p=serviceFixtureSchema.safeParse(d.config.mnetEnrollmentServiceFixture);
 if(!d.config.mnetEnrollmentService||!p.success)throw new HttpError(404,"not_found","Not found.");
 return p.data;
}
export async function authenticateEnrollmentService(d:Deps,headers:Headers){
 const config=enrollmentServiceConfig(d);
 // Fetch Headers joins duplicate Authorization fields with a comma. The exact
 // grammar rejects that representation, multiple schemes, whitespace and aliases.
 const match=/^Bearer ([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.([A-Za-z0-9_-]{43})$/.exec(headers.get("authorization")??"");
 if(headers.has("cookie")||headers.has("origin")||!match)throw denied();
 if(!handoffLaunch.shape.attemptId.safeParse(match[2]).success)throw denied();
 const actual=await hash(match[2]);const key=config.keys.find(k=>k.keyId===match[1]);
 if(!key||!key.active||!safeEqual(actual,key.digest))throw denied();
 return {...key,config};
}
export type Service=Awaited<ReturnType<typeof authenticateEnrollmentService>>;
function currentBinding(d:Deps,r:typeof journal.$inferSelect,service:Service){
 const {operator}=handoffConfig(d),b=operator.bindings.find(b=>b.workspaceId===r.workspaceId&&b.principals.includes(r.userId!));
 // No pre-reservation withdrawal helper: reserved history is never destroyed.
 if(!b||operator.issuer!==r.issuer||operator.registrarOrigin!==r.registrarOrigin||operator.audience!==r.audience||operator.revision!==r.mappingRevision||b.networkId!==r.networkId||service.issuer!==r.issuer||service.registrarOrigin!==r.registrarOrigin||service.audience!==r.audience)throw denied();
 const active=enrollmentServiceConfig(d).keys.find(k=>k.keyId===service.keyId);
 if(!active?.active||active.digest!==service.digest||active.serviceId!==service.serviceId||active.issuer!==service.issuer||active.registrarOrigin!==service.registrarOrigin||active.audience!==service.audience)throw denied();
}
// Encoding v1: fixed ordered JSON array of strings/numeric literal. No object
// order, Unicode normalization or raw request serialization participates.
export function reserveDescriptorBytes(p:z.infer<typeof reserveRequest>,serviceId:string){return new TextEncoder().encode(JSON.stringify(["mnet-reserve-descriptor-v1",serviceId,p.handoffId,p.reserveId,p.launch.version,p.launch.purpose,p.launch.attemptId,p.launch.devicePublicKey,p.launch.credentialDigest,p.launch.challenge,p.launch.state,p.launch.redirectUri,p.launch.platform,p.binding.workspaceId,p.binding.issuer,p.binding.registrarOrigin,p.binding.audience,p.binding.mappingRevision,p.binding.networkId]));}
export async function reserveDescriptor(p:z.infer<typeof reserveRequest>,serviceId:string){return hash(new TextDecoder().decode(reserveDescriptorBytes(p,serviceId)));}
export async function reserveEnrollment(d:Deps,service:Service,p:z.infer<typeof reserveRequest>){
 const ticketHash=await hash(p.ticket),r=await d.db.select().from(journal).where(and(eq(journal.id,p.handoffId),eq(journal.ticketHash,ticketHash))).get();
 if(!r||r.attemptId!==p.launch.attemptId||r.devicePublicKey!==p.launch.devicePublicKey||r.credentialDigest!==p.launch.credentialDigest||r.challenge!==p.launch.challenge||r.state!==p.launch.state||r.redirectUri!==p.launch.redirectUri||r.platform!==p.launch.platform||r.workspaceId!==p.binding.workspaceId||r.issuer!==p.binding.issuer||r.registrarOrigin!==p.binding.registrarOrigin||r.audience!==p.binding.audience||r.mappingRevision!==p.binding.mappingRevision||r.networkId!==p.binding.networkId)throw denied();
 currentBinding(d,r,service);
 const descriptorDigest=await reserveDescriptor(p,service.serviceId),at=d.now().getTime();
 if(r.status==="reserved"){
  // Receipt/status is not implemented. Exact live reserve retry returns its
  // original metadata only before deadline and while new authority is valid.
  if(r.serviceId!==service.serviceId||r.reserveId!==p.reserveId||r.descriptorDigest!==descriptorDigest||!r.reserveDeadline||r.reserveDeadline.getTime()<=at)throw denied();
  const live=await d.db.select({id:journal.id}).from(journal).where(and(eq(journal.id,r.id),eq(journal.status,"reserved"),liveEligibility(d,r.userId!,r.workspaceId!,r.sessionId!,journal.membershipId))).get();
  if(!live)throw denied();currentBinding(d,r,service);
  return {handoffId:r.id,reserveId:r.reserveId,descriptorDigest:r.descriptorDigest,deadline:r.reserveDeadline,status:"reserved",enrolled:false};
 }
 if(r.status!=="issued")throw denied();
 const deadline=new Date(at+service.config.reserveMs),eventId=randomToken();
 const event=JSON.stringify({version:1,seq:1,id:eventId,kind:"reserve",serviceId:service.serviceId,handoffId:r.id,reserveId:p.reserveId,descriptorDigest,mappingRevision:r.mappingRevision,at});
 currentBinding(d,r,service);
 const won=await d.db.update(journal).set({status:"reserved",serviceId:service.serviceId,reserveId:p.reserveId,descriptorDigest,reserveDeadline:deadline,eventSeq:1,descriptorEncodingVersion:1,events:sql`json_insert(${journal.events},'$[#]',json(${event}))`}).where(and(eq(journal.id,r.id),eq(journal.status,"issued"),eq(journal.ticketHash,ticketHash),gt(journal.ticketExpiresAt,new Date(at)),sql`NOT EXISTS (SELECT 1 FROM mnet_enrollment_handoffs other WHERE other.reserve_id=${p.reserveId})`,sql`json_array_length(${journal.events})=0`,sql`json_array_length(${journal.events})<${service.config.eventCapacity}`,liveEligibility(d,r.userId!,r.workspaceId!,r.sessionId!,journal.membershipId))).returning({id:journal.id}).get();
 if(!won){
  // A concurrent identical request can lose its UPDATE but observe the one
  // immutable winner. Conflicting IDs/digests never get a fresh reservation.
  const winner=await d.db.select().from(journal).where(eq(journal.id,r.id)).get();
  if(!winner||winner.status!=="reserved"||winner.reserveId!==p.reserveId||winner.serviceId!==service.serviceId||winner.descriptorDigest!==descriptorDigest||!winner.reserveDeadline||winner.reserveDeadline.getTime()<=d.now().getTime())throw denied();
  currentBinding(d,winner,service);
  const live=await d.db.select({id:journal.id}).from(journal).where(and(eq(journal.id,r.id),liveEligibility(d,r.userId!,r.workspaceId!,r.sessionId!,journal.membershipId))).get();if(!live)throw denied();
  return {handoffId:r.id,reserveId:winner.reserveId,descriptorDigest:winner.descriptorDigest,deadline:winner.reserveDeadline,status:"reserved",enrolled:false};
 }
 return {handoffId:r.id,reserveId:p.reserveId,descriptorDigest,deadline,status:"reserved",enrolled:false};
}

// Authenticated SAME live reserve, never historical status. No new reserve,
// deadline extension, access grant or proof permit is created by this response.
export async function reserveEnrollmentEvidence(d:Deps,service:Service,p:z.infer<typeof reserveRequest>){
 // Refuse old/provenance-disabled rows BEFORE changing reservation state.
 const ticketHash=await hash(p.ticket);
 const original=await d.db.select().from(journal).where(and(eq(journal.id,p.handoffId),eq(journal.ticketHash,ticketHash))).get();
 if(!original)throw denied();handoffProvenance(d,original);
 const reserved=await reserveEnrollment(d,service,p);
 const at=d.now();
 const row=await d.db.select().from(journal).where(and(eq(journal.id,p.handoffId),eq(journal.status,"reserved"),eq(journal.userId,original.userId!),eq(journal.sessionId,original.sessionId!),eq(journal.sessionBinding,original.sessionBinding!),eq(journal.principalAuthority,original.principalAuthority!),eq(journal.principalNamespace,original.principalNamespace!),eq(journal.serviceId,service.serviceId),eq(journal.reserveId,p.reserveId),eq(journal.descriptorDigest,reserved.descriptorDigest),gt(journal.reserveDeadline,at),liveEligibility(d,original.userId!,original.workspaceId!,original.sessionId!,journal.membershipId))).get();
 if(!row)throw denied();currentBinding(d,row,service);
 const provenance=handoffProvenance(d,row);
 if(!row.reserveDeadline||row.reserveDeadline.getTime()<=d.now().getTime())throw denied();
 return {...reserved,responseVersion:2,provenance,launch:p.launch,binding:p.binding,serviceId:service.serviceId,checkedAt:at,descriptorEncodingVersion:1,authorityGranted:false};
}

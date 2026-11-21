import {and,eq,sql} from "drizzle-orm";
import {z} from "zod";
import type {Deps} from "../context";
import {mnetEnrollmentHandoffs as journal} from "../db/schema";
import {randomToken} from "../lib/crypto";
import {HttpError} from "../lib/errors";
import {handoffLaunch} from "./mnet-enrollment-handoff";
import {enrollmentServiceConfig,type Service} from "./mnet-enrollment-reserve";
const digest=handoffLaunch.shape.attemptId;
export const serviceRecordRequest=z.object({handoffId:digest,attemptId:digest,reserveId:digest,descriptorDigest:digest}).strict();
export const serviceAckRequest=serviceRecordRequest.extend({receiptId:digest,receiptDigest:digest}).strict();
type Proof=z.infer<typeof serviceRecordRequest>;
type Row=typeof journal.$inferSelect;
const denied=()=>new HttpError(403,"mnet_service_denied","Enrollment service request refused.");
function activePinned(d:Deps,s:Service,r:Row){
 const k=enrollmentServiceConfig(d).keys.find(k=>k.keyId===s.keyId);
 if(!k?.active||k.digest!==s.digest||k.serviceId!==s.serviceId||k.serviceId!==r.serviceId||k.issuer!==r.issuer||k.registrarOrigin!==r.registrarOrigin||k.audience!==r.audience)throw denied();
 // No live person/member check: recording pinned historical evidence does not
 // grant present network access or prove current eligibility. No node API here.
}
async function readPinned(d:Deps,s:Service,p:Proof){
 const r=await d.db.select().from(journal).where(eq(journal.id,p.handoffId)).get();
 if(!r||!['reserved','uncertain','consumed'].includes(r.status)||r.attemptId!==p.attemptId||r.reserveId!==p.reserveId||r.descriptorDigest!==p.descriptorDigest||!r.reserveDeadline||r.descriptorEncodingVersion!==1)throw denied();
 activePinned(d,s,r);return r;
}
function validSequence(r:Row){
 const expected=r.status==='reserved'?1:r.status==='uncertain'?2:r.eventSeq;
 if(r.eventSeq!==expected||r.eventSeq<1||r.eventSeq>3)throw denied();
 let events: {seq:number;kind:string}[];try{events=JSON.parse(r.events);}catch{throw denied();}
 if(!Array.isArray(events)||events.length!==r.eventSeq||events.some((e,i)=>e.seq!==i+1)||events[0]?.kind!=='reserve'||(r.eventSeq===3&&events[1]?.kind!=='uncertain')||(r.status==='uncertain'&&events[1]?.kind!=='uncertain')||(r.status==='consumed'&&events.at(-1)?.kind!=='commit-ack'))throw denied();
}
function result(r:Row){return {handoffId:r.id,reserveId:r.reserveId,descriptorDigest:r.descriptorDigest,deadline:r.reserveDeadline,status:r.status,receipt:r.status==='consumed'?{id:r.receiptId,digest:r.receiptDigest}:null,enrolled:false,authorityGranted:false};}
async function markUncertain(d:Deps,s:Service,p:Proof,r:Row){
 validSequence(r);
 if(r.status!=='reserved'||r.reserveDeadline!.getTime()>d.now().getTime())return r;
 activePinned(d,s,r);
 const at=d.now().getTime(),event=JSON.stringify({version:1,seq:2,id:randomToken(),kind:'uncertain',serviceId:r.serviceId,handoffId:r.id,reserveId:r.reserveId,descriptorDigest:r.descriptorDigest,at});
 await d.db.update(journal).set({status:'uncertain',eventSeq:2,events:sql`json_insert(${journal.events},'$[#]',json(${event}))`}).where(and(eq(journal.id,r.id),eq(journal.status,'reserved'),eq(journal.eventSeq,1),eq(journal.reserveId,p.reserveId),eq(journal.descriptorDigest,p.descriptorDigest),sql`${journal.reserveDeadline}<=${at}`,sql`json_array_length(${journal.events})=1`)).returning({id:journal.id}).get();
 const current=await readPinned(d,s,p);validSequence(current);return current;
}
export async function statusEnrollment(d:Deps,s:Service,p:Proof){
 const r=await markUncertain(d,s,p,await readPinned(d,s,p));activePinned(d,s,r);validSequence(r);return result(r);
}
export async function acknowledgeEnrollment(d:Deps,s:Service,p:z.infer<typeof serviceAckRequest>){
 let r=await markUncertain(d,s,p,await readPinned(d,s,p));validSequence(r);
 if(r.status==='consumed'){
  if(r.receiptId!==p.receiptId||r.receiptDigest!==p.receiptDigest)throw denied();
  activePinned(d,s,r);return result(r);
 }
 if(r.status!=='reserved'&&r.status!=='uncertain')throw denied();
 activePinned(d,s,r);
 const seq=r.eventSeq+1,at=d.now().getTime(),event=JSON.stringify({version:1,seq,id:randomToken(),kind:'commit-ack',serviceId:r.serviceId,handoffId:r.id,reserveId:r.reserveId,descriptorDigest:r.descriptorDigest,receiptId:p.receiptId,receiptDigest:p.receiptDigest,at});
 // Reserve admitted all three lifecycle slots. Reconciliation uses physical8
 // storage bound and seq<=3, never mutable new-admission eventCapacity.
 const won=await d.db.update(journal).set({status:'consumed',receiptId:p.receiptId,receiptDigest:p.receiptDigest,eventSeq:seq,events:sql`json_insert(${journal.events},'$[#]',json(${event}))`}).where(and(eq(journal.id,r.id),eq(journal.status,r.status),eq(journal.eventSeq,r.eventSeq),eq(journal.reserveId,p.reserveId),eq(journal.descriptorDigest,p.descriptorDigest),sql`json_array_length(${journal.events})=${r.eventSeq}`,sql`${journal.eventSeq}<3`,r.status==='reserved'?sql`${journal.reserveDeadline}>${at}`:sql`1=1`)).returning({id:journal.id}).get();
 if(!won){
  r=await readPinned(d,s,p);
  if(r.status!=='consumed'||r.receiptId!==p.receiptId||r.receiptDigest!==p.receiptDigest)throw denied();
 }else r=await readPinned(d,s,p);
 activePinned(d,s,r);validSequence(r);return result(r);
}

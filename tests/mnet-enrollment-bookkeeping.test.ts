import {eq,sql} from "drizzle-orm";
import {hash} from "@/server/services/mnet";
import {sweepHandoffs} from "@/server/services/mnet-enrollment-handoff";
import {loadConfig} from "@/server/config";
import {it,expect} from "vitest";
import {randomToken} from "@/server/lib/crypto";
import {users,members,sessions,organizations,mnetEnrollmentHandoffs as journal} from "@/server/db/schema";
import {setupBookkeeping} from "./mnet-enrollment-bookkeeping-fixture";
const path="/api/mnet-enrollment-service-v1";
async function setup(){const e=await setupBookkeeping();e.deps.config.mnetEnrollmentServiceFixture!.eventCapacity=8;const r=await e.send();expect(r.status).toBe(200);const reserved=await r.json();const proof={handoffId:e.request.handoffId,attemptId:e.request.launch.attemptId,reserveId:reserved.reserveId,descriptorDigest:reserved.descriptorDigest};const call=(endpoint:string,body:unknown=proof,headers:Record<string,string>={})=>e.app.request(path+endpoint,{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:e.authorization,...headers},body:JSON.stringify(body)});return {...e,reserved,proof,call};}
it("records deadline uncertainty once then late exact receipt as history without renewed authority",async()=>{
 const e=await setup();e.deps.now=()=>new Date(e.reserved.deadline);
 const status=await e.call("/status");expect(status.status).toBe(200);expect(await status.json()).toMatchObject({status:"uncertain",enrolled:false});
 const receipt={...e.proof,receiptId:randomToken(),receiptDigest:randomToken()};const ack=await e.call("/ack",receipt);expect(ack.status).toBe(200);const result=await ack.json();expect(result).toMatchObject({status:"consumed",enrolled:false});
 expect(await(await e.call("/ack",receipt)).json()).toEqual(result);
 const row=await e.db.select().from(journal).get();expect(row!.status).toBe("consumed");expect(JSON.parse(row!.events).map((v:{seq:number})=>v.seq)).toEqual([1,2,3]);
});
it("records an on-time acknowledgement directly, idempotently, refusing changed receipts",async()=>{
 const e=await setup(),receipt={...e.proof,receiptId:randomToken(),receiptDigest:randomToken()};
 expect((await e.call("/ack",receipt)).status).toBe(200);const row=await e.db.select().from(journal).get();expect(row!.status).toBe("consumed");expect(JSON.parse(row!.events).map((v:{kind:string})=>v.kind)).toEqual(["reserve","commit-ack"]);
 for(const p of [{...receipt,receiptId:randomToken()},{...receipt,receiptDigest:randomToken()},{...receipt,descriptorDigest:randomToken()},{...receipt,reserveId:randomToken()}])expect((await e.call("/ack",p)).status).toBe(403);
 expect((await e.call("/status")).status).toBe(200);expect(await e.db.select().from(journal).get()).toEqual(row);
});
it("concurrent deadline status and same/different receipt acknowledgements append one sequence only",async()=>{
 const e=await setup();e.deps.now=()=>new Date(e.reserved.deadline);const a={...e.proof,receiptId:randomToken(),receiptDigest:randomToken()},b={...a,receiptId:randomToken()};
 const results=await Promise.all([e.call("/status"),e.call("/ack",a),e.call("/ack",b),e.call("/ack",a),e.call("/status")]);
 expect(results.every(r=>[200,403].includes(r.status))).toBe(true);expect(results.some(r=>r.status===200)).toBe(true);
 const row=await e.db.select().from(journal).get();expect(row!.status).toBe("consumed");expect([a.receiptId,b.receiptId]).toContain(row!.receiptId);expect(JSON.parse(row!.events).map((v:{seq:number})=>v.seq)).toEqual([1,2,3]);
 const winner=row!.receiptId===a.receiptId?a:b;expect((await e.call("/ack",winner)).status).toBe(200);expect(await e.db.select().from(journal).get()).toEqual(row);
});
it.each(["membership","session","user","workspace","mapping"])("records only historical evidence after %s loss, without current user authority",async(mode)=>{
 const e=await setup();
 if(mode==="membership")await e.db.update(members).set({disabledAt:new Date()}).where(eq(members.userId,e.user.id));
 if(mode==="session")await e.db.delete(sessions).where(eq(sessions.userId,e.user.id));
 if(mode==="user")await e.db.delete(users).where(eq(users.id,e.user.id));
 if(mode==="workspace")await e.db.delete(organizations).where(eq(organizations.id,e.request.binding.workspaceId));
 if(mode==="mapping")e.deps.config.mnetEnrollmentOperator!.revision="changed-mapping";
 expect((await e.send()).status).toBe(403);e.deps.now=()=>new Date(e.reserved.deadline);
 const r=await e.call("/ack",{...e.proof,receiptId:randomToken(),receiptDigest:randomToken()});expect(r.status).toBe(200);expect(await r.json()).toMatchObject({status:"consumed",authorityGranted:false,enrolled:false});
 const row=await e.db.select().from(journal).get();await sweepHandoffs({...e.deps,now:()=>new Date(Date.now()+864000000)});expect(await e.db.select().from(journal).get()).toEqual(row);
});
it("requires active same pinned service scope, not a revoked key or a new identity",async()=>{
 const e=await setup(),receipt={...e.proof,receiptId:randomToken(),receiptDigest:randomToken()},old=e.deps.config.mnetEnrollmentServiceFixture!.keys[0],next=randomToken();old.active=false;
 const row=await e.db.select().from(journal).get();expect((await e.call("/ack",receipt)).status).toBe(403);expect(await e.db.select().from(journal).get()).toEqual(row);
 e.deps.config.mnetEnrollmentServiceFixture!.keys.push({...old,active:true,keyId:"rotation",digest:await hash(next)});const headers={authorization:`Bearer rotation.${next}`};
 expect((await e.call("/status",e.proof,headers)).status).toBe(200);e.deps.config.mnetEnrollmentServiceFixture!.keys[1].serviceId="different-service";expect((await e.call("/ack",receipt,headers)).status).toBe(403);
 e.deps.config.mnetEnrollmentServiceFixture!.keys[1].serviceId=old.serviceId;e.deps.config.mnetEnrollmentServiceFixture!.keys[1].audience="wrong-audience";expect((await e.call("/ack",receipt,headers)).status).toBe(403);
 e.deps.config.mnetEnrollmentServiceFixture!.keys[1].audience=old.audience;expect((await e.call("/ack",receipt,headers)).status).toBe(200);
});
it.each(["uncertainty","ack"])("state and event remain atomic on %s append failure",async(mode)=>{
 const e=await setup(),receipt={...e.proof,receiptId:randomToken(),receiptDigest:randomToken()};e.deps.now=()=>new Date(e.reserved.deadline);
 if(mode==="ack")expect((await e.call("/status")).status).toBe(200);
 const before=await e.db.select().from(journal).get();await e.db.run(sql`CREATE TRIGGER fixture_bookkeeping_abort BEFORE UPDATE OF events ON mnet_enrollment_handoffs BEGIN SELECT RAISE(ABORT,'fixture event failure'); END`);
 expect((await e.call(mode==="ack"?"/ack":"/status",mode==="ack"?receipt:e.proof)).status).toBe(500);expect(await e.db.select().from(journal).get()).toEqual(before);
 await e.db.run(sql`DROP TRIGGER fixture_bookkeeping_abort`);expect((await e.call("/ack",receipt)).status).toBe(200);expect((await e.db.select().from(journal).get())!.status).toBe("consumed");
});
it("rejects insufficient admission config and ignores reduced valid admission capacity for historical evidence",async()=>{
 const e=await setup();expect(()=>loadConfig({APP_SECRET:"t".repeat(40),MNET_ENROLLMENT_SERVICE:"on",MNET_ENROLLMENT_SERVICE_FIXTURE:JSON.stringify({...e.deps.config.mnetEnrollmentServiceFixture,eventCapacity:2})})).toThrow();
 e.deps.config.mnetEnrollmentServiceFixture!.eventCapacity=3;e.deps.now=()=>new Date(e.reserved.deadline);expect((await e.call("/ack",{...e.proof,receiptId:randomToken(),receiptDigest:randomToken()})).status).toBe(200);expect((await e.db.select().from(journal).get())!.eventSeq).toBe(3);
});
it("enforces authenticated operation budgets across key rotation without spending history",async()=>{
 const e=await setup();e.deps.config.mnetEnrollmentServiceFixture!.serviceBudgets.status=1;
 expect((await e.call("/status")).status).toBe(200);const before=await e.db.select().from(journal).get();expect((await e.call("/status")).status).toBe(429);expect(await e.db.select().from(journal).get()).toEqual(before);
 const next=randomToken(),key=e.deps.config.mnetEnrollmentServiceFixture!.keys[0];e.deps.config.mnetEnrollmentServiceFixture!.keys.push({...key,keyId:"rotated-budget",digest:await hash(next)});
 expect((await e.call("/status",e.proof,{authorization:`Bearer rotated-budget.${next}`})).status).toBe(429);
 expect((await e.call("/ack",{...e.proof,receiptId:randomToken(),receiptDigest:randomToken()})).status).toBe(200);
});
it("never accepts issued/unreserved history, malformed/extra body, cookie or disabled production scope",async()=>{
 const e=await setupBookkeeping(),proof={handoffId:e.request.handoffId,attemptId:e.request.launch.attemptId,reserveId:e.request.reserveId,descriptorDigest:randomToken()};
 const call=(body:unknown,headers:Record<string,string>={})=>e.app.request(path+"/ack",{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:e.authorization,...headers},body:JSON.stringify(body)});
 const receipt={...proof,receiptId:randomToken(),receiptDigest:randomToken()};expect((await call(receipt)).status).toBe(403);expect((await call({...receipt,extra:true})).status).toBe(400);expect((await call(receipt,{cookie:e.person.cookie})).status).toBe(403);
 e.deps.config.mode="production";expect((await call(receipt)).status).toBe(404);expect((await e.db.select().from(journal).get())!.status).toBe("issued");
});
it("reopens after uncertainty and records one exact receipt without losing reserved evidence",async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{openSqlite}=await import("@/server/db/node"),{createApp}=await import("@/server/app");
 const e=await setup();e.deps.now=()=>new Date(e.reserved.deadline);expect((await e.call("/status")).status).toBe(200);
 const dir=await mkdtemp(join(tmpdir(),"mnet-uncertain-reopen-")),file=join(dir,"fixture.db"),client=(e.db as unknown as {$client:{backup(p:string):Promise<unknown>;close():void}}).$client;
 await client.backup(file);client.close();const db=openSqlite(file),app=createApp({...e.deps,db});
 try{
  const receipt={...e.proof,receiptId:randomToken(),receiptDigest:randomToken()},call=()=>app.request(path+"/ack",{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:e.authorization},body:JSON.stringify(receipt)});
  const first=await call();expect(first.status).toBe(200);expect(await(await call()).json()).toEqual(await first.json());const row=await db.select().from(journal).get();expect(row!.eventSeq).toBe(3);expect(row!.status).toBe("consumed");
 }finally{(db as unknown as {$client:{close():void}}).$client.close();await rm(dir,{recursive:true,force:true});}
});
it.each(["valid-reserve","bad-sequence"])("migration0175 preserves or atomically refuses old %s evidence",async(mode)=>{
 const {openSqlite}=await import("@/server/db/node"),{applyMigrations,migrationDriver}=await import("@/server/db"),{MIGRATIONS}=await import("@/server/db/migrations.generated");
 const db=openSqlite(":memory:"),client=(db as unknown as {$client:{close():void}}).$client,driver=migrationDriver(client);
 try{
  await applyMigrations(driver,MIGRATIONS.filter(m=>/^017[34]_/.test(m.name)));
  const event=JSON.stringify([{seq:mode==="valid-reserve"?1:7,kind:"reserve",id:"fixture-event"}]);
  await db.run(sql`INSERT INTO mnet_enrollment_handoffs(id,attempt_hash,version,purpose,status,created_at,expires_at,events) VALUES('fixture-row','fixture-attempt',1,'mnet-enrollment','reserved',1,2,${event})`);
  const next=MIGRATIONS.filter(m=>m.name.startsWith("0175_"));
  if(mode==="bad-sequence"){
   await expect(applyMigrations(driver,next)).rejects.toThrow();const rows=await db.all(sql`SELECT * FROM mnet_enrollment_handoffs`);expect(rows).toHaveLength(1);expect(rows[0].events).toBe(event);expect(rows[0]).not.toHaveProperty("event_seq");
  }else{
   await applyMigrations(driver,next);const row=(await db.all(sql`SELECT status,event_seq AS eventSeq,descriptor_encoding_version AS descriptorEncodingVersion,events,receipt_id AS receiptId,receipt_digest AS receiptDigest FROM mnet_enrollment_handoffs`))[0];expect(row).toMatchObject({status:"reserved",eventSeq:1,descriptorEncodingVersion:1,events:event,receiptId:null,receiptDigest:null});
   expect(()=>db.run(sql`UPDATE mnet_enrollment_handoffs SET event_seq=2`)).toThrow();
  }
 }finally{client.close();}
});
it("crossing the deadline during an ack cannot skip uncertainty or renew the reserve",async()=>{
 const {authenticateEnrollmentService}=await import("@/server/services/mnet-enrollment-reserve"),{acknowledgeEnrollment}=await import("@/server/services/mnet-enrollment-bookkeeping");
 const e=await setup(),service=await authenticateEnrollmentService(e.deps,new Headers({authorization:e.authorization})),receipt={...e.proof,receiptId:randomToken(),receiptDigest:randomToken()},deadline=new Date(e.reserved.deadline).getTime();let calls=0;
 e.deps.now=()=>new Date(++calls===1?deadline-1:deadline);
 await expect(acknowledgeEnrollment(e.deps,service,receipt)).rejects.toMatchObject({status:403});
 const row=await e.db.select().from(journal).get();expect(row!.status).toBe("reserved");expect(row!.eventSeq).toBe(1);
 e.deps.now=()=>new Date(deadline);expect((await acknowledgeEnrollment(e.deps,service,receipt)).status).toBe("consumed");expect((await e.db.select().from(journal).get())!.eventSeq).toBe(3);
});

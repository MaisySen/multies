import { describe,it,expect } from "vitest";
import { randomToken } from "@/server/lib/crypto";
import { hash } from "@/server/services/mnet";
import { loadConfig } from "@/server/config";
import { makeTestApp,Client } from "./helpers";
import { eq,sql } from "drizzle-orm";
import { users,members,sessions,mnetEnrollmentHandoffs as journal } from "@/server/db/schema";
import { sweepHandoffs } from "@/server/services/mnet-enrollment-handoff";
const handoffPolicy={consentMs:600000,codeMs:60000,ticketMs:120000,fullRowRetentionMs:1000,capacity:10,maxRows:100,retention:"terminal-hash-tombstone"};
const path="/api/mnet-enrollment-service-v1/reserve";
async function setup(){
 const secret=randomToken();
 const fixture={reserveMs:30000,eventCapacity:2,requestsPerMinute:100,keys:[{keyId:"fixture-key",serviceId:"fixture-registrar",active:true,digest:await hash(secret),registrarOrigin:"https://registrar.test",issuer:"https://issuer.test/path",audience:"fixture-enrollment"}]};
 const e=await makeTestApp({MNET_ENROLLMENT_HANDOFF:"on",MNET_ENROLLMENT_HANDOFF_FIXTURE:JSON.stringify(handoffPolicy),MNET_ENROLLMENT_SERVICE:"on",MNET_ENROLLMENT_SERVICE_FIXTURE:JSON.stringify(fixture)});
 const person=new Client(e.app);await person.signup();const user=await e.db.select().from(users).where(eq(users.email,person.email!)).get();await e.db.update(users).set({emailVerified:true}).where(eq(users.id,user!.id));const member=await e.db.select().from(members).where(eq(members.userId,user!.id)).get();
 e.deps.config.mnetEnrollmentOperator={revision:"fixture-r1",issuer:fixture.keys[0].issuer,registrarOrigin:fixture.keys[0].registrarOrigin,audience:fixture.keys[0].audience,bindings:[{workspaceId:member!.organizationId,networkId:"fixture-net",principals:[user!.id]}]};
 const verifier=randomToken(),launch={version:1,purpose:"mnet-enrollment",attemptId:randomToken(),devicePublicKey:randomToken(),credentialDigest:randomToken(),challenge:await hash(verifier),state:randomToken(),platform:"linux",redirectUri:"http://127.0.0.1:34567/mnet/enrollment/callback"};
 const displayed={issuer:fixture.keys[0].issuer,registrarOrigin:fixture.keys[0].registrarOrigin,audience:fixture.keys[0].audience,mappingRevision:"fixture-r1",networkId:"fixture-net"};
 const prepared=await person.post("/api/mnet-enrollment-v1/authorizations",{...launch,workspaceId:member!.organizationId,displayed});expect(prepared.status).toBe(201);
 const choice=await person.post(`/api/mnet-enrollment-v1/authorizations/${prepared.body.id}/decision`,{decision:"allow"});expect(choice.status).toBe(200);
 const response=await e.app.request("/api/mnet-enrollment-v1/exchange",{method:"POST",headers:{host:"localhost","content-type":"application/json"},body:JSON.stringify({...launch,code:new URL(choice.body.redirectTo).searchParams.get("code"),verifier})});expect(response.status).toBe(200);const issued=await response.json();
 const request={ticket:issued.ticket,handoffId:issued.id,reserveId:randomToken(),launch,binding:issued.binding};
 const authorization=`Bearer fixture-key.${secret}`;
 const send=(body:unknown=request,headers:Record<string,string>={})=>e.app.request(path,{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization,...headers},body:JSON.stringify(body)});
 return {...e,person,user:user!,request,authorization,send};
}
describe("local service auth and immutable reserve, no node authority",()=>{
 it("is off by default and cannot enable in production",async()=>{
  const e=await makeTestApp();expect((await e.app.request(path,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status).toBe(404);
  expect(()=>loadConfig({APP_SECRET:"t".repeat(40),MNET_ENROLLMENT_SERVICE:"on"})).toThrow();
  expect(()=>loadConfig({APP_SECRET:"t".repeat(40),APP_MODE:"production",MNET_ENROLLMENT_SERVICE:"on",MNET_ENROLLMENT_SERVICE_FIXTURE:"{}"})).toThrow();
 });
 it("reserves once with atomic event and returns identical metadata on exact retry",async()=>{
  const e=await setup(),r=await e.send();expect(r.status).toBe(200);const body=await r.json();expect(body).toMatchObject({reserveId:e.request.reserveId,status:"reserved",enrolled:false});
  expect(await (await e.send()).json()).toEqual(body);
  const row=await e.db.select().from(journal).get();expect(row!.status).toBe("reserved");const events=JSON.parse(row!.events);expect(events).toHaveLength(1);expect(events[0]).toMatchObject({seq:1,kind:"reserve",serviceId:"fixture-registrar",reserveId:e.request.reserveId,descriptorDigest:body.descriptorDigest});expect(row!.events).not.toContain(e.request.ticket);
 });
 it("authenticates before malformed body or any ticket lookup",async()=>{
  const e=await setup();
  for(const authorization of ["", "Bearer wrong",e.authorization+", "+e.authorization,e.authorization.replace("Bearer","bearer"),`Bearer other.${randomToken()}`]){
   const r=await e.app.request(path,{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization},body:"not json"});expect(r.status).toBe(403);
  }
  expect((await e.send(e.request,{cookie:e.person.cookie})).status).toBe(403);expect((await e.send(e.request,{origin:"http://localhost"})).status).toBe(403);
  e.deps.config.mnetEnrollmentServiceFixture!.keys[0].active=false;expect((await e.send()).status).toBe(403);
  expect((await e.db.select().from(journal).get())!.status).toBe("issued");
 });
 it("has one winner for conflicting concurrent descriptors and a single event for identical retries",async()=>{
  const e=await setup();const results=await Promise.all([e.send(),e.send({...e.request,reserveId:randomToken()}),e.send(),e.send()]);expect(results.filter(r=>r.status===200).length).toBeGreaterThan(0);expect(results.some(r=>r.status===403)).toBe(true);
  const bodies=await Promise.all(results.filter(r=>r.status===200).map(r=>r.json()));expect(new Set(bodies.map(b=>b.reserveId)).size).toBe(1);expect(JSON.parse((await e.db.select().from(journal).get())!.events)).toHaveLength(1);
 });
 it("rolls back reserve and event together on an injected SQL append failure",async()=>{
  const e=await setup();await e.db.run(sql`CREATE TRIGGER fixture_reserve_fail BEFORE UPDATE OF events ON mnet_enrollment_handoffs BEGIN SELECT RAISE(ABORT,'fixture append fail'); END`);
  expect((await e.send()).status).toBe(500);expect(await e.db.select().from(journal).get()).toMatchObject({status:"issued",reserveId:null,descriptorDigest:null,events:"[]"});
  await e.db.run(sql`DROP TRIGGER fixture_reserve_fail`);expect((await e.send()).status).toBe(200);
 });
 it("retains reserved evidence through deadline, session deletion, cleanup and config refusal",async()=>{
  const e=await setup();const r=await e.send();expect(r.status).toBe(200);const row=await e.db.select().from(journal).get();
  await e.db.delete(sessions).where(eq(sessions.userId,e.user.id));e.deps.now=()=>new Date(Date.now()+86400000);await sweepHandoffs(e.deps);
  expect(await e.db.select().from(journal).get()).toEqual(row);expect((await e.send()).status).toBe(403);expect(await e.db.select().from(journal).get()).toEqual(row);
 });
});

it("rejects joined duplicate Authorization and duplicate JSON before spending ticket",async()=>{
 const e=await setup(),headers=new Headers({host:"localhost","content-type":"application/json"});headers.append("authorization",e.authorization);headers.append("authorization",e.authorization);
 expect((await e.app.request(path,{method:"POST",headers,body:JSON.stringify(e.request)})).status).toBe(403);
 const raw=JSON.stringify(e.request).replace('"ticket":','"ticket":"ambiguous","ticket":');
 expect((await e.app.request(path,{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:e.authorization},body:raw})).status).toBe(400);
 const large=" ".repeat(9000)+JSON.stringify(e.request);expect((await e.app.request(path,{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:e.authorization},body:large})).status).toBe(400);
 expect((await e.db.select().from(journal).get())!.status).toBe("issued");
});
it.each(["tuple","scope","mapping","membership","deadline","events"])("refuses reserve after %s mismatch without issuing or appending",async(mode)=>{
 const e=await setup();let p=e.request;
 if(mode==="tuple")p={...p,launch:{...p.launch,credentialDigest:randomToken()}};
 if(mode==="scope")e.deps.config.mnetEnrollmentServiceFixture!.keys[0].audience="other";
 if(mode==="mapping")e.deps.config.mnetEnrollmentOperator!.revision="changed";
 if(mode==="membership")await e.db.update(members).set({disabledAt:new Date()}).where(eq(members.userId,e.user.id));
 if(mode==="deadline"){const row=await e.db.select().from(journal).get();e.deps.now=()=>row!.ticketExpiresAt!;}
 if(mode==="events")await e.db.update(journal).set({events:JSON.stringify([{id:"fixture-1"},{id:"fixture-2"}])});
 expect((await e.send(p)).status).toBe(403);const row=await e.db.select().from(journal).get();expect(row!.status).toBe("issued");expect(row!.reserveId).toBeNull();expect(JSON.parse(row!.events)).toHaveLength(mode==="events"?2:0);
});
it("uses dedicated service budget while inherited app limiter still stacks",async()=>{
 const e=await setup();e.deps.config.mnetEnrollmentServiceFixture!.requestsPerMinute=2;
 for(let i=0;i<2;i++)expect((await e.send({}, {authorization:"invalid"})).status).toBe(403);
 expect((await e.send()).status).toBe(429);
 // Service failures do not consume the separate handoff20/min bucket.
 const qs=new URLSearchParams(Object.entries(e.request.launch).map(([k,v])=>[k,String(v)]));expect((await e.person.get("/api/mnet-enrollment-v1/authorize?"+qs)).status).toBe(200);
 const e2=await setup();e2.deps.rateLimiters={app:{async limit(){return {success:false};}}};
 expect((await e2.send()).status).toBe(429);expect((await e2.db.select().from(journal).get())!.status).toBe("issued");
});
it("allows active-key rotation only for the same service scope and never extends a reserve",async()=>{
 const e=await setup(),r=await e.send();expect(r.status).toBe(200);const original=await r.json();
 const next=randomToken(),old=e.deps.config.mnetEnrollmentServiceFixture!.keys[0];old.active=false;
 e.deps.config.mnetEnrollmentServiceFixture!.keys.push({...old,keyId:"rotated",active:true,digest:await hash(next)});
 expect((await e.send()).status).toBe(403);
 const retry=await e.send(e.request,{authorization:`Bearer rotated.${next}`});expect(retry.status).toBe(200);expect(await retry.json()).toEqual(original);
 e.deps.config.mnetEnrollmentServiceFixture!.keys[1].serviceId="other-service";expect((await e.send(e.request,{authorization:`Bearer rotated.${next}`})).status).toBe(403);
});

it("executes migration rebuild and reserve/event SQL on local Miniflare D1, not deployed D1",async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import("miniflare"),{drizzle}=await import("drizzle-orm/d1"),{applyMigrations,migrationDriver}=await import("@/server/db"),schema=await import("@/server/db/schema"),{authenticateEnrollmentService,reserveEnrollment}=await import("@/server/services/mnet-enrollment-reserve");
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default { fetch() { return new Response('fixture'); } }",compatibilityDate:"2026-10-26",d1Databases:["DB"]}));
 try{
  const raw=await mf.getD1Database("DB");
  // Isolated SQL fixture, not the full app migration chain (which fails on a
  // historical0073 entry in this emulator, cause unresolved and recorded separately).
  const {MIGRATIONS}=await import("@/server/db/migrations.generated");
  await applyMigrations(migrationDriver(raw),MIGRATIONS.filter(m=>/^017[34]_/.test(m.name)));
  for(const ddl of ["CREATE TABLE users(id text PRIMARY KEY,banned integer,email_verified integer)","CREATE TABLE organizations(id text PRIMARY KEY,is_demo integer,suspended_at integer,require_sso integer)","CREATE TABLE members(user_id text,organization_id text,kind text,disabled_at integer,role text)","CREATE TABLE sessions(id text PRIMARY KEY,user_id text,expires_at integer,impersonated_by text,login_method text)"])await raw.prepare(ddl).run();
  const e=await setup(),db=drizzle(raw,{schema});
  // Minimal source-matching eligibility columns only. The actual reserve
  // implementation and full new journal schema execute on the D1 emulator.
  const person=(await e.db.select().from(users))[0],org=(await e.db.select().from(schema.organizations))[0],membership=(await e.db.select().from(members))[0],session=(await e.db.select().from(sessions))[0];
  await raw.prepare("INSERT INTO users VALUES(?,?,?)").bind(person.id,person.banned?1:0,person.emailVerified?1:0).run();
  await raw.prepare("INSERT INTO organizations VALUES(?,?,?,?)").bind(org.id,org.isDemo?1:0,org.suspendedAt?.getTime()??null,org.requireSso?1:0).run();
  await raw.prepare("INSERT INTO members VALUES(?,?,?,?,?)").bind(membership.userId,membership.organizationId,membership.kind,membership.disabledAt?.getTime()??null,membership.role).run();
  await raw.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").bind(session.id,session.userId,session.expiresAt.getTime(),session.impersonatedBy,session.loginMethod).run();
  await db.insert(journal).values(await e.db.select().from(journal));
  const deps={...e.deps,db:db as unknown as typeof e.db},service=await authenticateEnrollmentService(deps,new Headers({authorization:e.authorization}));
  const first=await reserveEnrollment(deps,service,e.request);expect(first.status).toBe("reserved");
  expect(await reserveEnrollment(deps,service,e.request)).toEqual(first);
  const row=await db.select().from(journal).get();expect(row!.status).toBe("reserved");expect(JSON.parse(row!.events)).toHaveLength(1);
  await sweepHandoffs({...deps,now:()=>new Date(Date.now()+86400000)});expect(await db.select().from(journal).get()).toEqual(row);
 }finally{await mf.dispose();}
},30000);

it("preserves existing rows/indexes across CHECK rebuild and rolls migration failure back atomically",async()=>{
 const {openSqlite}=await import("@/server/db/node"),{applyMigrations,migrationDriver}=await import("@/server/db"),{MIGRATIONS}=await import("@/server/db/migrations.generated");
 const db=openSqlite(":memory:"),client=(db as unknown as {$client:{close():void}}).$client,driver=migrationDriver(client),old=MIGRATIONS.filter(m=>m.name.startsWith("0173_")),next=MIGRATIONS.filter(m=>m.name.startsWith("0174_"));
 try{
  await applyMigrations(driver,old);
  await db.run(sql`INSERT INTO mnet_enrollment_handoffs(id,attempt_hash,version,purpose,status,created_at,expires_at) VALUES('fixture-old','fixture-attempt',1,'mnet-enrollment','issued',1,2)`);
  expect(()=>db.run(sql`UPDATE mnet_enrollment_handoffs SET status='reserved'`)).toThrow();
  await expect(applyMigrations(driver,[{name:"fixture_rebuild_fault",statements:[...next[0].statements,"INSERT INTO deliberately_missing_table VALUES(1)"]}])).rejects.toThrow();
  const afterFault=await db.all(sql`SELECT * FROM mnet_enrollment_handoffs`);expect(afterFault).toHaveLength(1);expect(afterFault[0].status).toBe("issued");expect(afterFault[0]).not.toHaveProperty("reserve_id");
  await applyMigrations(driver,next);const row=await db.select().from(journal).get();expect(row).toMatchObject({id:"fixture-old",attemptHash:"fixture-attempt",status:"issued",reserveId:null,events:"[]"});
  const indexes=await db.all(sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mnet_enrollment_handoffs'`);expect(indexes.map(r=>r.name)).toContain("mnet_handoff_reserve_uq");
 }finally{client.close();}
});
it("reopens a file-backed reserved record and constructs new handlers without a second event",async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{openSqlite}=await import("@/server/db/node"),{createApp}=await import("@/server/app");
 const e=await setup(),directory=await mkdtemp(join(tmpdir(),"mnet-reserve-reopen-")),file=join(directory,"fixture.db");
 const initial=await e.send();expect(initial.status).toBe(200);const original=await initial.json();
 const client=(e.db as unknown as {$client:{backup(p:string):Promise<unknown>;close():void}}).$client;await client.backup(file);client.close();
 const db=openSqlite(file),app=createApp({...e.deps,db});
 try{
  const result=await app.request(path,{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:e.authorization},body:JSON.stringify(e.request)});
  expect(result.status).toBe(200);expect(await result.json()).toEqual(original);expect(JSON.parse((await db.select().from(journal).get())!.events)).toHaveLength(1);
 }finally{(db as unknown as {$client:{close():void}}).$client.close();await rm(directory,{recursive:true,force:true});}
});

it("rejects duplicate Authorization on actual local HTTP ingress before ticket mutation",async()=>{
 const {createServer,request}=await import("node:http"),{getRequestListener}=await import("@hono/node-server");const e=await setup(),server=createServer(getRequestListener(e.app.fetch));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port;
 try{
  const status=await new Promise<number>((resolve,reject)=>{const req=request({hostname:"127.0.0.1",port,path,method:"POST",headers:["Host","localhost","Content-Type","application/json","Authorization",e.authorization,"Authorization",e.authorization]},res=>{res.resume();res.on("end",()=>resolve(res.statusCode!));});req.on("error",reject);req.end(JSON.stringify(e.request));});
  expect(status).toBe(403);expect((await e.db.select().from(journal).get())!.status).toBe("issued");
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it("refuses valid-config production startup/runtime and provides no status/ack consumers",async()=>{
 const e=await setup();expect(()=>loadConfig({APP_SECRET:"t".repeat(40),APP_MODE:"production",MNET_ENROLLMENT_SERVICE:"on",MNET_ENROLLMENT_SERVICE_FIXTURE:JSON.stringify(e.deps.config.mnetEnrollmentServiceFixture)})).toThrow();
 for(const endpoint of ["/status","/ack","/recover","/consume"])expect((await e.app.request("/api/mnet-enrollment-service-v1"+endpoint,{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:e.authorization},body:"{}"})).status).toBe(404);
 e.deps.config.mode="production";expect((await e.send()).status).toBe(404);expect((await e.db.select().from(journal).get())!.status).toBe("issued");
});
it("does not look up a ticket when service auth fails",async()=>{
 const e=await setup();const raw=(e.db as unknown as {$client:{prepare(s:string):unknown}}).$client,prepare=raw.prepare.bind(raw);let lookups=0;
 raw.prepare=(query:string)=>{if(/select/i.test(query)&&/mnet_enrollment_handoffs/i.test(query))lookups++;return prepare(query);};
 try{expect((await e.send(e.request,{authorization:"Bearer bad"})).status).toBe(403);expect(lookups).toBe(0);}finally{raw.prepare=prepare;}
 expect((await e.send()).status).toBe(200);
});
it("a reserve ID claimed for another handoff gives controlled refusal with no second event",async()=>{
 const e=await setup();expect((await e.send()).status).toBe(200);const original=(await e.db.select().from(journal).get())!,ticket=randomToken(),attemptId=randomToken(),id=randomToken();
 await e.db.insert(journal).values({...original,id,attemptHash:await hash(attemptId),attemptId,ticketHash:await hash(ticket),status:"issued",reserveId:null,serviceId:null,descriptorDigest:null,reserveDeadline:null,events:"[]"});
 expect((await e.send({...e.request,handoffId:id,ticket,launch:{...e.request.launch,attemptId}})).status).toBe(403);
 expect(await e.db.select().from(journal).where(eq(journal.id,id)).get()).toMatchObject({status:"issued",events:"[]",reserveId:null});
});

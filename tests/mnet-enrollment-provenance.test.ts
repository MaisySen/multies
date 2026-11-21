import {it,expect} from "vitest";
import {eq,sql} from "drizzle-orm";
import {setupBookkeeping} from "./mnet-enrollment-bookkeeping-fixture";
import {mnetEnrollmentHandoffs as journal,sessions,members} from "@/server/db/schema";
import {randomToken} from "@/server/lib/crypto";
import {hash} from "@/server/services/mnet";
import {sweepHandoffs} from "@/server/services/mnet-enrollment-handoff";
const base="/api/mnet-enrollment-service-v1";
async function evidence(e:Awaited<ReturnType<typeof setupBookkeeping>>,body:unknown=e.request,headers:Record<string,string>={}){
 return e.app.request(base+"/reserve-evidence-v2",{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:e.authorization,...headers},body:JSON.stringify(body)});
}
it("returns exact own-PKCE and same-live-reserve namespaced provenance, no raw session or bearer",async()=>{
 const e=await setupBookkeeping(true),row=(await e.db.select().from(journal).get())!;
 expect(e.issued.responseVersion).toBe(2);expect(e.issued.provenance).toEqual({principalAuthority:"https://multies.test",principalNamespace:"multies-local-user-v1",principalId:e.user.id,sessionBinding:row.sessionBinding});
 expect(row.sessionBinding).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(row.sessionBinding).not.toBe(row.sessionId);expect(row.sessionBinding).not.toBe(await hash(row.sessionId!));
 const response=await evidence(e);expect(response.status).toBe(200);const result=await response.json();
 expect(result.provenance).toEqual(e.issued.provenance);expect(result.launch).toEqual(e.issued.launch);expect(result.binding).toEqual(e.issued.binding);expect(result).toMatchObject({responseVersion:2,status:"reserved",descriptorEncodingVersion:1,authorityGranted:false,enrolled:false});
 const text=JSON.stringify(result);expect(text).not.toContain(row.sessionId!);for(const session of await e.db.select().from(sessions))expect(text).not.toContain(session.token);
 expect(result).not.toHaveProperty("ticket");expect(result).not.toHaveProperty("accessUntil");expect(result).not.toHaveProperty("permit");
 const retry=await evidence(e);expect(retry.status).toBe(200);const again=await retry.json();expect(again.deadline).toBe(result.deadline);expect(again.provenance).toEqual(result.provenance);expect(again.descriptorDigest).toBe(result.descriptorDigest);expect(JSON.parse((await e.db.select().from(journal).get())!.events)).toHaveLength(1);
});
it("keeps v1 response private and cannot backfill provenance after enabling config",async()=>{
 const e=await setupBookkeeping();expect(e.issued).not.toHaveProperty("provenance");const before=(await e.db.select().from(journal).get())!;expect(before.sessionBinding).toBeNull();
 e.deps.config.mnetEnrollmentOperator!.provenance={version:2,principalAuthority:"https://multies.test",principalNamespace:"multies-local-user-v1"};
 expect((await evidence(e)).status).toBe(403);expect(await e.db.select().from(journal).get()).toEqual(before);expect((await e.send()).status).toBe(200);
});
it("never makes historical status live evidence after membership deletion",async()=>{
 const e=await setupBookkeeping(true),response=await evidence(e);expect(response.status).toBe(200);const result=await response.json();
 await e.db.delete(members).where(eq(members.userId,e.user.id));expect((await evidence(e)).status).toBe(403);
 const status=await e.app.request(base+"/status",{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:e.authorization},body:JSON.stringify({handoffId:e.request.handoffId,attemptId:e.request.launch.attemptId,reserveId:e.request.reserveId,descriptorDigest:result.descriptorDigest})});
 expect(status.status).toBe(200);const history=await status.json();expect(history.authorityGranted).toBe(false);expect(history).not.toHaveProperty("provenance");expect(history).not.toHaveProperty("checkedAt");
});
it.each(["missing-config","authority-change","missing-binding","malformed-binding","session-deleted","deadline","revoked-service"])("refuses %s without reinterpreting or renewing provenance",async(mode)=>{
 const e=await setupBookkeeping(true);expect((await evidence(e)).status).toBe(200);let row=(await e.db.select().from(journal).get())!;
 switch(mode){
 case "missing-config":delete e.deps.config.mnetEnrollmentOperator!.provenance;break;
 case "authority-change":e.deps.config.mnetEnrollmentOperator!.provenance!.principalAuthority="https://other.test";break;
 case "missing-binding":await e.db.update(journal).set({sessionBinding:null});break;
 case "malformed-binding":await e.db.update(journal).set({sessionBinding:"internal-session-id"});break;
 case "session-deleted":await e.db.delete(sessions).where(eq(sessions.id,row.sessionId!));break;
 case "deadline":e.deps.now=()=>new Date(row.reserveDeadline!);break;
 case "revoked-service":e.deps.config.mnetEnrollmentServiceFixture!.keys[0].active=false;break;
 }
 row=(await e.db.select().from(journal).get())!;expect((await evidence(e)).status).toBe(403);expect(await e.db.select().from(journal).get()).toEqual(row);
});
it("authenticates and rejects untrusted provenance fields/cookies before evidence",async()=>{
 const e=await setupBookkeeping(true),before=await e.db.select().from(journal).get();
 expect((await evidence(e,{...e.request,principalId:e.user.id})).status).toBe(400);
 expect((await evidence(e,e.request,{authorization:"Bearer invalid"})).status).toBe(403);
 expect((await evidence(e,e.request,{cookie:e.person.cookie})).status).toBe(403);
 expect((await evidence(e,e.request,{origin:"https://multies.test"})).status).toBe(403);
 expect(await e.db.select().from(journal).get()).toEqual(before);
 e.deps.config.mode="production";expect((await evidence(e)).status).toBe(404);
});
it("generates fresh unrelated binding for same-session second handoff, scrubs only terminal pre-reserve",async()=>{
 const e=await setupBookkeeping(true);const original=(await e.db.select().from(journal).get())!;
 const verifier=randomToken(),launch={...e.request.launch,attemptId:randomToken(),challenge:await hash(verifier),state:randomToken()};
 const {workspaceId,...displayed}=e.request.binding;
 const p=await e.person.post("/api/mnet-enrollment-v1/authorizations",{...launch,workspaceId,displayed});expect(p.status).toBe(201);
 const second=(await e.db.select().from(journal).where(eq(journal.id,p.body.id)).get())!;
 expect(second.sessionId).toBe(original.sessionId);expect(second.sessionBinding).not.toBe(original.sessionBinding);
 await e.person.post(`/api/mnet-enrollment-v1/authorizations/${p.body.id}/decision`,{decision:"decline"});
 e.deps.now=()=>new Date(Date.now()+2000);await sweepHandoffs(e.deps);
 const scrubbed=(await e.db.select().from(journal).where(eq(journal.id,second.id)).get())!;expect(scrubbed.sessionBinding).toBeNull();expect(scrubbed.principalAuthority).toBeNull();expect(scrubbed.principalNamespace).toBeNull();
});
it("migration0176 preserves old rows as NULL without claiming provenance",async()=>{
 const {openSqlite}=await import("@/server/db/node"),{applyMigrations,migrationDriver}=await import("@/server/db"),{MIGRATIONS}=await import("@/server/db/migrations.generated");
 const db=openSqlite(":memory:"),client=(db as unknown as {$client:{close():void}}).$client;
 try{
 await applyMigrations(migrationDriver(client),MIGRATIONS.filter(m=>/^017[345]_/.test(m.name)));
 await db.run(sql`INSERT INTO mnet_enrollment_handoffs(id,attempt_hash,version,purpose,status,created_at,expires_at) VALUES('old','old-attempt',1,'mnet-enrollment','issued',1,2)`);
 await applyMigrations(migrationDriver(client),MIGRATIONS.filter(m=>m.name.startsWith("0176_")));
 expect(await db.select().from(journal).get()).toMatchObject({id:"old",status:"issued",sessionBinding:null,principalAuthority:null,principalNamespace:null});
 }finally{client.close();}
});

it("ownPKCE v2 wrong verifier/namespace or ambient auth cannot consume correct owner's code",async()=>{
 const e=await setupBookkeeping(true),verifier=randomToken();
 const launch={...e.request.launch,attemptId:randomToken(),challenge:await hash(verifier),state:randomToken()};const {workspaceId,...displayed}=e.request.binding;
 const prepared=await e.person.post("/api/mnet-enrollment-v1/authorizations",{...launch,workspaceId,displayed});expect(prepared.status).toBe(201);
 const choice=await e.person.post(`/api/mnet-enrollment-v1/authorizations/${prepared.body.id}/decision`,{decision:"allow"});expect(choice.status).toBe(200);
 const proof={...launch,code:new URL(choice.body.redirectTo).searchParams.get("code"),verifier};
 const send=(body:unknown=proof,headers:Record<string,string>={})=>e.app.request("/api/mnet-enrollment-v1/exchange-v2",{method:"POST",headers:{host:"localhost","content-type":"application/json",...headers},body:JSON.stringify(body)});
 const before=await e.db.select().from(journal).where(eq(journal.id,prepared.body.id)).get();
 expect((await send({...proof,verifier:randomToken()})).status).toBe(403);
 expect((await send(proof,{cookie:e.person.cookie})).status).toBe(403);
 expect((await send({...proof,principalId:e.user.id})).status).toBe(400);
 e.deps.config.mnetEnrollmentOperator!.provenance!.principalAuthority="https://changed.test";expect((await send()).status).toBe(403);
 expect(await e.db.select().from(journal).where(eq(journal.id,prepared.body.id)).get()).toEqual(before);
 e.deps.config.mnetEnrollmentOperator!.provenance!.principalAuthority="https://multies.test";const valid=await send();expect(valid.status).toBe(200);const result=await valid.json();expect(result.provenance.sessionBinding).toBe(before!.sessionBinding);expect(result.launch).toEqual(launch);
 expect((await send()).status).toBe(403);
});
it("keeps binding/current provenance after actual backup close/reopen, without rebinding raw session",async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{openSqlite}=await import("@/server/db/node"),{createApp}=await import("@/server/app");
 const e=await setupBookkeeping(true);const first=await evidence(e);expect(first.status).toBe(200);const original=await first.json();
 const dir=await mkdtemp(join(tmpdir(),"mnet-provenance-reopen-")),file=join(dir,"fixture.db"),client=(e.db as unknown as {$client:{backup(p:string):Promise<unknown>;close():void}}).$client;
 await client.backup(file);client.close();const db=openSqlite(file),app=createApp({...e.deps,db});
 try{
 const response=await app.request(base+"/reserve-evidence-v2",{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:e.authorization},body:JSON.stringify(e.request)});expect(response.status).toBe(200);const result=await response.json();expect(result.provenance).toEqual(original.provenance);expect(result.deadline).toBe(original.deadline);expect(result.descriptorDigest).toBe(original.descriptorDigest);
 }finally{(db as unknown as {$client:{close():void}}).$client.close();await rm(dir,{recursive:true,force:true});}
});

it("executes new migration and actual live evidence SQL on isolated local D1, not full chain",async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import("miniflare"),{drizzle}=await import("drizzle-orm/d1"),{applyMigrations,migrationDriver}=await import("@/server/db"),{MIGRATIONS}=await import("@/server/db/migrations.generated"),schema=await import("@/server/db/schema"),{authenticateEnrollmentService,reserveEnrollmentEvidence}=await import("@/server/services/mnet-enrollment-reserve");
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default { fetch(){return new Response('fixture')} }",compatibilityDate:"2026-10-26",d1Databases:["DB"]}));
 try{
  const raw=await mf.getD1Database("DB");await applyMigrations(migrationDriver(raw),MIGRATIONS.filter(m=>/^017[3456]_/.test(m.name)));
  for(const ddl of ["CREATE TABLE users(id text PRIMARY KEY,banned integer,email_verified integer)","CREATE TABLE organizations(id text PRIMARY KEY,is_demo integer,suspended_at integer,require_sso integer)","CREATE TABLE members(user_id text,organization_id text,kind text,disabled_at integer,role text)","CREATE TABLE sessions(id text PRIMARY KEY,user_id text,expires_at integer,impersonated_by text,login_method text)"])await raw.prepare(ddl).run();
  const e=await setupBookkeeping(true),db=drizzle(raw,{schema});
  const person=(await e.db.select().from(schema.users))[0],org=(await e.db.select().from(schema.organizations))[0],member=(await e.db.select().from(schema.members))[0],session=(await e.db.select().from(schema.sessions))[0];
  await raw.prepare("INSERT INTO users VALUES(?,?,?)").bind(person.id,person.banned?1:0,person.emailVerified?1:0).run();
  await raw.prepare("INSERT INTO organizations VALUES(?,?,?,?)").bind(org.id,org.isDemo?1:0,org.suspendedAt?.getTime()??null,org.requireSso?1:0).run();
  await raw.prepare("INSERT INTO members VALUES(?,?,?,?,?)").bind(member.userId,member.organizationId,member.kind,member.disabledAt?.getTime()??null,member.role).run();
  await raw.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").bind(session.id,session.userId,session.expiresAt.getTime(),session.impersonatedBy,session.loginMethod).run();
  await db.insert(journal).values(await e.db.select().from(journal));
  const deps={...e.deps,db:db as unknown as typeof e.db},service=await authenticateEnrollmentService(deps,new Headers({authorization:e.authorization}));
  const first=await reserveEnrollmentEvidence(deps,service,e.request),retry=await reserveEnrollmentEvidence(deps,service,e.request);
  expect(first.provenance).toEqual(e.issued.provenance);expect(retry.provenance).toEqual(first.provenance);expect(retry.deadline).toEqual(first.deadline);
  const saved=await db.select().from(journal).get();expect(JSON.parse(saved!.events)).toHaveLength(1);
  await raw.prepare("DELETE FROM sessions WHERE id=?").bind(session.id).run();
  await expect(reserveEnrollmentEvidence(deps,service,e.request)).rejects.toMatchObject({status:403});expect(await db.select().from(journal).get()).toEqual(saved);
 }finally{await mf.dispose();}
});
it("requires explicit exact namespaced provenance configuration, never inferred OIDC identity",async()=>{
 const {enrollmentOperatorConfig}=await import("@/server/services/mnet-enrollment-config");
 const e=await setupBookkeeping(true),operator=e.deps.config.mnetEnrollmentOperator!;
 expect(enrollmentOperatorConfig(JSON.stringify(operator))!.provenance!.principalNamespace).toBe("multies-local-user-v1");
 for(const change of [{principalNamespace:"oidc-subject"},{principalAuthority:"http://multies.test"},{principalAuthority:"https://multies.test/path"},{extra:true}]){
  expect(()=>enrollmentOperatorConfig(JSON.stringify({...operator,provenance:{...operator.provenance,...change}}))).toThrow();
 }
 const same={...operator,provenance:{...operator.provenance!,principalAuthority:operator.registrarOrigin}};
 expect(enrollmentOperatorConfig(JSON.stringify(same))!.provenance!.principalAuthority).toBe(operator.registrarOrigin);
});

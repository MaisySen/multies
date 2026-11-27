import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { createApp } from "@/server/app";
import { applyMigrations, migrate, migrationDriver } from "@/server/db";
import { MIGRATIONS } from "@/server/db/migrations.generated";
import { openSqlite } from "@/server/db/node";
import { hash, prepareMnet } from "@/server/services/mnet";
import { members, mnetDevices, organizations, sessions, users } from "@/server/db/schema";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let request: {workspaceId:string;deviceKey:string;challenge:string;state:string;platform:"linux";redirectUri:string};
const verifier = "v".repeat(64);
async function exchange(code: string, extra = {}) {
 const r = await ctx.app.request("/api/mnet/token", {method:"POST",headers:{host:"localhost","content-type":"application/json"},body:JSON.stringify({...request,code,verifier,...extra})});
 return {status:r.status,body:await r.json(),headers:r.headers};
}
async function approved() {
 const p=await c.post("/api/mnet/authorizations",request);expect(p.status).toBe(201);
 const a=await c.post(`/api/mnet/authorizations/${p.body.id}/decision`,{decision:"allow"});expect(a.status).toBe(200);
 return {id:p.body.id,code:a.body.code as string};
}
async function devices(token:string) {return ctx.app.request("/api/mnet/devices",{headers:{host:"localhost",authorization:`Bearer ${token}`}});}
beforeEach(async()=>{
 ctx=await makeTestApp({MNET_DEVICE_BRIDGE:"on"});c=new Client(ctx.app);await c.signup("mnet-owner@example.test");
 const u=await ctx.db.select().from(users).where(eq(users.email,"mnet-owner@example.test")).get();
 await ctx.db.update(users).set({emailVerified:true}).where(eq(users.id,u!.id));
 const member=await ctx.db.select().from(members).where(eq(members.userId,u!.id)).get();
 request={workspaceId:member!.organizationId,deviceKey:await hash("exact native key"),challenge:await hash(verifier),state:await hash("native state"),platform:"linux",redirectUri:"http://127.0.0.1:32145/mnet/callback"};
});
describe("isolated Mnet device bridge",()=>{
 it("rejects duplicate decision and binding fields without deciding or consuming a handoff",async()=>{
  const raw=async(path:string,body:string,cookie=true)=>ctx.app.request(path,{method:"POST",headers:{host:"localhost","content-type":"application/json",...(cookie?{cookie:c.cookie}:{})},body});
  const pending=await c.post("/api/mnet/authorizations",request);expect(pending.status).toBe(201);
  for(const body of ['{"decision":"decline","decision":"allow"}','{"decision":"decline","dec\\u0069sion":"allow"}']) {
   expect((await raw(`/api/mnet/authorizations/${pending.body.id}/decision`,body)).status).toBe(400);
   expect((await ctx.db.select().from(mnetDevices).where(eq(mnetDevices.id,pending.body.id)).get())!.status).toBe("pending");
  }
  const allowed=await c.post(`/api/mnet/authorizations/${pending.body.id}/decision`,{decision:"allow"});expect(allowed.status).toBe(200);
  const proof=JSON.stringify({...request,code:allowed.body.code,verifier});
  const duplicate=proof.slice(0,-1)+',"code":'+JSON.stringify(allowed.body.code)+'}';
  expect((await raw("/api/mnet/token",duplicate,false)).status).toBe(400);
  expect((await exchange(allowed.body.code)).status).toBe(200);
 });
 it("rejects ambiguous authorization keys, nonobjects and excessive nesting before creating records",async()=>{
  const raw=async(body:string)=>ctx.app.request("/api/mnet/authorizations",{method:"POST",headers:{host:"localhost","content-type":"application/json",cookie:c.cookie},body});
  const original=JSON.stringify(request);
  for(const body of [original.slice(0,-1)+',"workspaceId":'+JSON.stringify(request.workspaceId)+'}',original.replace('"workspaceId":','"workspac\\u0065Id":"foreign","workspaceId":'),original.slice(0,-1)+',"platform":"linux"}',"null","[]",'"text"',"[".repeat(40)+"0"+"]".repeat(40)]) {
   expect((await raw(body)).status).toBe(400);
   expect(await ctx.db.select().from(mnetDevices)).toHaveLength(0);
  }
 });
 it("caps concurrent handoffs without evicting another current request",async()=>{
  const headers=new Headers({host:"localhost",cookie:c.cookie});
  const results=await Promise.allSettled(Array.from({length:21},()=>prepareMnet(ctx.deps,headers,request)));
  expect(results.filter((r)=>r.status==="fulfilled")).toHaveLength(20);expect(results.filter((r)=>r.status==="rejected")).toHaveLength(1);expect(await ctx.db.select().from(mnetDevices)).toHaveLength(20);
 });
 it("does not let a second session approve the first session's pending device",async()=>{
  const pending=await c.post("/api/mnet/authorizations",request);const second=new Client(ctx.app);await second.login("mnet-owner@example.test");expect((await second.post(`/api/mnet/authorizations/${pending.body.id}/decision`,{decision:"allow"})).status).toBe(403);expect((await c.post(`/api/mnet/authorizations/${pending.body.id}/decision`,{decision:"allow"})).status).toBe(200);
 });
 it("returns fresh exact per-operation evidence, never view/control/file/record authority",async()=>{
  const {code}=await approved();const token=await exchange(code);expect(token.status).toBe(200);
  const check=async(body:unknown)=>{const r=await ctx.app.request("/api/mnet/check",{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:`Bearer ${token.body.credential}`},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const out=await check({workspaceId:request.workspaceId,capability:"list"});expect(out.status).toBe(200);expect(out.body).toMatchObject({deviceKey:"",audience:"mnet",allowed:["list"],verifiedEmail:true,demo:false});expect(Date.parse(out.body.expiresAt)-Date.parse(out.body.checkedAt)).toBeLessThanOrEqual(30_000);
  expect((await check({workspaceId:request.workspaceId,capability:"list"})).body).toMatchObject({deviceKey:"",allowed:["list"]});
  for(const capability of ["enroll","view","control","transfer","record"])expect((await check({workspaceId:request.workspaceId,capability,deviceKey:request.deviceKey})).status).toBe(400);
  expect((await check({workspaceId:request.workspaceId,capability:"enroll",deviceKey:await hash("foreign device")})).status).toBe(400);
  expect((await check({workspaceId:"foreign",capability:"list"})).status).toBe(403);
 });
 it("validates the exact desktop loopback route and no bootstrap on unsigned-in reads",async()=>{
  const {workspaceId:_,...launch}=request;
  const base="/api/mnet/authorize?";
  const anon=new Client(ctx.app);
  const before=await ctx.db.select().from(organizations);
  expect((await anon.get(base+new URLSearchParams(launch))).status).toBe(401);
  for(const redirectUri of ["https://evil.example/mnet/callback","http://localhost:32145/mnet/callback","http://127.0.0.1:32145/elsewhere","http://127.0.0.1:80/mnet/callback","http://127.0.0.1:32145/mnet/callback#fragment","http://127.0.0.1:32145/mnet/callback?next=evil"]){expect((await c.get(base+new URLSearchParams({...launch,redirectUri}))).status).toBe(400);}
  const info=await c.get(base+new URLSearchParams(launch));expect(info.status).toBe(200);expect(info.body.workspaces).toEqual([{id:request.workspaceId,name:"Acme"}]);
  expect((await c.get(base+new URLSearchParams(launch)+"&platform=windows")).status).toBe(400);
  expect(await ctx.db.select().from(organizations)).toHaveLength(before.length);
 });
 it("refuses native exchange cookies/origins, oversized and unknown-field requests",async()=>{
  const {code}=await approved();
  const browserHeaders: Record<string, string>[] = [{ origin: "http://localhost" }, { cookie: c.cookie }];
  for(const headers of browserHeaders){const r=await ctx.app.request("/api/mnet/token",{method:"POST",headers:{host:"localhost","content-type":"application/json",...headers},body:JSON.stringify({...request,code,verifier})});expect(r.status).toBe(403);}
  expect((await c.post("/api/mnet/authorizations",{...request,oversize:"x".repeat(8200)})).status).toBe(400);
  expect((await exchange(code)).status).toBe(200);
 });
 it("freshly denies revoked sessions, disabled/agent membership and member SSO",async()=>{
  for(const patch of [{disabledAt:new Date()},{disabledAt:null,kind:"agent" as const}]){await ctx.db.update(members).set(patch).where(eq(members.organizationId,request.workspaceId));expect((await c.post("/api/mnet/authorizations",request)).status).toBe(403);}
  await ctx.db.update(members).set({disabledAt:null,kind:"human",role:"member"}).where(eq(members.organizationId,request.workspaceId));await ctx.db.update(organizations).set({requireSso:true}).where(eq(organizations.id,request.workspaceId));expect((await c.post("/api/mnet/authorizations",request)).status).toBe(403);
  await ctx.db.update(sessions).set({loginMethod:"google"});const {code}=await approved();const r=await exchange(code);expect(r.status).toBe(200);await ctx.db.delete(sessions);expect((await devices(r.body.credential)).status).toBe(403);
 });
 it("does not accept a browser session as a native token or a native token on account APIs",async()=>{
  expect((await devices(c.cookie)).status).toBe(403);const {code}=await approved();const r=await exchange(code);expect(r.status).toBe(200);
  const me=await ctx.app.request("/api/account/me",{headers:{host:"localhost",authorization:`Bearer ${r.body.credential}`}});expect(me.status).toBe(401);
  const real=ctx.deps.now;ctx.deps.now=()=>new Date(real().getTime()+601_000);expect((await devices(r.body.credential)).status).toBe(403);
 });
 it("keeps both the bridge API and the settings entry disabled by default", async () => {
  const off = new Client((await makeTestApp()).app);
  expect((await off.get("/api/mnet/devices")).status).toBe(404);
  expect((await off.get("/api/config")).body.mnetDeviceBridge).toBe(false);
  expect((await c.get("/api/config")).body.mnetDeviceBridge).toBe(true);
 });
 it("uses real session approval, one-use S256 exchange, scoped device list and revocation",async()=>{
  const {id,code}=await approved();const r=await exchange(code);expect(r.status).toBe(200);expect(r.body).toMatchObject({audience:"mnet",workspaceId:request.workspaceId,deviceKey:request.deviceKey,capabilities:["list"],inputAuthorized:false});expect(r.headers.get("set-cookie")).toBeNull();
  const list=await devices(r.body.credential);expect(list.status).toBe(200);expect(await list.json()).toMatchObject({ownDevicesOnly:true,devices:[{id,deviceKey:request.deviceKey}],inputAuthorized:false});
  expect((await exchange(code)).status).toBe(403);
  const stored=await ctx.db.select().from(mnetDevices).get();expect(stored!.credentialHash).not.toBe(r.body.credential);expect(stored!.codeHash).toBeNull();
  expect((await c.del(`/api/mnet/devices/${id}`)).status).toBe(200);expect((await devices(r.body.credential)).status).toBe(403);
 });
 it("refuses wrong binding without consuming the intended proof and has one concurrent winner",async()=>{
  const {code}=await approved();for(const extra of [{verifier:"x".repeat(64)},{workspaceId:"foreign"},{state:await hash("other")},{deviceKey:await hash("other key")},{platform:"windows"}])expect((await exchange(code,extra)).status).toBe(403);
  const results=await Promise.all([exchange(code),exchange(code)]);expect(results.map(r=>r.status).sort()).toEqual([200,403]);
 });
 it("declines terminally and refuses expired approval",async()=>{
  const p=await c.post("/api/mnet/authorizations",request);expect((await c.post(`/api/mnet/authorizations/${p.body.id}/decision`,{decision:"decline"})).status).toBe(200);expect((await c.post(`/api/mnet/authorizations/${p.body.id}/decision`,{decision:"allow"})).status).toBe(403);
  const {code}=await approved();const real=ctx.deps.now;ctx.deps.now=()=>new Date(real().getTime()+121_000);expect((await exchange(code)).status).toBe(403);
 });
 it("requires fresh device approval after a workspace membership ends and is replaced", async () => {
  const original = await ctx.db.select().from(members).where(eq(members.organizationId, request.workspaceId)).get();
  const active = await approved();
  const originalToken = await exchange(active.code);
  expect(originalToken.status).toBe(200);
  const issued = await approved();
  const pending = await c.post("/api/mnet/authorizations", request);
  expect(pending.status).toBe(201);

  await ctx.db.delete(members).where(eq(members.id, original!.id));
  expect((await devices(originalToken.body.credential)).status).toBe(403);
  await ctx.db.insert(members).values({ ...original!, id: crypto.randomUUID() });

  expect((await c.post(`/api/mnet/authorizations/${pending.body.id}/decision`, { decision: "allow" })).status).toBe(403);
  expect((await exchange(issued.code)).status).toBe(403);
  expect((await devices(originalToken.body.credential)).status).toBe(403);
  const check = await ctx.app.request("/api/mnet/check", {
   method: "POST",
   headers: { host: "localhost", "content-type": "application/json", authorization: `Bearer ${originalToken.body.credential}` },
   body: JSON.stringify({ workspaceId: request.workspaceId, capability: "list" }),
  });
  expect(check.status).toBe(403);
  const oldApprovals = await c.get("/api/mnet/approved-devices");
  expect(oldApprovals.status).toBe(200);
  expect(oldApprovals.body.devices).toEqual([]);

  const fresh = await approved();
  const freshToken = await exchange(fresh.code);
  expect(freshToken.status).toBe(200);
  const list = await devices(freshToken.body.credential);
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ devices: [{ id: fresh.id }] });
  expect((await c.get("/api/mnet/approved-devices")).body.devices).toMatchObject([{ id: fresh.id }]);
 });
 it("requires a new approval after migrating a database with approvals from 0171", async () => {
  const migration = "0172_mnet_membership_binding";
  const db = openSqlite(":memory:");
  const driver = migrationDriver((db as unknown as { $client: unknown }).$client);
  const previous = MIGRATIONS.slice(0, MIGRATIONS.findIndex((entry) => entry.name === migration));
  await applyMigrations(driver, previous);
  const app = createApp({ ...ctx.deps, db });
  const browser = new Client(app);
  const email = await browser.signup("mnet-upgrade@example.test");
  await db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  const member = (await db.select().from(members).get())!;
  const session = (await db.select().from(sessions).where(eq(sessions.userId, member.userId)).get())!;
  const legacyToken = await hash("migration fixture credential");
  const legacyHash = await hash(legacyToken);
  const expires = Date.now() + 60_000;
  await db.run(sql`INSERT INTO mnet_devices
    (id, user_id, session_id, workspace_id, device_key, challenge, state, platform, redirect_uri, status, credential_hash, expires_at, credential_expires_at)
    VALUES ('legacy-device', ${member.userId}, ${session.id}, ${member.organizationId}, ${request.deviceKey}, ${request.challenge}, ${request.state}, ${request.platform}, ${request.redirectUri}, 'active', ${legacyHash}, ${expires}, ${expires})`);

  expect(await migrate(db)).toContain(`${migration}.sql`);
  expect(await migrate(db)).toEqual([]);
  const retired = await db.select().from(mnetDevices).where(eq(mnetDevices.id, "legacy-device")).get();
  expect(retired?.membershipId).toBeNull();
  const list = await app.request("/api/mnet/devices", { headers: { host: "localhost", authorization: `Bearer ${legacyToken}` } });
  expect(list.status).toBe(403);
  expect((await browser.get("/api/mnet/approved-devices")).body.devices).toEqual([]);
  expect((await browser.post("/api/mnet/authorizations", { ...request, workspaceId: member.organizationId })).status).toBe(201);
 });
 it("refuses demo/suspended/banned/unverified/impersonated states",async()=>{
  const u=await ctx.db.select().from(users).where(eq(users.email,"mnet-owner@example.test")).get();
  await ctx.db.update(organizations).set({isDemo:true}).where(eq(organizations.id,request.workspaceId));expect((await c.post("/api/mnet/authorizations",request)).status).toBe(403);
  await ctx.db.update(organizations).set({isDemo:false,suspendedAt:new Date()}).where(eq(organizations.id,request.workspaceId));expect((await c.post("/api/mnet/authorizations",request)).status).toBe(403);
  await ctx.db.update(organizations).set({suspendedAt:null}).where(eq(organizations.id,request.workspaceId));
  for(const state of [{banned:true,emailVerified:true},{banned:false,emailVerified:false}]){await ctx.db.update(users).set(state).where(eq(users.id,u!.id));expect((await c.post("/api/mnet/authorizations",request)).status).toBe(403);}
  await ctx.db.update(users).set({banned:false,emailVerified:true}).where(eq(users.id,u!.id));await ctx.db.update(sessions).set({impersonatedBy:u!.id}).where(eq(sessions.userId,u!.id));expect((await c.post("/api/mnet/authorizations",request)).status).toBe(403);
 });
 it("never infers workspace ownership or grants input/foreign-device visibility",async()=>{
  const other=new Client(ctx.app);await other.signup("other-mnet@example.test");const p=await approved();expect((await other.post(`/api/mnet/authorizations/${p.id}/decision`,{decision:"allow"})).status).toBe(403);expect((await other.del(`/api/mnet/devices/${p.id}`)).status).toBe(403);
  expect((await c.post("/api/mnet/authorizations",{...request,workspaceId:"absent"})).status).toBe(403);
  expect((await c.post("/api/mnet/authorizations",{...request,capabilities:["control"]})).status).toBe(400);
 });
});

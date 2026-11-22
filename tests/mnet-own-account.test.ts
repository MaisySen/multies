import labelBoundaries from "./fixtures/account-label-boundaries-v1.json";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { hash } from "@/server/services/mnet";
import { mnetOwnAccountSummarySchema } from "@/server/services/mnet-own-account";
import { members, mnetDevices, organizations, sessions, users } from "@/server/db/schema";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let client: Client;
let token: string;
let workspaceId: string;
let deviceKey: string;
let userId: string;
async function summary(body = "{}", headers: Record<string,string> = {}, query = "") {
 return ctx.app.request("/api/mnet/account-v1"+query, {method:"POST", headers:{host:"localhost", "content-type":"application/json", authorization:`Bearer ${token}`, ...headers}, body});
}
beforeEach(async () => {
 ctx = await makeTestApp({MNET_DEVICE_BRIDGE:"on"});
 // This matrix checks protocol grammar, not throttling. Keep the production
 // limiter unchanged and use its existing deterministic dependency seam.
 ctx.deps.rateLimiters = {handoff:{limit:async () => ({success:true})}};
 // Inject only the source-owned operator DATA, never turn on enrollment consent
 // or handoff flags merely to test an own-account metadata read.
 ctx.deps.config.mnetEnrollmentOperator = {
  provenance:{version:2,principalAuthority:"https://identity.example.invalid",principalNamespace:"multies-local-user-v1"},
  revision:"own-account-source",issuer:"https://identity.example.invalid/issuer",registrarOrigin:"https://registrar.example.invalid",audience:"source-only",
  bindings:[{workspaceId:"operator-workspace",networkId:"network",principals:["not-an-identity-selector"]}],
 };
 client = new Client(ctx.app); await client.signup("owner@example.test");
 const user = await ctx.db.select().from(users).where(eq(users.email,"owner@example.test")).get();
 userId = user!.id;
 await ctx.db.update(users).set({emailVerified:true,name:"Owner"}).where(eq(users.id,userId));
 const member = await ctx.db.select().from(members).where(eq(members.userId,userId)).get();
 workspaceId = member!.organizationId;
 deviceKey = await hash("original native key");
 const verifier = "v".repeat(64);
 const request = {workspaceId,deviceKey,challenge:await hash(verifier),state:await hash("state"),platform:"linux",redirectUri:"http://127.0.0.1:32145/mnet/callback"};
 const pending = await client.post("/api/mnet/authorizations",request); expect(pending.status).toBe(201);
 const approved = await client.post(`/api/mnet/authorizations/${pending.body.id}/decision`,{decision:"allow"}); expect(approved.status).toBe(200);
 const exchange = await ctx.app.request("/api/mnet/token",{method:"POST",headers:{host:"localhost","content-type":"application/json"},body:JSON.stringify({...request,code:approved.body.code,verifier})});
 expect(exchange.status).toBe(200); token = (await exchange.json()).credential;
});
describe("source-only own-account summary", () => {
 it("returns only the bearer owner's current labels and credential-row key without creating authority", async () => {
  const before = await ctx.db.select().from(mnetDevices);
  const response = await summary(); expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("set-cookie")).toBeNull();
  const data = await response.json();
  expect(data).toMatchObject({version:1,purpose:"mnet-own-account-identity",audience:"mnet",principalId:userId,principalNamespace:"multies-local-user-v1",principalAuthority:"https://identity.example.invalid",workspaceId,workspaceName:"Acme",email:"owner@example.test",accountName:"Owner",deviceKey,verifiedEmail:true,capabilities:["list"],enrollmentAuthorized:false,networkAuthorized:false,inputAuthorized:false});
  expect(mnetOwnAccountSummarySchema.safeParse(data).success).toBe(true);
  expect(data.expiresAtMS-data.checkedAtMS).toBeGreaterThan(0); expect(data.expiresAtMS-data.checkedAtMS).toBeLessThanOrEqual(30_000);
  expect(Object.keys(data)).toHaveLength(18); expect(JSON.stringify(data)).not.toContain(token);
  expect(await ctx.db.select().from(mnetDevices)).toEqual(before);
  await ctx.db.update(users).set({name:"Current owner"}).where(eq(users.id,userId));
  expect(await (await summary()).json()).toMatchObject({accountName:"Current owner"});
 });
 it("projects the credential-row key, never an earlier request-body key, and clamps source expiry", async () => {
  const replacement = await hash("source row replacement key");
  await ctx.db.update(mnetDevices).set({deviceKey:replacement});
  const current = await (await summary()).json(); expect(current.deviceKey).toBe(replacement); expect(current.deviceKey).not.toBe(deviceKey);
  const deadline = new Date(ctx.deps.now().getTime()+5_000);
  await ctx.db.update(mnetDevices).set({credentialExpiresAt:deadline});
  expect((await (await summary()).json()).expiresAtMS).toBeLessThanOrEqual(deadline.getTime());
  await ctx.db.update(mnetDevices).set({status:"revoked"}); expect((await summary()).status).toBe(403);
 });
 it("refuses identity, workspace, device and capability selectors, duplicate/aliased keys and nonempty bodies", async () => {
  for (const body of ['{"userId":"other"}','{"workspaceId":"other"}','{"deviceKey":"caller-key"}','{"capability":"enroll"}','{"x":1,"x":2}','{"x":1,"\\u0078":2}','[]','null','{} {}','"text"']) expect((await summary(body)).status).toBe(400);
  for (const query of ["?userId=other","?workspaceId=other","?deviceKey=other"]) expect((await summary("{}",{},query)).status).toBe(403);
  const deniedHeaders: Record<string,string>[] = [{cookie:client.cookie},{cookie:""},{origin:"http://localhost"},{origin:""},{authorization:token},{authorization:`bearer ${token}`},{authorization:`Bearer ${token} extra`}];
  for (const headers of deniedHeaders) expect((await summary("{}",headers)).status).toBe(403);
 });
 it("keeps required false/empty field presence and the exact response grammar", async () => {
  const data = await (await summary()).json();
  for (const key of Object.keys(data)) {const changed={...data};delete changed[key];expect(mnetOwnAccountSummarySchema.safeParse(changed).success,key).toBe(false);}
  for (const patch of [{networkAuthorized:null},{networkAuthorized:true},{enrollmentAuthorized:true},{inputAuthorized:true},{accountName:null},{version:2},{principalNamespace:"oidc"},{capabilities:["list","enroll"]},{extra:false}]) expect(mnetOwnAccountSummarySchema.safeParse({...data,...patch}).success).toBe(false);
  expect(mnetOwnAccountSummarySchema.safeParse({...data,accountName:""}).success).toBe(true);
  for (const boundary of labelBoundaries) expect(mnetOwnAccountSummarySchema.safeParse({...data,workspaceName:boundary.value}).success,boundary.name).toBe(boundary.allowed);
 });
 it("refuses unsafe labels and freshly ineligible or expired owners", async () => {
  for (const name of ["Owner\x1b[0m","Owner\u202e"," Owner","x".repeat(257),"\ud800"]) {
   await ctx.db.update(users).set({name}).where(eq(users.id,userId)); expect((await summary()).status).toBe(403);
  }
  await ctx.db.update(users).set({name:"Owner",emailVerified:false}).where(eq(users.id,userId)); expect((await summary()).status).toBe(403);
  await ctx.db.update(users).set({emailVerified:true}).where(eq(users.id,userId));
  await ctx.db.update(members).set({disabledAt:new Date()}).where(eq(members.organizationId,workspaceId)); expect((await summary()).status).toBe(403);
  await ctx.db.update(members).set({disabledAt:null}).where(eq(members.organizationId,workspaceId));
  await ctx.db.update(organizations).set({suspendedAt:new Date()}).where(eq(organizations.id,workspaceId)); expect((await summary()).status).toBe(403);
  await ctx.db.update(organizations).set({suspendedAt:null}).where(eq(organizations.id,workspaceId));
  await ctx.db.update(sessions).set({expiresAt:new Date(0)}); expect((await summary()).status).toBe(403);
 });
 it("stays unavailable without provenance or outside development while old List remains unchanged", async () => {
  delete ctx.deps.config.mnetEnrollmentOperator!.provenance; expect((await summary()).status).toBe(404);
  const old = await ctx.app.request("/api/mnet/check",{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization:`Bearer ${token}`},body:JSON.stringify({workspaceId,capability:"list"})});
  expect(old.status).toBe(200); expect(await old.json()).toMatchObject({deviceKey:"",allowed:["list"]});
  ctx.deps.config.mode="production"; expect((await summary()).status).toBe(404);
 });
});

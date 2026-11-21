import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { users, members, sessions, organizations, mnetEnrollmentDecisions, mnetEnrollmentHandoffs as journal } from "@/server/db/schema";
import { loadConfig } from "@/server/config";
import { sweepHandoffs } from "@/server/services/mnet-enrollment-handoff";
import { openSqlite } from "@/server/db/node";
import { migrate } from "@/server/db";
import { createApp } from "@/server/app";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "@/server/services/mnet";

const token = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const policy = { consentMs: 600000, codeMs: 60000, ticketMs: 120000, fullRowRetentionMs: 86400000, capacity: 10, maxRows: 100, retention: "terminal-hash-tombstone" };
const base = { version: 1, purpose: "mnet-enrollment", attemptId: token(1), devicePublicKey: token(2), credentialDigest: token(3), state: token(4), platform: "linux", redirectUri: "http://127.0.0.1:34567/mnet/enrollment/callback" };
export async function setupHandoff(file?: string) {
 const e = await makeTestApp({ MNET_ENROLLMENT_HANDOFF: "on", MNET_ENROLLMENT_HANDOFF_FIXTURE: JSON.stringify(policy) });
 if (file) { e.db = openSqlite(file); await migrate(e.db); e.deps.db = e.db; e.app = createApp(e.deps); }
 const person = new Client(e.app); await person.signup();
 const user = await e.db.select().from(users).where(eq(users.email, person.email!)).get();
 await e.db.update(users).set({ emailVerified: true }).where(eq(users.id, user!.id));
 const member = await e.db.select().from(members).where(eq(members.userId, user!.id)).get();
 const operator = { revision: "fixture-r1", issuer: "https://issuer.test/path", registrarOrigin: "https://registrar.test", audience: "fixture-enrollment", bindings: [{ workspaceId: member!.organizationId, networkId: "net-fixture", principals: [user!.id] }] };
 e.deps.config.mnetEnrollmentOperator = operator;
 const verifier = "v".repeat(43), launch = { ...base, challenge: await hash(verifier) };
 const displayed = { issuer: operator.issuer, registrarOrigin: operator.registrarOrigin, audience: operator.audience, mappingRevision: operator.revision, networkId: "net-fixture" };
 const request = { ...launch, workspaceId: member!.organizationId, displayed };
 return { ...e, person, user: user!, launch, verifier, request, policy };
}
const path = "/api/mnet-enrollment-v1";
async function approved(e: Awaited<ReturnType<typeof setupHandoff>>) {
 const p = await e.person.post(path + "/authorizations", e.request); expect(p.status).toBe(201);
 const d = await e.person.post(path + `/authorizations/${p.body.id}/decision`, { decision: "allow" }); expect(d.status).toBe(200);
 return { id: p.body.id as string, proof: { ...e.request, code: new URL(d.body.redirectTo).searchParams.get("code")!, verifier: e.verifier } };
}
const native = (e: Awaited<ReturnType<typeof setupHandoff>>, proof: unknown, extra: Record<string,string> = {}) => e.app.request(path + "/exchange", { method: "POST", headers: { host: "localhost", "content-type": "application/json", ...extra }, body: JSON.stringify(proof) });
describe("isolated enrollment journal and one-shot PKCE, no registrar", () => {
 it("is separately off by default", async () => {
  const e = await makeTestApp({ MNET_ENROLLMENT_CONSENT: "on" });
  expect((await e.app.request(path + "/authorize")).status).toBe(404);
 });
 it("issues one handoff ticket for the exact approved native tuple, never a node credential", async () => {
  const e = await setupHandoff();
  const p = await e.person.post(path + "/authorizations", e.request); expect(p.status).toBe(201);
  const d = await e.person.post(path + `/authorizations/${p.body.id}/decision`, { decision: "allow" }); expect(d.status).toBe(200);
  const callback = new URL(d.body.redirectTo); const code = callback.searchParams.get("code"); expect(code).toBeTruthy();
  const exchange = { ...e.request, code, verifier: e.verifier };
  const result = await e.app.request(path + "/exchange", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(exchange) });
  expect(result.status).toBe(200); const body = await result.json();
  expect(body).toMatchObject({ purpose: "mnet-enrollment", registrarConnected: false, enrolled: false, inputAuthorized: false });
  expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(body.credential).toBeUndefined(); expect(body.node).toBeUndefined();
  expect((await e.app.request(path + "/exchange", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(exchange) })).status).toBe(403);
 });
});

it("requires explicit bounded fixture policy and refuses production enabling", () => {
 const env = { APP_SECRET: "t".repeat(40), MNET_ENROLLMENT_HANDOFF: "on" };
 expect(() => loadConfig(env)).toThrow();
 expect(() => loadConfig({ ...env, APP_MODE: "production", MNET_ENROLLMENT_HANDOFF_FIXTURE: JSON.stringify(policy) })).toThrow();
 for (const p of [{...policy, codeMs: 60001}, {...policy, retention: "delete-all"}, {...policy, capacity: 101}, {...policy, extra: true}, {...policy, consentMs: 1000, codeMs: 2000}]) expect(() => loadConfig({...env, MNET_ENROLLMENT_HANDOFF_FIXTURE: JSON.stringify(p)})).toThrow();
 expect(loadConfig({...env, MNET_ENROLLMENT_HANDOFF: "off", MNET_ENROLLMENT_HANDOFF_FIXTURE: "bad"}).mnetEnrollmentHandoffFixture).toBeUndefined();
});
it("checks strict launch, fixed callback and exact displayed mapping before writes", async () => {
 const e = await setupHandoff(), qs = new URLSearchParams(Object.entries(e.launch).map(([k,v])=>[k,String(v)]));
 expect((await e.person.get(path + "/authorize?" + qs)).status).toBe(200);
 expect((await e.person.get(path + "/authorize?" + qs + "&version=1")).status).toBe(400);
 for (const request of [{...e.request, purpose: "list"}, {...e.request, extra: "ignored"}, {...e.request, redirectUri: "http://localhost:34567/mnet/enrollment/callback"}, {...e.request, credentialDigest: "bad"}, {...e.request, displayed: {...e.request.displayed, networkId: "other"}}]) expect((await e.person.post(path + "/authorizations", request)).status).not.toBe(201);
 e.deps.config.mnetEnrollmentOperator!.bindings[0]!.networkId = "changed";
 expect((await e.person.post(path + "/authorizations", e.request)).status).toBe(403);
 expect(await e.db.select().from(journal)).toHaveLength(0);
});
it("rejects wrong PKCE, tuple, browser cookies and ambient auth without spending the owner's code", async () => {
 const e = await setupHandoff(), { proof } = await approved(e);
 for (const changed of [{...proof, verifier: "w".repeat(43)}, {...proof, credentialDigest: token(8)}, {...proof, attemptId: token(8)}, {...proof, state: token(8)}, {...proof, devicePublicKey: token(8)}, {...proof, redirectUri: "http://127.0.0.1:34568/mnet/enrollment/callback"}, {...proof, displayed: {...proof.displayed, audience: "other"}}, {...proof, workspaceId: "other"}, {...proof, version: 2}]) expect((await native(e, changed)).status).not.toBe(200);
 for (const extra of [{cookie: e.person.cookie}, {origin: "http://localhost"}, {authorization: "Bearer " + token(8)}]) expect((await native(e, proof, extra)).status).toBe(403);
 expect((await e.db.select().from(journal).get())?.status).toBe("approved");
 expect((await native(e, proof)).status).toBe(200);
});
it.each(["mapping", "principal", "membership", "session", "user", "workspace"])("persists history but refuses exchange after %s removal/change", async (mode) => {
 const e = await setupHandoff(), { proof } = await approved(e);
 if (mode === "mapping") e.deps.config.mnetEnrollmentOperator!.revision = "r2";
 if (mode === "principal") e.deps.config.mnetEnrollmentOperator!.bindings[0]!.principals = ["other"];
 if (mode === "membership") await e.db.update(members).set({disabledAt: new Date()}).where(eq(members.userId,e.user.id));
 if (mode === "session") await e.db.delete(sessions).where(eq(sessions.userId,e.user.id));
 if (mode === "user") await e.db.delete(users).where(eq(users.id,e.user.id));
 if (mode === "workspace") await e.db.delete(organizations).where(eq(organizations.id,e.request.workspaceId));
 expect(await e.db.select().from(journal)).toHaveLength(1);
 expect((await native(e,proof)).status).not.toBe(200);
 const row = await e.db.select().from(journal).get(); expect(row!.status).toBe("withdrawn"); expect(row!.ticketHash).toBeNull();
});
it("has one winner for duplicate prepare and concurrent one-shot exchange, with only hashes stored", async () => {
 const e = await setupHandoff();
 const p = await Promise.all(Array.from({length:4},()=>e.person.post(path + "/authorizations", e.request)));
 expect(p.map(r=>r.status).sort()).toEqual([201,403,403,403]);
 const id = p.find(r=>r.status===201)!.body.id;
 const choices = await Promise.all([e.person.post(path + `/authorizations/${id}/decision`,{decision:"allow"}),e.person.post(path + `/authorizations/${id}/decision`,{decision:"allow"})]);
 expect(choices.map(r=>r.status).sort()).toEqual([200,403]);
 const code = new URL(choices.find(r=>r.status===200)!.body.redirectTo).searchParams.get("code")!;
 const proof = {...e.request,code,verifier:e.verifier};
 const results = await Promise.all(Array.from({length:4},()=>native(e,proof)));
 expect(results.map(r=>r.status).sort()).toEqual([200,403,403,403]);
 const body = await results.find(r=>r.status===200)!.json(), row = await e.db.select().from(journal).get();
 expect(row!.codeHash).toBeNull(); expect(row!.ticketHash).toBe(await hash(body.ticket));
 const serialized = JSON.stringify(row); for (const secret of [code,body.ticket,e.verifier]) expect(serialized).not.toContain(secret);
 // A response already lost cannot be recreated, and old consent cannot issue again.
 expect((await native(e,proof)).status).toBe(403);
 expect((await e.person.post(path + `/authorizations/${id}/decision`,{decision:"allow"})).status).toBe(403);
});
it("expires exact deadlines then strips private tuples, retaining a non-reusable bounded tombstone", async () => {
 const e = await setupHandoff(), start = Date.now(); e.deps.now = ()=>new Date(start);
 const {proof} = await approved(e);
 e.deps.now = ()=>new Date(start + policy.codeMs);
 expect((await native(e,proof)).status).toBe(403);
 let row = await e.db.select().from(journal).get(); expect(row!.status).toBe("expired"); expect(row!.codeHash).toBeNull();
 e.deps.now = ()=>new Date(start + policy.codeMs + policy.fullRowRetentionMs);
 await sweepHandoffs(e.deps); row = await e.db.select().from(journal).get();
 expect(row).toMatchObject({status:"expired",userId:null,sessionId:null,workspaceId:null,attemptId:null,devicePublicKey:null,credentialDigest:null,issuer:null,challenge:null,state:null,ticketHash:null});
 expect(row!.attemptHash).toBe(await hash(e.launch.attemptId)); expect(row!.scrubbedAt).not.toBeNull();
 // Use a still-live session time for the tombstone attempt check; the tombstone
 // survives clock rollback and cannot recreate an old authorization.
 e.deps.now = ()=>new Date(start);
 expect((await e.person.post(path + "/authorizations",e.request)).status).toBe(403);
 expect(await e.db.select().from(journal)).toHaveLength(1);
});
it("does not upgrade preview rows or expose reserve/status/ack consumers", async () => {
 const e = await setupHandoff();
 e.deps.config.mnetEnrollmentConsent = true;
 const previewRequest = { attemptId: e.launch.attemptId, devicePublicKey: e.launch.devicePublicKey, platform: e.launch.platform, workspaceId: e.request.workspaceId, displayed: e.request.displayed };
 const preview = await e.person.post("/api/mnet-enrollment/decisions", previewRequest); expect(preview.status).toBe(201);
 const consent = await e.person.post(`/api/mnet-enrollment/decisions/${preview.body.id}`, { decision: "allow" }); expect(consent.status).toBe(200); expect(consent.body.code).toBeUndefined();
 expect((await e.person.post(path + `/authorizations/${preview.body.id}/decision`, { decision: "allow" })).status).toBe(403);
 expect((await native(e, { ...e.request, code: token(8), verifier: e.verifier })).status).toBe(403);
 expect(await e.db.select().from(journal)).toHaveLength(0); expect((await e.db.select().from(mnetEnrollmentDecisions).get())!.status).toBe("approved");
 for (const endpoint of ["/service/reserve","/service/status","/service/ack","/consume","/recover"]) expect((await e.person.post(path+endpoint,{})).status).toBe(404);
 expect((await e.person.post("/api/mnet-enrollment/decisions",e.request)).status).toBe(400);
 e.deps.config.mode = "production";
 expect((await e.person.post(path + "/authorizations",e.request)).status).toBe(404);
});

it.each(["issued-response-loss", "current-config-change"])("survives actual SQLite close/reopen and server reconstruction: %s", async (mode) => {
 const directory = await mkdtemp(join(tmpdir(),"mnet-journal-restart-")), file = join(directory,"fixture.db");
 const e = await setupHandoff(file);
 const close = () => (e.db as unknown as {$client:{close():void}}).$client.close();
 try {
  const {proof,id} = await approved(e);
  if(mode === "issued-response-loss") expect((await native(e,proof)).status).toBe(200);
  close();
  e.db = openSqlite(file); e.deps.db = e.db;
  // This reopens the real same database and constructs new route handlers.
  // It is process-restart semantics, not a kill/power-loss durability test.
  if(mode === "current-config-change") e.deps.config.mnetEnrollmentOperator = {...e.deps.config.mnetEnrollmentOperator!,revision:"fixture-restarted-r2"};
  e.app = createApp(e.deps);
  expect((await native(e,proof)).status).toBe(403);
  const row = await e.db.select().from(journal).where(eq(journal.id,id)).get();
  expect(row!.status).toBe(mode === "issued-response-loss" ? "issued" : "withdrawn");
  expect(row!.codeHash).toBeNull();
  if(mode === "issued-response-loss") expect(row!.ticketHash).not.toBeNull();
  else {
   e.deps.config.mnetEnrollmentOperator!.revision = "fixture-r1";
   expect((await native(e,proof)).status).toBe(403);
  }
 } finally { close(); await rm(directory,{recursive:true,force:true}); }
});

it("does not let a second session approve and does not clear live issued tickets at privacy cleanup", async () => {
 const e=await setupHandoff();
 const p=await e.person.post(path+"/authorizations",e.request);expect(p.status).toBe(201);
 const other=new Client(e.app);expect((await other.login(e.person.email!)).status).toBe(200);
 expect((await other.post(path+`/authorizations/${p.body.id}/decision`,{decision:"allow"})).status).toBe(403);
 const result=await e.person.post(path+`/authorizations/${p.body.id}/decision`,{decision:"allow"});expect(result.status).toBe(200);
 const code=new URL(result.body.redirectTo).searchParams.get("code")!;
 expect((await native(e,{...e.request,code,verifier:e.verifier})).status).toBe(200);
 e.deps.config.mnetEnrollmentHandoffFixture!.fullRowRetentionMs=1000;
 const later=Date.now()+2000;e.deps.now=()=>new Date(later);
 await sweepHandoffs(e.deps);
 expect(await e.db.select().from(journal).get()).toMatchObject({status:"issued",scrubbedAt:null,credentialDigest:e.launch.credentialDigest});
});

it("refuses bounded capacity and does not erase ticket authority until its exact expiry", async()=>{
 const e=await setupHandoff(),start=Date.now();e.deps.now=()=>new Date(start);
 e.deps.config.mnetEnrollmentHandoffFixture!.capacity=1;e.deps.config.mnetEnrollmentHandoffFixture!.maxRows=1;
 const {proof}=await approved(e);expect((await native(e,proof)).status).toBe(200);
 expect((await e.person.post(path+"/authorizations",{...e.request,attemptId:token(20)})).status).toBe(403);
 e.deps.now=()=>new Date(start+policy.ticketMs-1);await sweepHandoffs(e.deps);expect((await e.db.select().from(journal).get())!.status).toBe("issued");
 e.deps.now=()=>new Date(start+policy.ticketMs);await sweepHandoffs(e.deps);const row=await e.db.select().from(journal).get();expect(row).toMatchObject({status:"expired",codeHash:null,ticketHash:null});
 // Tombstones count against the explicitly bounded total until policy changes;
 // expiry is never an excuse to delete a prior attempt and recreate authority.
 expect((await e.person.post(path+"/authorizations",{...e.request,attemptId:token(21)})).status).toBe(403);
});

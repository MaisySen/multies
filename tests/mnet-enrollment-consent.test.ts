import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { users, mnetEnrollmentDecisions, organizations, members, sessions } from "@/server/db/schema";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(9))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const launch = { attemptId: key, devicePublicKey: key, platform: "linux" };
async function setup() {
 const env = await makeTestApp({ MNET_ENROLLMENT_CONSENT: "on" });
 const person = new Client(env.app); await person.signup();
 const user = await env.db.select().from(users).where(eq(users.email, person.email!)).get();
 await env.db.update(users).set({ emailVerified: true }).where(eq(users.id, user!.id));
 const member = await env.db.select().from(members).where(eq(members.userId, user!.id)).get();
 env.deps.config.mnetEnrollmentOperator = { revision: "fixture-r1", issuer: "https://issuer.example.test/path", registrarOrigin: "https://registrar.example.test", audience: "fixture-enrollment", bindings: [{ workspaceId: member!.organizationId, networkId: "net-fixture", principals: [user!.id] }] };
 expect((await import("@/server/services/mnet-enrollment-config")).enrollmentOperatorSchema.safeParse(env.deps.config.mnetEnrollmentOperator)).toMatchObject({success:true});
 return { ...env, person, user: user!, workspaceId: member!.organizationId };
}
describe("separate Mnet enrollment consent, no registrar authority", () => {
 it("is off by default and also unavailable without explicit operator config", async () => {
  const env = await makeTestApp(); expect((await env.app.request("/api/mnet-enrollment/authorize")).status).toBe(404);
  env.deps.config.mnetEnrollmentConsent = true; expect((await env.app.request("/api/mnet-enrollment/authorize")).status).toBe(404);
 });
 it("records one exact session-bound decision but emits no enrollment credential", async () => {
  const e = await setup();
  const info = await e.person.get("/api/mnet-enrollment/authorize?" + new URLSearchParams(launch));
  expect(info).toMatchObject({status:200}); expect(info.body.workspaces).toEqual([{ id: e.workspaceId, name: "Acme", networkId: "net-fixture" }]);
  const prepared = await e.person.post("/api/mnet-enrollment/decisions", { ...launch, workspaceId: e.workspaceId }); expect(prepared.status).toBe(201);
  const result = await e.person.post(`/api/mnet-enrollment/decisions/${prepared.body.id}`, { decision: "allow" });
  expect(result.status).toBe(200); expect(result.body).toEqual({ decision: "approved", purpose: "mnet-enrollment", inputAuthorized: false, registrarConnected: false, enrolled: false });
  expect((await e.person.post(`/api/mnet-enrollment/decisions/${prepared.body.id}`, { decision: "allow" })).status).toBe(403);
  expect((await e.person.post("/api/mnet-enrollment/decisions", { ...launch, workspaceId: e.workspaceId })).status).toBe(403);
  const row = await e.db.select().from(mnetEnrollmentDecisions).get(); expect(row!.networkId).toBe("net-fixture"); expect(row!.mappingRevision).toBe("fixture-r1"); expect(row!.status).toBe("approved");
  for (const path of ["/api/mnet-enrollment/token", "/api/mnet-enrollment/consume", "/api/mnet-enrollment/recover"]) expect((await e.person.post(path, {})).status).toBe(404);
 });
 it.each(["mapping", "membership", "session", "expiry", "other-person"])("refuses decision after %s change", async (mode) => {
  const e = await setup(); const p = await e.person.post("/api/mnet-enrollment/decisions", { ...launch, workspaceId: e.workspaceId }); expect(p.status).toBe(201);
  if (mode === "mapping") e.deps.config.mnetEnrollmentOperator!.revision = "changed";
  if (mode === "membership") await e.db.update(members).set({ disabledAt: new Date() }).where(eq(members.userId, e.user.id));
  if (mode === "session") await e.db.update(sessions).set({ expiresAt: new Date(0) }).where(eq(sessions.userId, e.user.id));
  if (mode === "expiry") await e.db.update(mnetEnrollmentDecisions).set({ expiresAt: new Date(0) });
  let client = e.person;
  if (mode === "other-person") { client = new Client(e.app); await client.signup(); }
  expect((await client.post(`/api/mnet-enrollment/decisions/${p.body.id}`, { decision: "allow" })).status).not.toBe(200);
  const row = await e.db.select().from(mnetEnrollmentDecisions).get(); if (mode === "session") expect(row).toBeUndefined(); else expect(row!.status).toBe("pending");
 });
 it("rejects non-allowlisted people and ambiguous request JSON before writes", async () => {
  const e = await setup(); const raw = JSON.stringify({ ...launch, workspaceId: e.workspaceId }).replace('"platform":"linux"', '"platform":"linux","platform":"windows"');
  const r = await e.app.request("/api/mnet-enrollment/decisions", { method: "POST", headers: { cookie: e.person.cookie, host: "localhost", "content-type": "application/json" }, body: raw }); expect(r.status).toBe(400);
  e.deps.config.mnetEnrollmentOperator!.bindings[0]!.principals = ["not-this-person"];
  expect((await e.person.post("/api/mnet-enrollment/decisions", { ...launch, workspaceId: e.workspaceId })).status).toBe(403);
  expect(await e.db.select().from(mnetEnrollmentDecisions)).toHaveLength(0);
  expect(await e.db.select().from(organizations)).toHaveLength(1);
 });
 it("has one winner for competing decisions and never upgrades a List credential", async () => {
  const e = await setup(); const p = await e.person.post("/api/mnet-enrollment/decisions", { ...launch, workspaceId: e.workspaceId });
  expect(p.status).toBe(201);
  const results = await Promise.all([e.person.post(`/api/mnet-enrollment/decisions/${p.body.id}`, { decision: "allow" }), e.person.post(`/api/mnet-enrollment/decisions/${p.body.id}`, { decision: "decline" })]);
  expect(results.map((r) => r.status).sort()).toEqual([200,403]);
  const token = await e.app.request("/api/mnet-enrollment/decisions", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json", host:"localhost" }, body: JSON.stringify({ ...launch, attemptId: key.slice(0,-1)+"A", workspaceId: e.workspaceId }) });
  expect(token.status).toBe(401);
 });
 it("binds a decision to the original session even for the same person", async () => {
  const e = await setup(); const p = await e.person.post("/api/mnet-enrollment/decisions", { ...launch, workspaceId: e.workspaceId });
  expect(p.status).toBe(201);
  const second = new Client(e.app); expect((await second.login(e.person.email!)).status).toBe(200);
  expect((await second.post(`/api/mnet-enrollment/decisions/${p.body.id}`, { decision:"allow" })).status).toBe(403);
  expect((await e.person.post(`/api/mnet-enrollment/decisions/${p.body.id}`, { decision:"decline" })).status).toBe(200);
 });

});

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { organizations } from "@/server/db/schema";

// AIS1 (audit of 11 Nov 2026, row 51): every new agent starts safe, however it is made: 100 sends a day and only the
// workspace's own verified domains as recipients, unless a person in the app chooses otherwise.

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let wsKey: string;
let domainId: string;
let orgId: string;

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function verify(client: Client, id: string) {
  const { body } = await client.get(`/api/domains/${id}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await client.post(`/api/domains/${id}/verify`)).body.domain.status).toBe("verified");
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  orgId = (await c.get("/api/account/me")).body.organization.id;
  domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  await verify(c, domainId);
  wsKey = (await c.post("/api/developer/keys", { name: "Agents" })).body.secret;
});

describe("AIS1 row 51: safe defaults for every new agent", () => {
  it("100 sends a day by default, never the plan ceiling, however the agent is made", async () => {
    await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId));
    expect((await api(wsKey, "POST", "/agents", { name: "Key made" })).body.agent.sendCapDaily).toBe(100);
    expect((await c.post("/api/agents", { name: "App made" })).body.agent.sendCapDaily).toBe(100);
    // A person may ask for more, up to the plan's limit.
    expect((await c.post("/api/agents", { name: "Busy", sendCapDaily: 500 })).body.agent.sendCapDaily).toBe(500);
    expect((await c.post("/api/agents", { name: "Too busy", sendCapDaily: 5000 })).body.agent.sendCapDaily).toBe(2000);
    expect((await api(wsKey, "POST", "/agents", { name: "Quiet", sendCapDaily: 30 })).body.agent.sendCapDaily).toBe(30);
  });

  it("the default allow list is the workspace's own verified domains", async () => {
    await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId)); // room for more domains
    const other = (await c.post("/api/domains", { name: "acme.com.au" })).body.domain;
    await verify(c, other.id);
    await c.post("/api/domains", { name: "notyet.io" }); // not verified, so not on the list
    const byKey = (await api(wsKey, "POST", "/agents", { name: "Key made" })).body.agent;
    expect([...byKey.allowedRecipients].sort()).toEqual(["@acme.com.au", "@acme.io"]);
    expect([...(await c.post("/api/agents", { name: "App made" })).body.agent.allowedRecipients].sort()).toEqual(["@acme.com.au", "@acme.io"]);
    // A key asking for "anyone" (null or an empty list) gets the default list too.
    for (const allowedRecipients of [null, []]) {
      expect([...(await api(wsKey, "POST", "/agents", { name: `Key ${JSON.stringify(allowedRecipients)}`, allowedRecipients })).body.agent.allowedRecipients].sort()).toEqual(["@acme.com.au", "@acme.io"]);
    }
    // A person may choose "anyone".
    for (const allowedRecipients of [null, []]) expect((await c.post("/api/agents", { name: `App ${JSON.stringify(allowedRecipients)}`, allowedRecipients })).body.agent.allowedRecipients).toBeNull();
    // A key may name its own list; approval stays with a person.
    expect((await api(wsKey, "POST", "/agents", { name: "Named", allowedRecipients: ["Grace@Example.com"] })).body.agent.allowedRecipients).toEqual(["grace@example.com"]);
    // A default agent can't even ask to mail an outside address.
    const { agent, apiKey } = (await api(wsKey, "POST", "/agents", { name: "Fenced" })).body;
    const r = await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["grace@example.com"], subject: "Hi", text: "x" });
    expect(r.body.error.code).toBe("recipient_not_allowed");
    expect((await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["owner@acme.io"], subject: "Hi", text: "x" })).status).toBe(202);
  });

  it("with no verified domain yet, the default list is the creator's own address", async () => {
    const d = new Client(ctx.app);
    await d.signup("solo@bakery.example");
    await d.post("/api/domains", { name: "bakery.example" }); // added, not verified
    const key = (await d.post("/api/developer/keys", { name: "Agents" })).body.secret;
    expect((await api(key, "POST", "/agents", { name: "Baker" })).body.agent.allowedRecipients).toEqual(["solo@bakery.example"]);
    expect((await d.post("/api/agents", { name: "Baker two" })).body.agent.allowedRecipients).toEqual(["solo@bakery.example"]);
  });
});

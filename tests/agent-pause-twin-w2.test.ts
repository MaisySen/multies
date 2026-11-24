import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { members, users } from "@/server/db/schema";

/**
 * Round 2 (PR 23 leftover): pausing an agent left its member twin (an AI agent member linked to the agent's inbox)
 * working: its key kept acting for the paused agent. Pausing the agent now pauses the twin too; resuming the agent
 * doesn't resume it (a person does that in Team). A paused member's session is refused as its keys are.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});
async function v1(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status };
}

describe("Round 2: pausing an agent pauses its member twin", () => {
  it("the linked agent member's key stops; resuming the agent leaves the member paused until a person resumes it", async () => {
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id as string;
    const { body } = await c.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await c.post(`/api/domains/${domainId}/verify`);
    const agent = (await c.post("/api/agents", { name: "Scout", localPart: "scout" })).body.agent;
    const made = (await c.post("/api/team/agents", { name: "Scout", inboxAgentId: agent.id })).body;
    const id = made.member.userId as string;
    expect((await v1(made.secret, "GET", "/people")).status).toBe(200);
    expect((await c.patch(`/api/agents/${agent.id}`, { status: "paused" })).status).toBe(200);
    expect((await v1(made.secret, "GET", "/people")).status).toBe(401);
    expect((await c.get("/api/team/agents")).body.agents.find((a: { userId: string }) => a.userId === id)).toMatchObject({ disabled: true });
    // Resuming the agent doesn't cascade.
    expect((await c.patch(`/api/agents/${agent.id}`, { status: "active" })).status).toBe(200);
    expect((await v1(made.secret, "GET", "/people")).status).toBe(401);
    expect((await c.patch(`/api/team/agents/${id}`, { disabled: false })).status).toBe(200);
    expect((await v1(made.secret, "GET", "/people")).status).toBe(200);
  });

  it("a paused member's session is refused", async () => {
    const inv = await c.post("/api/team/invites", { email: "max@acme.io", role: "member" });
    const m = new Client(ctx.app);
    await m.signup("max@acme.io", "Max", "Max Co");
    expect((await m.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    expect((await m.get("/api/tasks")).status).toBe(200);
    const uid = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, "max@acme.io")).get())!.id;
    await ctx.db.update(members).set({ disabledAt: new Date() }).where(eq(members.userId, uid));
    const { clearAuthCache } = await import("@/server/auth/guards");
    clearAuthCache();
    const r = await m.get("/api/tasks");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("member_paused");
  });

  it("Wave 2 review X11a: a human member at the agent's inbox address is not paused with the agent", async () => {
    await c.post("/api/domains", { name: "acme.io" });
    const agent = (await c.post("/api/agents", { name: "Scout", localPart: "scout" })).body.agent;
    const inv = await c.post("/api/team/invites", { email: "max@acme.io", role: "member" });
    const m = new Client(ctx.app);
    await m.signup("max@acme.io", "Max", "Max Co");
    expect((await m.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    // A person whose sign in address became the agent's inbox address (made before the AIS1 checks, or changed since).
    expect(agent.address).toBe("scout@acme.io");
    await ctx.db.update(users).set({ email: agent.address }).where(eq(users.email, "max@acme.io"));
    expect((await c.patch(`/api/agents/${agent.id}`, { status: "paused" })).status).toBe(200);
    const orgId = (await c.get("/api/account/me")).body.organization.id as string;
    const row = (await ctx.db.select({ disabledAt: members.disabledAt, kind: members.kind }).from(members).innerJoin(users, eq(users.id, members.userId)).where(and(eq(users.email, agent.address), eq(members.organizationId, orgId))).get())!;
    expect(row.kind).toBe("human");
    expect(row.disabledAt).toBeNull();
  });
});

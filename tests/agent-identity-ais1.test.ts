import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { aliases, auditLogs, domains, invitations, members, projectGuests, users } from "@/server/db/schema";
import { agentAddress } from "@/server/services/agents/agent-address";

/**
 * AIS1 (audit of 11 Nov 2026, row 1, Critical): an AI agent can't become a person. On the live workspace an API key
 * invited the address of an agent's own inbox, the agent read the invite and the confirmation link from its feed, and
 * the address became a normal member with a seat and mailbox access, outside its approval rule and send cap.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let wsKey: string;
let orgId: string;
let domainId: string;
let agentKey: string;
let agentId: string;
let inboxId: string;

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

async function verify(c: Client, id: string) {
  const { body } = await c.get(`/api/domains/${id}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${id}/verify`)).body.domain.status).toBe("verified");
}

const refusals = async (action: string, org = orgId) =>
  (await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, org), eq(auditLogs.action, action)))).map((r) => JSON.parse(r.metadata ?? "{}") as Record<string, unknown>);

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  orgId = (await owner.get("/api/account/me")).body.organization.id;
  domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
  await verify(owner, domainId);
  wsKey = (await owner.post("/api/developer/keys", { name: "Setup" })).body.secret;
  const made = await api(wsKey, "POST", "/agents", { name: "Agent", localPart: "agent" });
  expect(made.status).toBe(201);
  agentKey = made.body.apiKey.secret;
  agentId = made.body.agent.id;
  inboxId = made.body.agent.inboxId;
});

describe("AIS1 row 1: which addresses reach an agent", () => {
  it("finds an agent inbox, a +tag, an alias chain in another workspace and an agent catch-all, and nothing else", async () => {
    expect(await agentAddress(ctx.db, "agent@acme.io")).toMatchObject({ orgId, via: "agent_inbox" });
    expect(await agentAddress(ctx.db, "Agent+Signup@ACME.io")).toMatchObject({ via: "agent_inbox" });
    expect(await agentAddress(ctx.db, "owner@acme.io")).toBeNull();
    expect(await agentAddress(ctx.db, "someone@example.com")).toBeNull();
    // An alias in another workspace that forwards (through a second alias) to the agent.
    const other = new Client(ctx.app);
    await other.signup("boss@other.test", "Other Boss");
    const otherDomain = (await other.post("/api/domains", { name: "other.test" })).body.domain.id as string;
    await verify(other, otherDomain);
    const otherOrg = (await other.get("/api/account/me")).body.organization.id as string;
    await ctx.db.insert(aliases).values([
      { id: "als_a", orgId: otherOrg, domainId: otherDomain, localPart: "hello", address: "hello@other.test", destinations: JSON.stringify(["relay@other.test"]) },
      { id: "als_b", orgId: otherOrg, domainId: otherDomain, localPart: "relay", address: "relay@other.test", destinations: JSON.stringify(["agent@acme.io"]), enabled: false },
    ]);
    expect(await agentAddress(ctx.db, "hello@other.test")).toMatchObject({ orgId, via: "alias" });
    // A catch-all that is the agent's inbox catches every address with no mailbox of its own.
    await ctx.db.update(domains).set({ catchAllMailboxId: inboxId }).where(eq(domains.id, domainId));
    expect(await agentAddress(ctx.db, "nobody@acme.io")).toMatchObject({ via: "catch_all" });
    // The owner has no mailbox at acme.io, so mail to their address lands in the agent's catch-all too.
    expect(await agentAddress(ctx.db, "owner@acme.io")).toMatchObject({ via: "catch_all" });
    expect(await agentAddress(ctx.db, "agent@acme.io")).toMatchObject({ via: "agent_inbox" });
    // An agent member's internal address.
    const am = await api(wsKey, "POST", "/agent-members", { name: "Builder" });
    const amUser = (await ctx.db.select().from(members).where(and(eq(members.organizationId, orgId), eq(members.kind, "agent"))).get())!.userId;
    expect(am.status).toBe(201);
    const amEmail = (await ctx.db.select().from(users).where(eq(users.id, amUser)).get())!.email;
    expect(await agentAddress(ctx.db, amEmail)).toMatchObject({ orgId, via: "agent_member" });
  });
});

describe("AIS1 row 1: no invite to an agent inbox, on any path", () => {
  it("the app refuses a member invite to the agent's inbox and flags it in the audit log", async () => {
    const r = await owner.post("/api/team/invites", { email: "agent@acme.io", role: "member", mailboxIds: [] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("agent_address");
    expect(r.body.error.message).toBe("agent@acme.io is an AI agent's inbox. An agent can't join as a person. Add agents in Agents instead.");
    expect(await ctx.db.select().from(invitations)).toEqual([]);
    expect(await refusals("member.invite_refused")).toEqual([expect.objectContaining({ email: "agent@acme.io", reason: "agent_inbox" })]);
    expect(ctx.outbound.sent.filter((m) => m.to.includes("agent@acme.io"))).toEqual([]);
  });

  it("an API key can't invite the agent's inbox, a +tag of it, or an alias that reaches it", async () => {
    await ctx.db.insert(aliases).values({ id: "als_x", orgId, domainId, localPart: "ops", address: "ops@acme.io", destinations: JSON.stringify(["agent@acme.io"]) });
    for (const email of ["agent@acme.io", "agent+join@acme.io", "ops@acme.io"]) {
      const r = await api(wsKey, "POST", "/invites", { email });
      expect(r.status, email).toBe(422);
      expect(r.body.error.code).toBe("agent_address");
    }
    expect(await ctx.db.select().from(invitations)).toEqual([]);
    expect((await refusals("member.invite_refused")).map((m) => m.reason)).toEqual(["agent_inbox", "agent_inbox", "alias"]);
  });

  it("guests: a person, a workspace key and an agent can't invite the agent's inbox to a project", async () => {
    const project = (await owner.post("/api/projects", { name: "Launch" })).body.project;
    const byPerson = await owner.post("/api/guests", { projectId: project.id, email: "agent@acme.io" });
    expect(byPerson.status).toBe(422);
    expect(byPerson.body.error.code).toBe("agent_address");
    const byKey = await api(wsKey, "POST", `/projects/${project.id}/guests`, { email: "agent@acme.io" });
    expect(byKey.body.error.code).toBe("agent_address");
    const byAgent = await api(agentKey, "POST", `/projects/${project.id}/guests`, { email: "Agent@acme.io" });
    expect(byAgent.body.error.code).toBe("agent_address");
    expect(await ctx.db.select().from(projectGuests)).toEqual([]);
    expect(await refusals("guest.invite_refused")).toHaveLength(3);
  });
});

describe("AIS1 row 1: no account or membership for an agent's address", () => {
  it("sign-up with the agent's inbox address is refused and flagged in the agent's workspace", async () => {
    const stranger = new Client(ctx.app);
    const r = await stranger.post("/api/auth/sign-up/email", { name: "Agent", email: "agent@acme.io", password: "a-strong-password" });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain("AI agent's inbox");
    expect(await ctx.db.select().from(users).where(eq(users.email, "agent@acme.io")).get()).toBeUndefined();
    expect(await refusals("account.signup_refused")).toEqual([expect.objectContaining({ email: "agent@acme.io", reason: "agent_inbox" })]);
    // A +tag of it too.
    expect((await stranger.post("/api/auth/sign-up/email", { name: "Agent", email: "agent+x@acme.io", password: "a-strong-password" })).status).toBe(403);
  });

  it("an account that already has the agent's address can't accept an invite made before the fix", async () => {
    const legacy = new Client(ctx.app);
    await legacy.signup("legacy@elsewhere.test", "Agent", "");
    await ctx.db.update(users).set({ email: "agent@acme.io", emailVerified: true }).where(eq(users.email, "legacy@elsewhere.test"));
    const ownerId = (await owner.get("/api/account/me")).body.user.id as string;
    await ctx.db.insert(invitations).values({ id: "inv_legacy_agent_0000000000", organizationId: orgId, email: "agent@acme.io", role: "member", status: "pending", expiresAt: new Date(Date.now() + 86_400_000), inviterId: ownerId, mailboxIds: "[]" });
    legacy.autoVerify = false;
    const r = await legacy.post("/api/invites/inv_legacy_agent_0000000000/accept");
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("agent_address");
    expect(await ctx.db.select().from(members).where(and(eq(members.organizationId, orgId), eq(members.kind, "human")))).toHaveLength(1);
    expect(await refusals("member.join_refused")).toHaveLength(1);
  });
});

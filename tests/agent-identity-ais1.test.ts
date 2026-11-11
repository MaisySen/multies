import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { agents, aliases, auditLogs, authEmailHooks, domains, invitations, mailboxes, members, organizations, projectGuests, projects, sendApprovals, users } from "@/server/db/schema";
import { agentAddress } from "@/server/services/agents/agent-address";
import { listStaff } from "@/server/services/people-r126";
import { assignees } from "@/server/services/suite/tasks";
import { confirmInvite } from "@/server/services/team";
import { confirmGuest, newGuestLink } from "@/server/services/suite/guests";

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

  it("an agent inbox on a domain nobody proved blocks no one (anyone can add any domain name)", async () => {
    const squat = new Client(ctx.app);
    await squat.signup("boss@squat.test", "Squatter");
    const claimed = (await squat.post("/api/domains", { name: "victim.example" })).body.domain.id as string;
    const key = (await squat.post("/api/developer/keys", { name: "Setup" })).body.secret as string;
    const made = await api(key, "POST", "/agents", { name: "Ceo", localPart: "ceo", domainId: claimed });
    expect(made.status).toBe(201);
    expect(await agentAddress(ctx.db, "ceo@victim.example")).toBeNull();
    // The real person at that address can still be invited.
    expect((await owner.post("/api/team/invites", { email: "ceo@victim.example", role: "member", mailboxIds: [] })).status).toBe(201);
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

  it("an account with the agent's address and no workspace doesn't get a new one on sign in", async () => {
    const legacy = new Client(ctx.app);
    await legacy.signup("legacy@elsewhere.test", "Agent", "");
    const userId = (await ctx.db.select().from(users).where(eq(users.email, "legacy@elsewhere.test")).get())!.id;
    const own = (await ctx.db.select().from(members).where(eq(members.userId, userId)).get())!.organizationId;
    await ctx.db.delete(members).where(eq(members.userId, userId));
    await ctx.db.update(users).set({ email: "agent@acme.io", emailVerified: true }).where(eq(users.id, userId));
    legacy.autoVerify = false;
    const r = await legacy.patch("/api/org", { name: "Agent's own" });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain("AI agent's inbox");
    expect(await ctx.db.select().from(members).where(eq(members.userId, userId))).toHaveLength(0);
    expect((await ctx.db.select().from(organizations)).map((o) => o.id).sort()).toEqual([orgId, own].sort());
    expect(await refusals("member.join_refused")).toEqual([expect.objectContaining({ email: "agent@acme.io", via: "new_workspace" })]);
  });

  it("such a session is refused on every request but flagged in the audit log once a day, not once a request", async () => {
    // The state the runbook leaves: the owner removed the "Agent" member, and its session lives on.
    const legacy = new Client(ctx.app);
    await legacy.signup("legacy@elsewhere.test", "Agent", "");
    const userId = (await ctx.db.select().from(users).where(eq(users.email, "legacy@elsewhere.test")).get())!.id;
    await ctx.db.delete(members).where(eq(members.userId, userId));
    await ctx.db.update(users).set({ email: "agent@acme.io", emailVerified: true }).where(eq(users.id, userId));
    legacy.autoVerify = false;
    for (let i = 0; i < 5; i++) expect((await legacy.get("/api/account/me")).status).toBe(403);
    expect(await refusals("member.join_refused")).toHaveLength(1);
  });
});

describe("AIS1 row 1: an invite a key makes waits for a person", () => {
  it("is held with nothing emailed, its link doesn't work, and an owner confirms it in the app", async () => {
    const sentBefore = ctx.outbound.sent.length;
    const r = await api(wsKey, "POST", "/invites", { email: "sam@example.com", title: "Ops" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "awaiting_approval", emailed: false });
    expect(r.body.emailDetail).toContain("confirms this invite");
    expect(ctx.outbound.sent.slice(sentBefore).filter((m) => m.to.includes("sam@example.com"))).toEqual([]);
    // Listed for the owner as waiting; it holds its seat.
    const team = (await owner.get("/api/team")).body;
    expect(team.invites).toEqual([expect.objectContaining({ id: r.body.id, email: "sam@example.com", awaitingApproval: true })]);
    expect(team.seats.pendingInvites).toBe(1);
    expect((await api(wsKey, "GET", "/invites")).body.invites[0].awaitingApproval).toBe(true);
    // The link says so and can't be accepted.
    expect((await owner.get(`/api/invites/${r.body.id}`)).body.invite.state).toBe("awaiting_approval");
    const sam = new Client(ctx.app);
    await sam.signup("sam@example.com", "Sam", "");
    const early = await sam.post(`/api/invites/${r.body.id}/accept`);
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe("invite_awaiting_approval");
    // The key can't confirm its own invite, not even through the app's route.
    const byKey = await ctx.app.request(`/api/team/invites/${r.body.id}/confirm`, { method: "POST", headers: { host: "localhost", authorization: `Bearer ${wsKey}` } });
    expect([401, 403]).toContain(byKey.status);
    // The owner confirms: the email goes out from the inviter of record and the link works.
    const ok = await owner.post(`/api/team/invites/${r.body.id}/confirm`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: r.body.id, status: "pending" });
    const invites = ctx.outbound.sent.slice(sentBefore).filter((m) => m.to.includes("sam@example.com") && m.subject.includes("invited you"));
    expect(invites.map((m) => m.subject)).toEqual(["Olive Owner invited you to Acme on Multies"]);
    expect((await sam.post(`/api/invites/${r.body.id}/accept`)).status).toBe(200);
    const audits = (await ctx.db.select().from(auditLogs).where(eq(auditLogs.orgId, orgId))).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(["member.invited", "member.invite_confirmed", "member.joined"]));
    // Confirming twice finds nothing to confirm.
    expect((await owner.post(`/api/team/invites/${r.body.id}/confirm`)).status).toBe(404);
  });

  it("confirming a held invite or guest, or getting a guest link, needs a person: a key or a connected app gets person_only", async () => {
    // The app routes take sessions only, so this calls the services as a key and a connected app reach them.
    const held = await api(wsKey, "POST", "/invites", { email: "sam@example.com" });
    const project = (await owner.post("/api/projects", { name: "Launch" })).body.project;
    const guest = (await api(wsKey, "POST", `/projects/${project.id}/guests`, { email: "client@example.com" })).body.guest.id as string;
    const me = (await owner.get("/api/account/me")).body;
    const base = { orgId, userId: me.user.id as string, email: me.user.email as string, name: "Olive Owner", role: "owner" as const };
    const key = { ...base, apiKeyId: "key_x", sessionId: "apikey:key_x" };
    const app = { ...base, apiKeyId: "oauth:grant_x", sessionId: "mcp:oauth:grant_x" };
    for (const who of [key, app]) {
      await expect(confirmInvite(ctx.deps, who as never, held.body.id)).rejects.toMatchObject({ status: 403, code: "person_only" });
      await expect(confirmGuest(ctx.deps, who as never, guest)).rejects.toMatchObject({ status: 403, code: "person_only" });
      await expect(newGuestLink(ctx.deps, who as never, guest)).rejects.toMatchObject({ status: 403, code: "person_only" });
    }
    // The same owner signed in to the app can.
    await expect(confirmInvite(ctx.deps, { ...base, sessionId: "sess_owner" } as never, held.body.id)).resolves.toMatchObject({ status: "pending" });
    await expect(confirmGuest(ctx.deps, { ...base, sessionId: "sess_owner" } as never, guest)).resolves.toMatchObject({ guest: expect.objectContaining({ awaitingConfirmation: false }) });
  });

  it("a key re-inviting a person's live invite holds it again; a person inviting a held address sends it", async () => {
    const live = await owner.post("/api/team/invites", { email: "lee@example.com", role: "member", mailboxIds: [] });
    expect(live.status).toBe(201);
    const again = await api(wsKey, "POST", "/invites", { email: "lee@example.com", role: "member" });
    expect(again.body).toMatchObject({ id: live.body.id, status: "awaiting_approval" });
    expect((await ctx.db.select().from(invitations).where(eq(invitations.id, live.body.id)).get())!.status).toBe("awaiting_approval");
    // A person inviting the same address sends a live invite and the held one goes.
    const person = await owner.post("/api/team/invites", { email: "lee@example.com", role: "member", mailboxIds: [] });
    expect(person.status).toBe(201);
    expect(person.body.status).toBe("pending");
    const rows = await ctx.db.select().from(invitations).where(eq(invitations.email, "lee@example.com"));
    expect(rows.filter((x) => x.status === "pending")).toHaveLength(1);
    expect(rows.filter((x) => x.status === "awaiting_approval")).toHaveLength(0);
    // A held invite can be revoked by the key or a person.
    const held = await api(wsKey, "POST", "/invites", { email: "kim@example.com" });
    expect((await owner.del(`/api/team/invites/${held.body.id}`)).status).toBe(200);
    expect((await ctx.db.select().from(invitations).where(eq(invitations.id, held.body.id)).get())!.status).toBe("canceled");
  });
});

describe("AIS1 row 1: a guest invite never goes out without a person", () => {
  it("a workspace key's guest invite waits unsent with no link until a person sends it", async () => {
    const project = (await owner.post("/api/projects", { name: "Launch" })).body.project;
    const sentBefore = ctx.outbound.sent.length;
    const r = await api(wsKey, "POST", `/projects/${project.id}/guests`, { email: "client@example.com" });
    expect(r.status).toBe(201);
    expect(r.body.delivery.status).toBe("awaiting_confirmation");
    expect(r.body.guest.awaitingConfirmation).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("/g/");
    expect(ctx.outbound.sent.slice(sentBefore).filter((m) => m.to.includes("client@example.com"))).toEqual([]);
    const row = (await ctx.db.select().from(projectGuests).where(eq(projectGuests.email, "client@example.com")).get())!;
    expect(row.inviteHash).toBeNull();
    // The key can't send it through the app's route either.
    const byKey = await ctx.app.request(`/api/guests/${row.id}/confirm`, { method: "POST", headers: { host: "localhost", authorization: `Bearer ${wsKey}`, "content-type": "application/json" }, body: "{}" });
    expect([401, 403]).toContain(byKey.status);
    // The owner sends it from the project's Guests.
    const listed = (await owner.get(`/api/guests?projectId=${project.id}`)).body.guests;
    expect(listed[0]).toMatchObject({ email: "client@example.com", awaitingConfirmation: true });
    const ok = await owner.post(`/api/guests/${row.id}/confirm`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.guest.awaitingConfirmation).toBe(false);
    expect(ctx.outbound.sent.slice(sentBefore).filter((m) => m.to.includes("client@example.com")).map((m) => m.subject)).toEqual(["You're invited to Launch"]);
    expect((await owner.post(`/api/guests/${row.id}/confirm`, {})).status).toBe(404);
  });

  it("an agent's guest invite waits for approval even when the agent sends without approval", async () => {
    await ctx.db.update(agents).set({ approvalMode: "never" });
    const project = (await owner.post("/api/projects", { name: "Launch" })).body.project;
    const r = await api(agentKey, "POST", `/projects/${project.id}/guests`, { email: "client@example.com" });
    expect(r.status).toBe(201);
    expect(r.body.delivery.status).toBe("pending_approval");
    expect(await ctx.db.select().from(sendApprovals)).toHaveLength(1);
    expect(ctx.outbound.sent.filter((m) => m.to.includes("client@example.com"))).toEqual([]);
  });
});

describe("AIS1 row 44: sign-up emails come only from the workspace's own verified domains, never an agent", () => {
  const SECRET = "v1,whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  it("the From list and every save refuse the agent's inbox and a connected address", async () => {
    expect((await owner.post("/api/mailboxes", { domainId, localPart: "no-reply", displayName: "Acme" })).status).toBe(201);
    // A connected Gmail sits on the platform's shared row, which is stored verified.
    await ctx.db.insert(organizations).values({ id: "org_platform", name: "Multies platform" }).onConflictDoNothing();
    await ctx.db.insert(domains).values({ id: "dom_connected", orgId: "org_platform", name: "connected.multies.invalid", status: "verified", verificationToken: "x", dkimSelector: "x", dkimPublicKey: "x", dkimPrivateKeyEnc: "x" }).onConflictDoNothing();
    const conn = (await ctx.db.select().from(domains).where(eq(domains.name, "connected.multies.invalid")).get())!;
    await ctx.db.insert(mailboxes).values({ id: "mbx_gmail", orgId, domainId: conn.id, localPart: "olive", address: "olive@gmail.com", displayName: "Olive", quotaMb: 100 });
    const senders = (await owner.get("/api/auth-email-settings")).body.senders.map((x: { address: string }) => x.address);
    expect(senders).toEqual(["no-reply@acme.io"]);
    for (const from of ["agent@acme.io", "olive@gmail.com"]) {
      const viaApp = await owner.put("/api/auth-email-settings", { from, supabaseUrl: "https://abcd1234.supabase.co", appName: "Acme", secret: SECRET });
      expect(viaApp.status, from).toBe(422);
      const viaKey = await api(wsKey, "POST", "/auth-email-hooks", { from, secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Acme" });
      expect(viaKey.status, from).toBe(422);
    }
    const ok = await api(wsKey, "POST", "/auth-email-hooks", { from: "no-reply@acme.io", secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Acme" });
    expect(ok.status).toBe(201);
    const moved = await api(wsKey, "PATCH", `/auth-email-hooks/${ok.body.hook?.id ?? ok.body.id}`, { from: "agent@acme.io" });
    expect(moved.status).toBe(422);
  });

  it("a hook saved before the rule with an agent's inbox as From keeps sending, and Settings says so", async () => {
    expect((await owner.post("/api/mailboxes", { domainId, localPart: "no-reply", displayName: "Acme" })).status).toBe(201);
    const ok = await api(wsKey, "POST", "/auth-email-hooks", { from: "no-reply@acme.io", secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Acme" });
    expect(ok.status).toBe(201);
    expect((await owner.get("/api/auth-email-settings")).body.settings).toMatchObject({ from: "no-reply@acme.io", fromAllowed: true });
    // What a workspace saved before AIS1 looks like: the hook sends from the agent's inbox.
    await ctx.db.update(authEmailHooks).set({ mailboxId: inboxId });
    const got = (await owner.get("/api/auth-email-settings")).body;
    expect(got.settings).toMatchObject({ from: "agent@acme.io", fromAllowed: false });
    expect(got.senders.map((x: { address: string }) => x.address)).toEqual(["no-reply@acme.io"]);
  });
});

describe("AIS1 rows 41 and 52: an AI that joined as a person is flagged, kept out of people lists, and shown once", () => {
  it("the Team list flags it, Staff leaves it out, and the assignee list shows the AI once", async () => {
    // The live damage: the agent's inbox address became a normal member before invites to agents were refused.
    await ctx.db.insert(users).values({ id: "usr_agentperson", email: "agent@acme.io", name: "Agent", emailVerified: true });
    await ctx.db.insert(members).values({ id: "mem_agentperson", organizationId: orgId, userId: "usr_agentperson", role: "member" });
    const team = (await owner.get("/api/team")).body.members as { userId: string; agentInbox: boolean }[];
    expect(team.find((m) => m.userId === "usr_agentperson")?.agentInbox).toBe(true);
    expect(team.filter((m) => m.agentInbox)).toHaveLength(1);
    const people = (await api(wsKey, "GET", "/people")).body.people as { id: string; agentInbox?: boolean }[];
    expect(people.find((p) => p.id === "usr_agentperson")?.agentInbox).toBe(true);
    const ownerId = (await owner.get("/api/account/me")).body.user.id as string;
    const staff = await listStaff(ctx.deps, { orgId, userId: ownerId, role: "owner" } as never);
    expect(staff.map((p) => p.userId)).toEqual([ownerId]);
    const list = (await owner.get("/api/tasks/assignees")).body.assignees as { id: string; type: string; name: string; isAgent?: boolean }[];
    expect(list.filter((a) => a.name === "Agent").map((a) => a.type)).toEqual(["agent"]);
    expect(list.find((a) => a.id === "member:usr_agentperson")).toBeUndefined();
    const chat = (await owner.get("/api/chat/people")).body.people as { name: string; type: string }[];
    expect(chat.filter((p) => p.name === "Agent").map((p) => p.type)).toEqual(["agent"]);
    // Names, workload and capacity still know it (tasks already assigned to it keep their name), as an AI with no address.
    const everyone = await assignees(ctx.deps, orgId);
    expect(everyone.find((a) => a.id === "member:usr_agentperson")).toMatchObject({ name: "Agent", email: null, isAgent: true });
  });

  it("a project owner is a person: an AI that joined as a person and an agent member are refused", async () => {
    await ctx.db.insert(users).values({ id: "usr_agentperson", email: "agent@acme.io", name: "Agent", emailVerified: true });
    await ctx.db.insert(members).values({ id: "mem_agentperson", organizationId: orgId, userId: "usr_agentperson", role: "member" });
    const bot = (await owner.post("/api/team/agents", { name: "Builder" })).body.member.userId as string;
    const ownerId = (await owner.get("/api/account/me")).body.user.id as string;
    const project = (await owner.post("/api/projects", { name: "Client work" })).body.project as { id: string };
    for (const who of ["usr_agentperson", bot]) {
      const r = await owner.patch(`/api/projects/${project.id}`, { ownerId: who });
      expect(r.status, who).toBe(422);
      expect(r.body.error.message).toMatch(/person/);
    }
    expect((await owner.patch(`/api/projects/${project.id}`, { ownerId })).status).toBe(200);
    // An AI set as owner before the fix stays, and saving the project again with it works; only a change is checked.
    await ctx.db.update(projects).set({ ownerUserId: bot }).where(eq(projects.id, project.id));
    expect((await owner.patch(`/api/projects/${project.id}`, { ownerId: bot, health: "on_track" })).status).toBe(200);
  });
});

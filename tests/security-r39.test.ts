import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { users, auditLogs } from "@/server/db/schema";
import { maskInviteId, redactAuditRow } from "@/server/services/audit";
import { memberSafeAudit } from "@/server/routes/dashboard";

/** R39 security hotfix: the prod demo, the audit log and invite acceptance. */
const IDP = { AUTH0_DOMAIN: "multies-test.us.auth0.com", AUTH0_CLIENT_ID: "web-client", AUTH0_CLIENT_SECRET: "web-secret" };
const idOf = (link: string) => link.split("/invite/")[1];

describe("R39: Try live demo without public password sign up", () => {
  it("opens the demo while email and password sign up is off (production setup)", async () => {
    const { app, db } = await makeTestApp({ DEMO_MODE: "true", ...IDP });
    const visitor = new Client(app);
    // Public password sign up stays off.
    const signup = await visitor.post("/api/auth/sign-up/email", { name: "X", email: "x@acme.io", password: "a-strong-password" });
    expect(signup.status).not.toBe(200);
    const demo = await visitor.post("/api/account/demo");
    expect(demo.status).toBe(201);
    const me = await visitor.get("/api/account/me");
    expect(me.status).toBe(200);
    expect(me.body.organization).toMatchObject({ isDemo: true, name: "Northwind Labs" });
    // The demo person is confirmed and got no welcome email for the fake address.
    const u = await db.select().from(users).where(eq(users.email, me.body.user.email)).get();
    expect(u?.emailVerified).toBe(true);
  });

  it("keeps the demo session maker off the HTTP router", async () => {
    const { app } = await makeTestApp({ DEMO_MODE: "true", ...IDP });
    const r = await new Client(app).post("/api/auth/multies/demo-session", { name: "Eve", email: "eve@acme.io" });
    expect(r.status).toBe(404);
  });
});

describe("R39: audit log is for owners and admins, invite ids are masked", () => {
  it("answers 403 to a member and masks invitation ids for admins", async () => {
    const { app } = await makeTestApp();
    const owner = new Client(app);
    await owner.signup("owner@acme.io");
    const inv = await owner.post("/api/team/invites", { email: "mate@example.com", role: "member" });
    const pending = await owner.post("/api/team/invites", { email: "later@example.com", role: "member" });
    const mate = new Client(app);
    await mate.signup("mate@example.com", "Mate", "");
    expect((await mate.post(`/api/invites/${idOf(inv.body.link)}/accept`)).status).toBe(200);

    const denied = await mate.get("/api/org/audit");
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain(idOf(pending.body.link));
    expect((await mate.get("/api/org/audit/export?format=json")).status).toBe(403);

    const ok = await owner.get("/api/org/audit");
    expect(ok.status).toBe(200);
    const text = JSON.stringify(ok.body);
    expect(text).not.toContain(idOf(pending.body.link));
    expect(text).not.toContain(idOf(inv.body.link));
    const invited = ok.body.entries.find((e: { action: string; metadata: { email?: string } }) => e.action === "member.invited" && e.metadata?.email === "later@example.com");
    expect(invited.targetId).toBe(maskInviteId(idOf(pending.body.link)));
    expect(invited.targetId).toMatch(/^\*{4}.{4}$/);

    const csv = await owner.call("GET", "/api/org/audit/export?format=json");
    expect(JSON.stringify(csv.body)).not.toContain(idOf(pending.body.link));

    // The dashboard's recent activity shows a member no IPs and no invited addresses.
    const dash = await mate.get("/api/dashboard");
    expect(dash.status).toBe(200);
    for (const e of dash.body.recent) expect(e.ip).toBeNull();
    expect(JSON.stringify(dash.body.recent)).not.toContain("later@example.com");
    expect(JSON.stringify(dash.body.recent)).not.toContain(idOf(pending.body.link));
  });

  it("masks invite ids and links inside metadata", () => {
    const id = "abcdefghijklmnopqrstuvwx";
    const row = redactAuditRow({ targetType: "invitation", targetId: id, metadata: { invitationId: id, link: `https://multies.si/invite/${id}`, note: "ok" } });
    expect(row.targetId).toBe("****uvwx");
    expect(row.metadata).toEqual({ invitationId: "****uvwx", link: "https://multies.si/invite/****uvwx", note: "ok" });
    const raw = redactAuditRow({ targetType: "invitation", targetId: id, metadata: JSON.stringify({ token: id }) });
    expect(raw.metadata).toBe(JSON.stringify({ token: "****uvwx" }));
    expect(maskInviteId("abc")).toBe("****");
    expect(memberSafeAudit({ ip: "1.2.3.4", actorEmail: "a@b.c", metadata: { email: "x@y.z", role: "member" } })).toEqual({ ip: null, actorEmail: "a@b.c", metadata: { role: "member" } });
  });

  it("stores the full id (only the output is masked)", async () => {
    const { app, db } = await makeTestApp();
    const owner = new Client(app);
    await owner.signup("owner2@acme.io");
    const inv = await owner.post("/api/team/invites", { email: "z@example.com", role: "member" });
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, "member.invited"));
    expect(rows.some((r) => r.targetId === idOf(inv.body.link))).toBe(true);
  });
});

describe("R39: accepting an invite needs a confirmed matching email", () => {
  async function setup() {
    const ctx = await makeTestApp();
    const owner = new Client(ctx.app);
    await owner.signup("boss@acme.io");
    const inv = await owner.post("/api/team/invites", { email: "victim@example.com", role: "admin" });
    expect(inv.status).toBe(201);
    const attacker = new Client(ctx.app);
    attacker.autoVerify = false;
    await attacker.signup("victim@example.com", "Not the victim", "");
    return { ...ctx, owner, attacker, id: idOf(inv.body.link) };
  }

  it("refuses an unconfirmed account made with the invited address", async () => {
    const { attacker, owner, id } = await setup();
    const r = await attacker.post(`/api/invites/${id}/accept`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("email_not_verified");
    const team = await owner.get("/api/team");
    expect(team.body.members.map((m: { email: string }) => m.email)).not.toContain("victim@example.com");
    expect(team.body.invites.map((i: { email: string }) => i.email)).toContain("victim@example.com");
  });

  it("closes Better Auth's own invitation endpoints over HTTP", async () => {
    const { attacker, id, owner } = await setup();
    for (const [path, body] of [
      ["/api/auth/organization/accept-invitation", { invitationId: id }],
      ["/api/auth/organization/reject-invitation", { invitationId: id }],
    ] as const) {
      expect((await attacker.post(path, body)).status).toBe(404);
    }
    expect((await attacker.get(`/api/auth/organization/get-invitation?id=${id}`)).status).toBe(404);
    expect((await owner.get("/api/auth/organization/list-invitations")).status).toBe(404);
    expect((await attacker.get("/api/auth/organization/list-user-invitations")).status).toBe(404);
    const team = await owner.get("/api/team");
    expect(team.body.members.map((m: { email: string }) => m.email)).not.toContain("victim@example.com");
  });

  it("still refuses a different address, and accepts once the address is confirmed", async () => {
    const { attacker, db, app, id } = await setup();
    const other = new Client(app);
    await other.signup("someone@example.com", "Someone", "");
    expect((await other.post(`/api/invites/${id}/accept`)).status).toBe(403);
    await db.update(users).set({ emailVerified: true }).where(eq(users.email, "victim@example.com"));
    const ok = await attacker.post(`/api/invites/${id}/accept`);
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe("admin");
  });
});

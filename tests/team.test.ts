import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => { ctx = await makeTestApp(); });

const tokenOf = (link: string) => link.split("/invite/")[1];

async function ownerWithMailboxes() {
  const owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  await owner.post("/api/org/plan", { plan: "pro" });
  const d = await owner.post("/api/domains", { name: "acme.io" });
  const sales = await owner.post("/api/mailboxes", { domainId: d.body.domain.id, localPart: "sales", displayName: "Sales" });
  const ceo = await owner.post("/api/mailboxes", { domainId: d.body.domain.id, localPart: "ceo", displayName: "CEO" });
  return { owner, salesId: sales.body.mailbox.id as string, ceoId: ceo.body.mailbox.id as string };
}

describe("team invitations", () => {
  it("invites by link, accepts after signup, and scopes a member to granted mailboxes", async () => {
    const { owner, salesId, ceoId } = await ownerWithMailboxes();
    const inv = await owner.post("/api/team/invites", { email: "Max@Acme.io", role: "member", mailboxIds: [salesId] });
    expect(inv.status).toBe(201);
    expect(inv.body.link).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);
    expect(inv.body.emailed).toBe(false); // no outbound provider in tests

    const anon = new Client(ctx.app);
    const view = await anon.get(`/api/invites/${tokenOf(inv.body.link)}`);
    expect(view.body.invite).toMatchObject({ email: "max@acme.io", role: "member", state: "pending", hasAccount: false, organization: { name: "Acme" } });

    const max = new Client(ctx.app);
    await max.signup("max@acme.io", "Max Member");
    const acc = await max.post(`/api/invites/${tokenOf(inv.body.link)}/accept`);
    expect(acc.status).toBe(200);
    const me = await max.get("/api/account/me");
    expect(me.body.organization).toMatchObject({ name: "Acme", role: "member" });

    const overview = await max.get("/api/mail/overview");
    expect(overview.body.mailboxes.map((m: { id: string }) => m.id)).toEqual([salesId]);
    const denied = await max.post("/api/mail/send", { mailboxId: ceoId, to: ["x@example.com"], subject: "hi", text: "hi" });
    expect(denied.status).toBe(404);
    expect((await max.post("/api/domains", { name: "nope.io" })).status).toBe(403);

    // Used links can't be replayed.
    expect((await max.post(`/api/invites/${tokenOf(inv.body.link)}/accept`)).status).toBe(410);
    const team = await owner.get("/api/team");
    expect(team.body.members).toHaveLength(2);
    expect(team.body.invites).toHaveLength(0);
    expect(team.body.members[1]).toMatchObject({ email: "max@acme.io", role: "member", mailboxIds: [salesId] });
  });

  it("only lets the invited address accept", async () => {
    const { owner } = await ownerWithMailboxes();
    const inv = await owner.post("/api/team/invites", { email: "right@acme.io" });
    const wrong = new Client(ctx.app);
    await wrong.signup("wrong@acme.io");
    const r = await wrong.post(`/api/invites/${tokenOf(inv.body.link)}/accept`);
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain("right@acme.io");
  });

  it("enforces seats, and revoking frees a seat", async () => {
    const owner = new Client(ctx.app);
    await owner.signup("solo@acme.io");
    // Free includes 3 people: the owner and two more.
    const a = await owner.post("/api/team/invites", { email: "a@acme.io" });
    expect(a.status).toBe(201);
    expect((await owner.post("/api/team/invites", { email: "a2@acme.io" })).status).toBe(201);
    const b = await owner.post("/api/team/invites", { email: "b@acme.io" });
    expect(b.status).toBe(403);
    expect(b.body.error.code).toBe("plan_limit");
    expect(b.body.error.message).toContain("mailbox pack");
    expect((await owner.del(`/api/team/invites/${a.body.id}`)).status).toBe(200);
    expect((await owner.post("/api/team/invites", { email: "b@acme.io" })).status).toBe(201);
    // revoked link is dead
    expect((await new Client(ctx.app).get(`/api/invites/${tokenOf(a.body.link)}`)).body.invite.state).toBe("revoked");
  });

  it("applies role rules: admins manage members, only the owner manages admins", async () => {
    const { owner, salesId, ceoId } = await ownerWithMailboxes();
    const join = async (email: string, role: "admin" | "member") => {
      const inv = await owner.post("/api/team/invites", { email, role });
      const c = new Client(ctx.app);
      await c.signup(email);
      await c.post(`/api/invites/${tokenOf(inv.body.link)}/accept`);
      const me = await c.get("/api/account/me");
      return { c, id: me.body.user.id as string };
    };
    const admin = await join("admin@acme.io", "admin");
    const member = await join("member@acme.io", "member");
    const other = await join("other@acme.io", "member");

    expect((await admin.c.post("/api/team/invites", { email: "x@acme.io", role: "admin" })).status).toBe(403);
    expect((await admin.c.patch(`/api/team/members/${member.id}`, { mailboxIds: [salesId, ceoId] })).status).toBe(200);
    expect((await member.c.get("/api/mail/overview")).body.mailboxes).toHaveLength(2);
    expect((await admin.c.patch(`/api/team/members/${member.id}`, { role: "admin" })).status).toBe(403);
    expect((await member.c.del(`/api/team/members/${other.id}`)).status).toBe(403);
    expect((await owner.patch(`/api/team/members/${member.id}`, { role: "admin" })).status).toBe(200);
    expect((await admin.c.del(`/api/team/members/${member.id}`)).status).toBe(403);
    expect((await admin.c.del(`/api/team/members/${other.id}`)).status).toBe(200);
    // removed member is signed out of the workspace
    const acmeId = (await owner.get("/api/account/me")).body.organization.id;
    expect((await other.c.get("/api/account/me")).body.organization.id).not.toBe(acmeId);
    // a member can leave by themselves
    expect((await member.c.del(`/api/team/members/${member.id}`)).status).toBe(200);
  });

  it("transfers ownership with password confirmation", async () => {
    const { owner } = await ownerWithMailboxes();
    const inv = await owner.post("/api/team/invites", { email: "next@acme.io", role: "admin" });
    const next = new Client(ctx.app);
    await next.signup("next@acme.io");
    await next.post(`/api/invites/${tokenOf(inv.body.link)}/accept`);
    const nextId = (await next.get("/api/account/me")).body.user.id;
    expect((await owner.post("/api/team/transfer", { userId: nextId, password: "nope" })).status).toBe(422);
    expect((await owner.post("/api/team/transfer", { userId: nextId, password: "a-strong-password" })).status).toBe(200);
    expect((await next.get("/api/account/me")).body.organization.role).toBe("owner");
    expect((await owner.get("/api/account/me")).body.organization.role).toBe("admin");
  });

  it("delivers the invite into the inbox when the invitee is hosted here", async () => {
    const { owner, salesId } = await ownerWithMailboxes();
    const inv = await owner.post("/api/team/invites", { email: "sales@acme.io", role: "member", mailboxIds: [salesId] });
    expect(inv.body.emailed).toBe(true);
    const list = await owner.get(`/api/mail/messages?mailboxId=${salesId}&folder=inbox`);
    expect(list.body.messages[0].subject).toContain("invited you to Acme");
  });
});

describe("workspaces", () => {
  it("creates, switches between and deletes workspaces", async () => {
    const a = new Client(ctx.app);
    await a.signup("multi@acme.io");
    const created = await a.post("/api/account/workspaces", { name: "Side project" });
    expect(created.status).toBe(201);
    expect((await a.get("/api/account/me")).body.organization.name).toBe("Side project");
    const list = await a.get("/api/account/workspaces");
    expect(list.body.workspaces).toHaveLength(2);
    const acme = list.body.workspaces.find((w: { name: string }) => w.name === "Acme");
    await a.post(`/api/account/workspaces/${acme.id}/switch`);
    expect((await a.get("/api/account/me")).body.organization.name).toBe("Acme");
    expect((await a.call("DELETE", "/api/account/workspace", { password: "a-strong-password" })).body).toMatchObject({ ok: true, remaining: true });
    expect((await a.get("/api/account/me")).body.organization.name).toBe("Side project");
    expect((await a.call("DELETE", "/api/account/workspace", { password: "wrong-password" })).status).toBe(422);
    expect((await a.call("DELETE", "/api/account/workspace", { password: "a-strong-password" })).body).toMatchObject({ ok: true, remaining: false });
  });
});

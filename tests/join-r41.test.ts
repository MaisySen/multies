import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { users } from "@/server/db/schema";

/** R41 (MB-221, MB-202): a confirmed newcomer with a pending invite joins that workspace on first sign in. */
describe("R41 join on first sign in", () => {
  async function setup() {
    const t = await makeTestApp();
    const owner = new Client(t.app);
    await owner.signup(`olive-${Math.random().toString(36).slice(2, 7)}@example.com`, "Olive Owner", "Harbor");
    return { ...t, owner };
  }

  it("joins the inviting workspace instead of making a personal one, with no workspace setup", async () => {
    const { app, db, owner } = await setup();
    const email = `sam-${Math.random().toString(36).slice(2, 7)}@example.com`;
    const inv = await owner.post("/api/team/invites", { email, role: "member" });
    expect(inv.status).toBe(201);
    const mate = new Client(app);
    mate.autoVerify = false;
    expect((await mate.post("/api/auth/sign-up/email", { name: "Sam Lee", email, password: "a-strong-password" })).status).toBe(200);
    // Confirmed before the first signed in request, as the identity provider's sign up does.
    await db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
    const me = await mate.get("/api/account/me");
    expect(me.status).toBe(200);
    expect(me.body.organization).toMatchObject({ name: "Harbor", role: "member" });
    expect(me.body.onboarding.workspace).toBe(false);
    expect(me.body.pendingInvites).toEqual([]);
    const ws = await mate.get("/api/account/workspaces");
    expect(ws.body.workspaces).toHaveLength(1);
    const token = inv.body.link.split("/invite/")[1];
    expect((await mate.get(`/api/invites/${token}`)).body.invite.state).toBe("accepted");
  });

  it("an unconfirmed newcomer does not join; they get a personal workspace and the invite waits", async () => {
    const { app, owner } = await setup();
    const email = `kim-${Math.random().toString(36).slice(2, 7)}@example.com`;
    expect((await owner.post("/api/team/invites", { email, role: "member" })).status).toBe(201);
    const mate = new Client(app);
    mate.autoVerify = false;
    expect((await mate.post("/api/auth/sign-up/email", { name: "Kim", email, password: "a-strong-password" })).status).toBe(200);
    const me = await mate.get("/api/account/me");
    expect(me.body.organization.role).toBe("owner");
    expect(me.body.organization.name).not.toBe("Harbor");
  });

  it("someone with no invite still gets their own workspace", async () => {
    const { app, db } = await setup();
    const c = new Client(app);
    const email = `solo-${Math.random().toString(36).slice(2, 7)}@example.com`;
    expect((await c.post("/api/auth/sign-up/email", { name: "Solo", email, password: "a-strong-password" })).status).toBe(200);
    await db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
    const me = await c.get("/api/account/me");
    expect(me.body.organization.role).toBe("owner");
  });
});

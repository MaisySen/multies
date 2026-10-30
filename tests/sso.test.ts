import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { loginMethodFor } from "@/server/auth";
import { sessions, users } from "@/server/db/schema";

// Password sessions stay on here (AUTH_LOCAL_PASSWORD=on) so the test can compare them with SSO sessions.
const AUTH0 = { AUTH0_DOMAIN: "acme.au.auth0.com", AUTH0_CLIENT_ID: "cid", AUTH0_CLIENT_SECRET: "secret", AUTH_LOCAL_PASSWORD: "on" };

describe("team SSO enforcement", () => {
  it("records how each session signed in", () => {
    expect(loginMethodFor("/sign-in/email")).toBe("email");
    expect(loginMethodFor("/oauth2/callback/:providerId", { providerId: "auth0" })).toBe("auth0");
    expect(loginMethodFor("/callback/:id", { id: "google" })).toBe("google");
    expect(loginMethodFor(undefined)).toBe("email");
  });

  it("blocks password sessions of members once the owner requires SSO", async () => {
    const ctx = await makeTestApp(AUTH0);
    const owner = new Client(ctx.app);
    await owner.signup("owner@acme.io");
    // Enforcing SSO is available on every plan, Free included.

    const invite = await owner.post("/api/team/invites", { email: "mem@acme.io", role: "member" });
    const member = new Client(ctx.app);
    await member.signup("mem@acme.io", "Mem", "");
    await member.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`);
    expect((await member.put("/api/org/sso", { required: true })).status).toBe(403);

    expect((await owner.put("/api/org/sso", { required: true })).body.requireSso).toBe(true);
    const blocked = await member.get("/api/domains");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("sso_required");
    const me = await member.get("/api/account/me");
    expect(me.status).toBe(200);
    expect(me.body.session).toEqual({ loginMethod: "email", ssoBlocked: true });
    // The owner is the break glass account and keeps password access.
    expect((await owner.get("/api/domains")).status).toBe(200);

    // A session that came through the SSO provider gets in.
    const u = (await ctx.db.select().from(users).where(eq(users.email, "mem@acme.io")).get())!;
    await ctx.db.update(sessions).set({ loginMethod: "auth0" }).where(eq(sessions.userId, u.id));
    expect((await member.get("/api/domains")).status).toBe(200);

    expect((await owner.put("/api/org/sso", { required: false })).status).toBe(200);
    const audit = (await owner.get("/api/org/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["workspace.sso_required", "workspace.sso_optional"]));
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { loadConfig } from "@/server/config";
import { connectionOfSubject, parseSocialConnections, providerEmailVerified, socialAuthorizeParams } from "@/server/auth";
import { idpProviderConfig } from "@/server/auth/providers";
import { visibleSocialConnections } from "@/web/components/social-sign-in";
import { accounts, users } from "@/server/db/schema";
import { fakeIdpR25, R25_IDP, R25_ISS, socialSignIn } from "./fake-idp-r25";

afterEach(() => { vi.unstubAllGlobals(); });

describe("R25 social sign in: AUTH0_SOCIAL_CONNECTIONS", () => {
  it("keeps only known connections, in a fixed order, without repeats", () => {
    expect(parseSocialConnections(undefined)).toEqual([]);
    expect(parseSocialConnections("")).toEqual([]);
    expect(parseSocialConnections("google-oauth2")).toEqual(["google-oauth2"]);
    expect(parseSocialConnections(" WindowsLive , google-oauth2,google-oauth2 ")).toEqual(["google-oauth2", "windowslive"]);
    expect(parseSocialConnections("github apple facebook")).toEqual([]);
    expect(parseSocialConnections("google-oauth2 windowslive")).toEqual(["google-oauth2", "windowslive"]);
  });

  it("is off unless set, and off without the identity provider even when set", () => {
    expect(loadConfig(R25_IDP).auth.socialConnections).toEqual([]);
    expect(loadConfig({ ...R25_IDP, AUTH0_SOCIAL_CONNECTIONS: "google-oauth2,windowslive" }).auth.socialConnections).toEqual(["google-oauth2", "windowslive"]);
    expect(loadConfig({ AUTH0_SOCIAL_CONNECTIONS: "google-oauth2" }).auth.socialConnections).toEqual([]);
  });

  it("is published on /api/config, and production style config shows no buttons", async () => {
    const off = await makeTestApp(R25_IDP);
    expect((await new Client(off.app).get("/api/config")).body.socialConnections).toEqual([]);
    const on = await makeTestApp({ ...R25_IDP, AUTH0_SOCIAL_CONNECTIONS: "google-oauth2,windowslive" });
    expect((await new Client(on.app).get("/api/config")).body.socialConnections).toEqual(["google-oauth2", "windowslive"]);
    const self = await makeTestApp({ AUTH0_SOCIAL_CONNECTIONS: "google-oauth2" });
    expect((await new Client(self.app).get("/api/config")).body.socialConnections).toEqual([]);
  });

  it("the page shows only known connections from the config", () => {
    expect(visibleSocialConnections(undefined)).toEqual([]);
    expect(visibleSocialConnections(["windowslive", "github", "google-oauth2"])).toEqual(["google-oauth2", "windowslive"]);
  });
});

describe("R25 social sign in: the authorize URL", () => {
  it("carries connection=google-oauth2 or windowslive next to PKCE, state and nonce", async () => {
    const idp = await fakeIdpR25();
    const ctx = await makeTestApp({ ...R25_IDP, APP_URL: "http://localhost", AUTH0_SOCIAL_CONNECTIONS: "google-oauth2,windowslive" });
    for (const connection of ["google-oauth2", "windowslive"]) {
      const c = new Client(ctx.app);
      const start = await c.post("/api/auth/sign-in/social", { provider: "auth0", callbackURL: "/app/my-work", disableRedirect: true, additionalParams: socialAuthorizeParams(connection as "google-oauth2") });
      expect(start.status).toBe(200);
      const url = new URL(start.body.url);
      expect(url.origin + url.pathname).toBe(`${R25_ISS}authorize`);
      expect(url.searchParams.get("connection")).toBe(connection);
      expect(url.searchParams.get("client_id")).toBe("web-client");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("nonce")).toBeTruthy();
      expect(url.searchParams.get("redirect_uri")).toBe("http://localhost/api/auth/callback/auth0");
    }
    // The plain "Continue with Multies" button sends no connection, so the provider shows its own page.
    const plain = await new Client(ctx.app).post("/api/auth/sign-in/social", { provider: "auth0", callbackURL: "/app", disableRedirect: true });
    expect(new URL(plain.body.url).searchParams.get("connection")).toBeNull();
    expect(idp.state.tokenCalls).toBe(0);
  });
});

describe("R25 social sign in: one person per verified email", () => {
  it("reads the connection from the subject and trusts only a real true email_verified", () => {
    expect(connectionOfSubject("google-oauth2|123")).toBe("google-oauth2");
    expect(connectionOfSubject("windowslive|abc")).toBe("windowslive");
    expect(connectionOfSubject("nobar")).toBeNull();
    expect(providerEmailVerified({ email_verified: true })).toBe(true);
    expect(providerEmailVerified({ email_verified: "true" })).toBe(false);
    expect(providerEmailVerified({})).toBe(false);
    const cfg = idpProviderConfig(loadConfig(R25_IDP))!;
    expect(cfg.mapProfileToUser({ name: "Ada", email: "ada@acme.io", email_verified: false })).toEqual({ name: "Ada", emailVerified: false });
  });

  it("a Google sign in with the verified email of a password account lands on that account, twice, never a second person", async () => {
    const idp = await fakeIdpR25();
    const ctx = await makeTestApp({ ...R25_IDP, APP_URL: "http://localhost", AUTH_LOCAL_PASSWORD: "on", AUTH0_SOCIAL_CONNECTIONS: "google-oauth2,windowslive" });
    const local = new Client(ctx.app);
    await local.signup("ada@acme.io");
    const before = (await ctx.db.select().from(users).where(eq(users.email, "ada@acme.io")).get())!;
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.id, before.id));
    const orgBefore = (await local.get("/api/account/me")).body.org?.id;
    const usersBefore = (await ctx.db.select().from(users)).length;

    const first = await socialSignIn(ctx.app, idp, "google-oauth2", { sub: "google-oauth2|111", email: "Ada@acme.io", email_verified: true, name: "Ada Lovelace" });
    expect(first.cb.status).toBe(302);
    expect(first.cb.headers.get("location")).toBe("/app/my-work");
    const me = await first.client.get("/api/account/me");
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(before.id);
    if (orgBefore) expect(me.body.org?.id).toBe(orgBefore);

    const again = await socialSignIn(ctx.app, idp, "google-oauth2", { sub: "google-oauth2|111", email: "ada@acme.io", email_verified: true });
    expect((await again.client.get("/api/account/me")).body.user.id).toBe(before.id);
    // Microsoft with the same verified address joins the same person too.
    const ms = await socialSignIn(ctx.app, idp, "windowslive", { sub: "windowslive|abc", email: "ada@acme.io", email_verified: true });
    expect((await ms.client.get("/api/account/me")).body.user.id).toBe(before.id);

    expect((await ctx.db.select().from(users)).length).toBe(usersBefore);
    const linked = (await ctx.db.select().from(accounts).where(eq(accounts.userId, before.id))).map((a) => `${a.providerId}:${a.accountId}`).sort();
    expect(linked).toEqual(["auth0:google-oauth2|111", "auth0:windowslive|abc", `credential:${before.id}`].sort());
  });

  it("an unverified provider email does not link and does not create a second person", async () => {
    const idp = await fakeIdpR25();
    const ctx = await makeTestApp({ ...R25_IDP, APP_URL: "http://localhost", AUTH_LOCAL_PASSWORD: "on", AUTH0_SOCIAL_CONNECTIONS: "windowslive" });
    const local = new Client(ctx.app);
    await local.signup("bob@acme.io");
    const bob = (await ctx.db.select().from(users).where(eq(users.email, "bob@acme.io")).get())!;
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.id, bob.id));
    const usersBefore = (await ctx.db.select().from(users)).length;
    for (const claim of [false, "true", undefined]) {
      const r = await socialSignIn(ctx.app, idp, "windowslive", { sub: "windowslive|bob", email: "bob@acme.io", ...(claim === undefined ? {} : { email_verified: claim }) });
      expect(r.cb.status).toBe(302);
      expect(r.cb.headers.get("location") ?? "").toMatch(/error=/);
      expect((await r.client.get("/api/account/me")).status).toBe(401);
    }
    expect((await ctx.db.select().from(users)).length).toBe(usersBefore);
    expect((await ctx.db.select().from(accounts).where(eq(accounts.userId, bob.id))).map((a) => a.providerId)).toEqual(["credential"]);
  });

  it("a new verified Google address gets its own account, and a database sign in with that address later lands on it", async () => {
    const idp = await fakeIdpR25();
    const ctx = await makeTestApp({ ...R25_IDP, APP_URL: "http://localhost", AUTH0_SOCIAL_CONNECTIONS: "google-oauth2" });
    const g = await socialSignIn(ctx.app, idp, "google-oauth2", { sub: "google-oauth2|222", email: "cy@acme.io", email_verified: true, name: "Cy" });
    const id = (await g.client.get("/api/account/me")).body.user.id;
    expect(id).toBeTruthy();
    const db = await socialSignIn(ctx.app, idp, "", { sub: "auth0|cy", email: "cy@acme.io", email_verified: true });
    expect((await db.client.get("/api/account/me")).body.user.id).toBe(id);
    expect((await ctx.db.select().from(users).where(eq(users.email, "cy@acme.io"))).length).toBe(1);
  });
});

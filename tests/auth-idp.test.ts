import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { makeTestApp, Client } from "./helpers";
import { legacyIdp, loadConfig, resolveLocalPassword } from "@/server/config";
import { unverifiedIssuer } from "@/server/auth/mobile";
import { authMode, idpIssuer, idpLogoutUrl, mayLinkByEmail, verifyIdToken } from "@/server/auth";
import { setJwksForTests } from "@/server/auth/tokens";
import { accounts, users } from "@/server/db/schema";

const DOMAIN = "multies-test.us.auth0.com";
const ISS = `https://${DOMAIN}/`;
const IDP = { AUTH0_DOMAIN: DOMAIN, AUTH0_CLIENT_ID: "web-client", AUTH0_CLIENT_SECRET: "web-secret", AUTH0_NATIVE_CLIENT_ID: "native-client" };

let privateKey: CryptoKey;
let jwk: JWK;
beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey as CryptoKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  setJwksForTests(DOMAIN, createLocalJWKSet({ keys: [jwk] }) as never);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function idToken(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISS).setAudience(opts.aud ?? "web-client").setSubject(String(claims.sub ?? "auth0|abc"))
    .setIssuedAt(now - 5).setExpirationTime(opts.exp ?? now + 600)
    .sign(privateKey);
}

/** A fake identity provider: discovery, JWKS and a token endpoint that returns `next` ID token. */
function fakeIdp(state: { idToken?: string; tokenCalls: URLSearchParams[] }) {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(ISS)) return real(input, init);
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return json({ issuer: ISS, authorization_endpoint: `${ISS}authorize`, token_endpoint: `${ISS}oauth/token`, userinfo_endpoint: `${ISS}userinfo`, jwks_uri: `${ISS}.well-known/jwks.json`, end_session_endpoint: `${ISS}oidc/logout`, id_token_signing_alg_values_supported: ["RS256"] });
    }
    if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [jwk] });
    if (url.endsWith("/oauth/token")) {
      state.tokenCalls.push(new URLSearchParams(String(init?.body ?? "")));
      return json({ access_token: "at", id_token: state.idToken, token_type: "Bearer", expires_in: 3600, scope: "openid profile email" });
    }
    if (url.endsWith("/userinfo")) return json({});
    return new Response("not found", { status: 404 });
  });
}

describe("auth config: AUTH_LOCAL_PASSWORD", () => {
  it("is on without the identity provider and off with it, unless the flag says otherwise", () => {
    expect(resolveLocalPassword(undefined, false)).toBe(true);
    expect(resolveLocalPassword(undefined, true)).toBe(false);
    expect(resolveLocalPassword("on", true)).toBe(true);
    expect(resolveLocalPassword("off", false)).toBe(false);
    expect(resolveLocalPassword("true", true)).toBe(true);
  });
  it("never leaves a deployment without a way in", () => {
    const selfHost = loadConfig({ AUTH_LOCAL_PASSWORD: "off" });
    expect(authMode(selfHost)).toEqual({ idp: false, localPassword: true, mobile: false });
    const cloud = loadConfig(IDP);
    expect(authMode(cloud)).toEqual({ idp: true, localPassword: false, mobile: true });
    expect(idpIssuer("https://x.auth0.com/")).toBe("https://x.auth0.com/");
  });
  it("builds the provider logout URL with returnTo on this deployment", () => {
    const u = new URL(idpLogoutUrl(loadConfig({ ...IDP, APP_URL: "https://multies.si" }))!);
    expect(u.origin + u.pathname).toBe(`https://${DOMAIN}/v2/logout`);
    expect(u.searchParams.get("returnTo")).toBe("https://multies.si/login");
    expect(u.searchParams.get("client_id")).toBe("web-client");
  });
});

describe("auth linking rule", () => {
  it("links only a verified, matching email", () => {
    expect(mayLinkByEmail({ email: "Ada@Acme.io", emailVerified: true }, { email: "ada@acme.io" })).toBe(true);
    expect(mayLinkByEmail({ email: "ada@acme.io", emailVerified: false }, { email: "ada@acme.io" })).toBe(false);
    expect(mayLinkByEmail({ email: "eve@acme.io", emailVerified: true }, { email: "ada@acme.io" })).toBe(false);
  });
});

describe("ID token verification (mocked JWKS)", () => {
  const opts = { domain: DOMAIN, audience: "web-client" };
  it("accepts a token signed by the provider for this client", async () => {
    const c = await verifyIdToken(await idToken({ sub: "auth0|1", email: "Ada@Acme.io", nonce: "n-12345678" }), { ...opts, nonce: "n-12345678" });
    expect(c).toMatchObject({ sub: "auth0|1", email: "ada@acme.io", emailVerified: true });
  });
  it("refuses the wrong issuer, audience, an expired token, a nonce mismatch and a forged signature", async () => {
    await expect(verifyIdToken(await idToken({ email: "a@b.io" }, { iss: "https://evil.example/" }), opts)).rejects.toMatchObject({ reason: "claims" });
    await expect(verifyIdToken(await idToken({ email: "a@b.io" }, { aud: "someone-else" }), opts)).rejects.toMatchObject({ reason: "claims" });
    await expect(verifyIdToken(await idToken({ email: "a@b.io" }, { exp: Math.floor(Date.now() / 1000) - 600 }), opts)).rejects.toMatchObject({ reason: "expired" });
    await expect(verifyIdToken(await idToken({ email: "a@b.io", nonce: "a-12345678" }), { ...opts, nonce: "b-12345678" })).rejects.toMatchObject({ reason: "nonce" });
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: "a@b.io" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISS).setAudience("web-client").setSubject("x").setIssuedAt().setExpirationTime("5m").sign(other.privateKey);
    await expect(verifyIdToken(forged, opts)).rejects.toMatchObject({ reason: "signature" });
    await expect(verifyIdToken("not-a-jwt", opts)).rejects.toMatchObject({ reason: "malformed" });
  });
});

describe("web sign in through the identity provider", () => {
  it("redirects to the authorize URL with PKCE, state and nonce, and the callback makes a session", async () => {
    const idp = { tokenCalls: [] as URLSearchParams[] } as { idToken?: string; tokenCalls: URLSearchParams[] };
    fakeIdp(idp);
    const ctx = await makeTestApp({ ...IDP, APP_URL: "http://localhost" });
    const c = new Client(ctx.app);
    expect((await c.get("/api/account/providers")).body).toMatchObject({ idp: true, password: false });

    const start = await c.post("/api/auth/sign-in/social", { provider: "auth0", callbackURL: "/app", disableRedirect: true });
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(url.origin + url.pathname).toBe(`${ISS}authorize`);
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("web-client");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")).toBeTruthy();
    expect(q.get("nonce")).toBeTruthy();
    expect(q.get("redirect_uri")).toBe("http://localhost/api/auth/callback/auth0");
    expect(q.get("scope")).toContain("openid");

    idp.idToken = await idToken({ sub: "auth0|new1", email: "new@acme.io", name: "New Person", nonce: q.get("nonce") });
    const cb = await ctx.app.request(`/api/auth/callback/auth0?code=abc&state=${encodeURIComponent(q.get("state")!)}`, { headers: { host: "localhost", cookie: c.cookie } });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/app");
    expect(idp.tokenCalls[0].get("code_verifier")).toMatch(/^[A-Za-z0-9_~.-]{43,128}$/);
    const setCookies = cb.headers.getSetCookie();
    const session = setCookies.find((x) => x.includes("session_token="));
    expect(session).toBeTruthy();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    for (const sc of setCookies) { const [pair] = sc.split(";"); const i = pair.indexOf("="); c.jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    const me = await c.get("/api/account/me");
    expect(me.status).toBe(200);
    expect(me.body.session.loginMethod).toBe("auth0");
  });

  it("refuses a callback whose state does not match", async () => {
    const idp = { tokenCalls: [] as URLSearchParams[] } as { idToken?: string; tokenCalls: URLSearchParams[] };
    fakeIdp(idp);
    const ctx = await makeTestApp({ ...IDP, APP_URL: "http://localhost" });
    const c = new Client(ctx.app);
    await c.post("/api/auth/sign-in/social", { provider: "auth0", callbackURL: "/app", disableRedirect: true });
    const cb = await ctx.app.request("/api/auth/callback/auth0?code=abc&state=forged-state", { headers: { host: "localhost", cookie: c.cookie } });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location") ?? "").toContain("error");
    expect(idp.tokenCalls.length).toBe(0);
    expect(cb.headers.getSetCookie().some((x) => /session_token=[^;]+/.test(x) && !/max-age=0/i.test(x))).toBe(false);
  });
});

describe("existing accounts and the password flag", () => {
  it("links an existing password account by verified email and keeps its workspace", async () => {
    const ctx = await makeTestApp({ ...IDP, AUTH_LOCAL_PASSWORD: "on" });
    const local = new Client(ctx.app);
    await local.signup("ada@acme.io");
    const before = (await ctx.db.select().from(users).where(eq(users.email, "ada@acme.io")).get())!;
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.id, before.id));
    const orgBefore = (await local.get("/api/account/me")).body.org?.id ?? (await local.get("/api/account/me")).body.organization?.id;

    const phone = new Client(ctx.app);
    const r = await phone.post("/api/auth/mobile/exchange", { idToken: await idToken({ sub: "auth0|ada", email: "ada@acme.io" }, { aud: "native-client" }) });
    expect(r.status).toBe(200);
    expect(r.body.user.id).toBe(before.id);
    const linked = await ctx.db.select().from(accounts).where(eq(accounts.userId, before.id));
    expect(linked.map((a) => a.providerId).sort()).toEqual(["auth0", "credential"]);
    const me = await phone.get("/api/account/me");
    expect(me.status).toBe(200);
    expect(me.body.session.loginMethod).toBe("auth0");
    if (orgBefore) expect(me.body.org?.id ?? me.body.organization?.id).toBe(orgBefore);
  });

  it("takes over an unconfirmed local account for the address owner and drops its password", async () => {
    const ctx = await makeTestApp({ ...IDP, AUTH_LOCAL_PASSWORD: "on" });
    const squatter = new Client(ctx.app);
    await squatter.signup("victim@acme.io");
    const u = (await ctx.db.select().from(users).where(eq(users.email, "victim@acme.io")).get())!;
    expect(u.emailVerified).toBe(false);
    const owner = new Client(ctx.app);
    const r = await owner.post("/api/auth/mobile/exchange", { idToken: await idToken({ sub: "auth0|victim", email: "victim@acme.io" }, { aud: "native-client" }) });
    expect(r.status).toBe(200);
    const after = (await ctx.db.select().from(users).where(eq(users.id, u.id)).get())!;
    expect(after.emailVerified).toBe(true);
    const providers = (await ctx.db.select().from(accounts).where(eq(accounts.userId, u.id))).map((a) => a.providerId);
    expect(providers).toEqual(["auth0"]);
    expect((await squatter.get("/api/account/me")).status).toBe(401);
  });

  it("refuses an unverified provider email, a token for another client, and turns the password form off by default", async () => {
    const ctx = await makeTestApp(IDP);
    const c = new Client(ctx.app);
    expect((await c.post("/api/auth/mobile/exchange", { idToken: await idToken({ sub: "auth0|u", email: "u@acme.io", email_verified: false }, { aud: "native-client" }) })).status).toBe(403);
    expect((await c.post("/api/auth/mobile/exchange", { idToken: await idToken({ sub: "auth0|u", email: "u@acme.io" }, { aud: "other-app" }) })).status).toBe(401);
    const signUp = await c.post("/api/auth/sign-up/email", { name: "X", email: "x@acme.io", password: "a-strong-password" });
    expect(signUp.status).toBeGreaterThanOrEqual(400);
    const signIn = await c.post("/api/auth/sign-in/email", { email: "x@acme.io", password: "a-strong-password" });
    expect(signIn.status).toBeGreaterThanOrEqual(400);
    expect((await c.get("/api/account/providers")).body).toMatchObject({ idp: true, password: false });
  });

  it("answers 404 for the exchange without the identity provider and keeps passwords on", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    expect((await c.post("/api/auth/mobile/exchange", { idToken: "a".repeat(40) })).status).toBe(404);
    expect((await c.get("/api/account/providers")).body).toMatchObject({ idp: false, password: true });
    const res = await ctx.app.request("/api/auth/logout/idp", { headers: { host: "localhost" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login$/);
  });
});

describe("previous tenant for older phone app builds (round 19)", () => {
  const LEGACY = "multies-old.us.auth0.com";
  const LEGACY_ISS = `https://${LEGACY}/`;
  let legacyKey: CryptoKey;
  beforeAll(async () => {
    const kp = await generateKeyPair("RS256", { extractable: true });
    legacyKey = kp.privateKey as CryptoKey;
    const pub = { ...(await exportJWK(kp.publicKey)), kid: "old1", alg: "RS256", use: "sig" };
    setJwksForTests(LEGACY, createLocalJWKSet({ keys: [pub] }) as never);
  });
  async function legacyToken(claims: Record<string, unknown>, aud = "old-native") {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ email_verified: true, ...claims }).setProtectedHeader({ alg: "RS256", kid: "old1" })
      .setIssuer(LEGACY_ISS).setAudience(aud).setSubject(String(claims.sub)).setIssuedAt(now - 5).setExpirationTime(now + 600).sign(legacyKey);
  }
  const LEGACY_ENV = { AUTH0_LEGACY_DOMAIN: `https://${LEGACY}/`, AUTH0_LEGACY_NATIVE_CLIENT_ID: "old-native" };

  it("reads the legacy tenant only with a domain and a client id", () => {
    expect(legacyIdp({})).toEqual({});
    expect(legacyIdp({ AUTH0_LEGACY_DOMAIN: LEGACY })).toEqual({});
    expect(legacyIdp(LEGACY_ENV)).toEqual({ legacy: { domain: LEGACY, audience: ["old-native"] } });
    expect(legacyIdp({ ...LEGACY_ENV, AUTH0_LEGACY_CLIENT_ID: "old-web" }).legacy?.audience).toEqual(["old-native", "old-web"]);
  });

  it("accepts an older build's token from the previous tenant and lands on the same Multies account", async () => {
    const ctx = await makeTestApp({ ...IDP, ...LEGACY_ENV });
    const newPhone = new Client(ctx.app);
    const a = await newPhone.post("/api/auth/mobile/exchange", { idToken: await idToken({ sub: "auth0|new-sub", email: "bo@acme.io" }, { aud: "native-client" }) });
    expect(a.status).toBe(200);
    const oldPhone = new Client(ctx.app);
    const b = await oldPhone.post("/api/auth/mobile/exchange", { idToken: await legacyToken({ sub: "auth0|old-sub", email: "bo@acme.io" }) });
    expect(b.status).toBe(200);
    expect(b.body.user.id).toBe(a.body.user.id);
  });

  it("refuses the previous tenant's tokens when it is not configured, for another client, or signed by another key", async () => {
    const off = new Client((await makeTestApp(IDP)).app);
    expect((await off.post("/api/auth/mobile/exchange", { idToken: await legacyToken({ sub: "auth0|x", email: "x@acme.io" }) })).status).toBe(401);
    const on = new Client((await makeTestApp({ ...IDP, ...LEGACY_ENV })).app);
    expect((await on.post("/api/auth/mobile/exchange", { idToken: await legacyToken({ sub: "auth0|x", email: "x@acme.io" }, "someone-else") })).status).toBe(401);
    // Claims the old issuer but is signed with the current tenant's key: the old tenant's keys refuse it.
    const forged = await idToken({ sub: "auth0|x", email: "x@acme.io" }, { iss: LEGACY_ISS, aud: "old-native" });
    expect((await on.post("/api/auth/mobile/exchange", { idToken: forged })).status).toBe(401);
  });

  it("reads the issuer only to pick the tenant", () => {
    expect(unverifiedIssuer("a.b")).toBeNull();
    expect(unverifiedIssuer("x")).toBeNull();
    const body = btoa(JSON.stringify({ iss: LEGACY_ISS })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(unverifiedIssuer(`h.${body}.s`)).toBe(LEGACY_ISS);
  });
});

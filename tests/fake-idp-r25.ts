import { vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { setJwksForTests } from "@/server/auth/tokens";
import { Client } from "./helpers";

/**
 * Round 25: a fake identity provider for the Google and Microsoft sign in tests. Discovery, JWKS and
 * a token endpoint that answers with whatever ID token the test set last. Same shape as the one in
 * tests/auth-idp.test.ts, on its own domain so the two never share keys.
 */
export const R25_DOMAIN = "multies-r25.au.auth0.com";
export const R25_ISS = `https://${R25_DOMAIN}/`;
export const R25_IDP = { AUTH0_DOMAIN: R25_DOMAIN, AUTH0_CLIENT_ID: "web-client", AUTH0_CLIENT_SECRET: "web-secret" };

export async function fakeIdpR25() {
  const kp = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: "r25", alg: "RS256", use: "sig" };
  setJwksForTests(R25_DOMAIN, createLocalJWKSet({ keys: [jwk] }) as never);
  const state = { idToken: undefined as string | undefined, tokenCalls: 0 };
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(R25_ISS)) return real(input, init);
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return json({ issuer: R25_ISS, authorization_endpoint: `${R25_ISS}authorize`, token_endpoint: `${R25_ISS}oauth/token`, userinfo_endpoint: `${R25_ISS}userinfo`, jwks_uri: `${R25_ISS}.well-known/jwks.json`, id_token_signing_alg_values_supported: ["RS256"] });
    }
    if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [jwk] });
    if (url.endsWith("/oauth/token")) { state.tokenCalls++; return json({ access_token: "at", id_token: state.idToken, token_type: "Bearer", expires_in: 3600, scope: "openid profile email" }); }
    if (url.endsWith("/userinfo")) return json({});
    return new Response("not found", { status: 404 });
  });
  const sign = async (claims: Record<string, unknown>) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "r25" })
      .setIssuer(R25_ISS).setAudience("web-client").setSubject(String(claims.sub))
      .setIssuedAt(now - 5).setExpirationTime(now + 600)
      .sign(kp.privateKey);
  };
  return { state, sign };
}

/**
 * Runs one web sign in through the provider: start with the given connection, answer the callback
 * with an ID token carrying `claims` (sub, email, email_verified), keep the cookies. Returns the
 * authorize URL, the callback response and the client.
 */
export async function socialSignIn(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  idp: Awaited<ReturnType<typeof fakeIdpR25>>,
  connection: string,
  claims: Record<string, unknown>,
) {
  const c = new Client(app as never);
  const start = await c.post("/api/auth/sign-in/social", { provider: "auth0", callbackURL: "/app/my-work", disableRedirect: true, ...(connection ? { additionalParams: { connection } } : {}) });
  const url = new URL(start.body.url);
  idp.state.idToken = await idp.sign({ ...claims, nonce: url.searchParams.get("nonce") });
  const cb = await app.request(`/api/auth/callback/auth0?code=abc&state=${encodeURIComponent(url.searchParams.get("state")!)}`, { headers: { host: "localhost", cookie: c.cookie } });
  for (const sc of cb.headers.getSetCookie()) { const [pair] = sc.split(";"); const i = pair.indexOf("="); c.jar.set(pair.slice(0, i), pair.slice(i + 1)); }
  return { url, cb, client: c };
}

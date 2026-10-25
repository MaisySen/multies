/**
 * Local E2E only: runs the Node entry with the identity provider switched on, and answers the
 * provider's discovery, JWKS and token endpoints in process, so the browser test can follow
 * the whole sign in without any network. The browser test intercepts the authorize page and
 * sends the nonce back inside the code, so the token endpoint can sign a matching ID token.
 */
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const DOMAIN = "idp.multies.test";
const ISS = `https://${DOMAIN}/`;
const kp = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(kp.publicKey)), kid: "e2e", alg: "RS256", use: "sig" };
const real = globalThis.fetch;
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith(ISS)) return real(input, init);
  if (url.endsWith("/.well-known/openid-configuration")) {
    return json({ issuer: ISS, authorization_endpoint: `${ISS}authorize`, token_endpoint: `${ISS}oauth/token`, userinfo_endpoint: `${ISS}userinfo`, jwks_uri: `${ISS}.well-known/jwks.json`, id_token_signing_alg_values_supported: ["RS256"] });
  }
  if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [jwk] });
  if (url.endsWith("/oauth/token")) {
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (!body.get("code_verifier")) return json({ error: "invalid_grant" });
    const { nonce, email } = JSON.parse(Buffer.from(body.get("code") ?? "", "base64url").toString("utf8")) as { nonce: string; email: string };
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ email, email_verified: true, name: "Pat Example", nonce })
      .setProtectedHeader({ alg: "RS256", kid: "e2e" }).setIssuer(ISS).setAudience("e2e-web").setSubject(`auth0|${email}`)
      .setIssuedAt(now).setExpirationTime(now + 600).sign(kp.privateKey);
    return json({ access_token: "e2e", id_token: idToken, token_type: "Bearer", expires_in: 600 });
  }
  if (url.endsWith("/userinfo")) return json({});
  return new Response("not found", { status: 404 });
}) as typeof fetch;

Object.assign(process.env, {
  AUTH0_DOMAIN: DOMAIN, AUTH0_CLIENT_ID: "e2e-web", AUTH0_CLIENT_SECRET: "e2e-secret",
  PORT: process.env.PORT ?? "8790", APP_URL: process.env.APP_URL ?? "http://localhost:8790",
});
await import("../../src/entry/node");

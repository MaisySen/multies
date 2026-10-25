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
    const { nonce, email, name } = JSON.parse(Buffer.from(body.get("code") ?? "", "base64url").toString("utf8")) as { nonce: string; email: string; name?: string };
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ email, email_verified: true, name: name ?? "Pat Example", nonce })
      .setProtectedHeader({ alg: "RS256", kid: "e2e" }).setIssuer(ISS).setAudience("e2e-web").setSubject(`auth0|${email}`)
      .setIssuedAt(now).setExpirationTime(now + 600).sign(kp.privateKey);
    return json({ access_token: "e2e", id_token: idToken, token_type: "Bearer", expires_in: 600 });
  }
  if (url.endsWith("/userinfo")) return json({});
  // The provider's public change password endpoint (DF-19 "Email me a reset link"); it answers the same for any address.
  if (url.endsWith("/dbconnections/change_password")) return new Response("We've just sent you an email to reset your password.", { status: 200 });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

Object.assign(process.env, {
  AUTH0_DOMAIN: DOMAIN, AUTH0_CLIENT_ID: "e2e-web", AUTH0_CLIENT_SECRET: "e2e-secret",
  PORT: process.env.PORT ?? "8790", APP_URL: process.env.APP_URL ?? "http://localhost:8790",
  // Free addresses on a made up shared domain (e2e/free-address.spec.ts).
  FREE_MAIL_DOMAIN: process.env.FREE_MAIL_DOMAIN ?? "free.multies.test",
});
await import("../../src/entry/node");

// The platform workspace's inbound key, so the spec can deliver mail for the shared domain through
// the real Email Worker code, as Cloudflare would. Written next to the database, local only.
{
  const { writeFileSync } = await import("node:fs");
  const { openSqlite } = await import("../../src/server/db/node");
  const { loadConfig } = await import("../../src/server/config");
  const { organizations } = await import("../../src/server/db/schema");
  const { createInboundKey } = await import("../../src/server/services/mail/inbound-keys");
  const db = openSqlite(process.env.DATABASE_PATH ?? ".data/mymail.db");
  await db.insert(organizations).values({ id: "org_platform", name: "Multies platform", slug: "mymail-platform" }).onConflictDoNothing();
  const key = await createInboundKey({ db, config: loadConfig(process.env) } as unknown as Parameters<typeof createInboundKey>[0], "org_platform");
  writeFileSync(`${process.env.DATABASE_PATH ?? ".data/mymail.db"}.platform-key.json`, JSON.stringify(key));
}

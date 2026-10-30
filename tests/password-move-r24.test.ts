import { describe, it, expect, vi, afterEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

/**
 * DF-19: sign in moved to a new identity tenant on 25 October 2026, so a password set before then
 * no longer works there. "Email me a reset link" asks the identity provider for a reset email.
 */
const IDP = { AUTH0_DOMAIN: "multies-test.au.auth0.com", AUTH0_CLIENT_ID: "web-client", AUTH0_CLIENT_SECRET: "web-secret" };

function stubIdp(status = 200) {
  const calls: { url: string; body?: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    return new Response("We've just sent you an email to reset your password.", { status });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("password reset link after the sign in move", () => {
  it("asks the identity provider to email a reset link for the password connection, answering the same for any address", async () => {
    const { app } = await makeTestApp(IDP);
    const calls = stubIdp();
    const c = new Client(app);
    const res = await c.post("/api/account/password-reset-link", { email: " Ada@Acme.io " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://multies-test.au.auth0.com/dbconnections/change_password");
    expect(JSON.parse(calls[0].body!)).toEqual({ client_id: "web-client", email: "ada@acme.io", connection: "Username-Password-Authentication" });
    // The provider answers 200 whether or not the address has an account; so do we.
    expect((await c.post("/api/account/password-reset-link", { email: "nobody@acme.io" })).body).toEqual({ ok: true });
  });

  it("checks the address, rate limits per address, and never sends the client secret", async () => {
    const { app } = await makeTestApp(IDP);
    const calls = stubIdp();
    const c = new Client(app);
    expect((await c.post("/api/account/password-reset-link", { email: "nope" })).status).toBe(422);
    for (let i = 0; i < 3; i++) expect((await c.post("/api/account/password-reset-link", { email: "a@acme.io" })).status).toBe(200);
    expect((await c.post("/api/account/password-reset-link", { email: "a@acme.io" })).status).toBe(429);
    expect(calls.every((x) => !x.body?.includes("web-secret"))).toBe(true);
  });

  it("says so plainly when the provider fails, and when this deployment has no identity provider", async () => {
    const { app } = await makeTestApp(IDP);
    stubIdp(500);
    const c = new Client(app);
    const failed = await c.post("/api/account/password-reset-link", { email: "b@acme.io" });
    expect(failed.status).toBe(502);
    expect(failed.body.error.message).toContain("Try again in a minute");
    const plain = await makeTestApp();
    const r = await new Client(plain.app).post("/api/account/password-reset-link", { email: "b@acme.io" });
    expect(r.status).toBe(503);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * DF-19: the new identity tenant checks a password it does not have yet against the old tenant
 * (Auth0 automatic migration). These run the two connection scripts the way Auth0 does, with a
 * fake old tenant behind fetch.
 */
class WrongUsernameOrPasswordError extends Error { constructor(public email: string) { super("wrong"); } }
const configuration = { OLD_DOMAIN: "old.example", OLD_PW_CLIENT_ID: "pw-id", OLD_PW_CLIENT_SECRET: "pw-secret", OLD_LOOKUP_CLIENT_ID: "lk-id", OLD_LOOKUP_CLIENT_SECRET: "lk-secret" };
type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

function load(file: string, name: string, fetchImpl: (url: string, init?: Call["init"]) => Promise<Response>) {
  const src = readFileSync(`deploy/auth0/legacy-migration/${file}`, "utf8");
  return new Function("configuration", "fetch", "WrongUsernameOrPasswordError", `${src}\nreturn ${name};`)(configuration, fetchImpl, WrongUsernameOrPasswordError) as (...args: unknown[]) => void;
}
const run = (fn: (...a: unknown[]) => void, ...args: unknown[]) => new Promise<{ err: unknown; user: unknown }>((resolve) => fn(...args, (err: unknown, user: unknown) => resolve({ err, user })));
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("login script", () => {
  it("keeps the person with their old id when the old tenant accepts the password", async () => {
    const calls: Call[] = [];
    const login = load("login.js", "login", async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth/token")) return res(200, { access_token: "at" });
      return res(200, { sub: "auth0|abc123", email: "pat@example.com", email_verified: true, name: "Pat" });
    });
    const out = await run(login, "pat@example.com", "s3cret-Pass");
    expect(out.err).toBeNull();
    expect(out.user).toMatchObject({ user_id: "abc123", email: "pat@example.com", email_verified: true, name: "Pat" });
    const body = JSON.parse(calls[0].init!.body!);
    expect(calls[0].url).toBe("https://old.example/oauth/token");
    expect(body).toMatchObject({ grant_type: "http://auth0.com/oauth/grant-type/password-realm", realm: "Username-Password-Authentication", username: "pat@example.com", password: "s3cret-Pass", client_id: "pw-id", client_secret: "pw-secret" });
    expect(calls[1]).toMatchObject({ url: "https://old.example/userinfo", init: { headers: { authorization: "Bearer at" } } });
  });

  it("answers wrong email or password when the old tenant refuses, and an error when it is down", async () => {
    const wrong = await run(load("login.js", "login", async () => res(403, { error: "invalid_grant" })), "pat@example.com", "nope");
    expect(wrong.err).toBeInstanceOf(WrongUsernameOrPasswordError);
    const down = await run(load("login.js", "login", async () => res(503, {})), "pat@example.com", "x");
    expect(down.err).toBeInstanceOf(Error);
    expect(down.err).not.toBeInstanceOf(WrongUsernameOrPasswordError);
    const thrown = await run(load("login.js", "login", async () => { throw new Error("network"); }), "pat@example.com", "x");
    expect((thrown.err as Error).message).toBe("network");
  });
});

describe("get_user script", () => {
  it("finds a password person on the old tenant by email, with their old id", async () => {
    const calls: Call[] = [];
    const getUser = load("get_user.js", "getByEmail", async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth/token")) return res(200, { access_token: "mgmt" });
      return res(200, [
        { user_id: "google-oauth2|1", email: "pat@example.com", identities: [{ connection: "google-oauth2" }] },
        { user_id: "auth0|abc123", email: "pat@example.com", email_verified: false, name: "Pat", identities: [{ connection: "Username-Password-Authentication" }] },
      ]);
    });
    const out = await run(getUser, "pat+x@example.com");
    expect(out.user).toMatchObject({ user_id: "abc123", email: "pat@example.com", email_verified: false });
    expect(JSON.parse(calls[0].init!.body!)).toMatchObject({ grant_type: "client_credentials", client_id: "lk-id", audience: "https://old.example/api/v2/" });
    expect(calls[1].url).toBe("https://old.example/api/v2/users-by-email?email=pat%2Bx%40example.com");
  });

  it("answers not found when nobody matches, or when the old tenant can't be reached, so sign up never breaks", async () => {
    const none = await run(load("get_user.js", "getByEmail", async (url) => (url.endsWith("/oauth/token") ? res(200, { access_token: "m" }) : res(200, []))), "new@example.com");
    expect(none).toEqual({ err: null, user: undefined });
    const social = await run(load("get_user.js", "getByEmail", async (url) => (url.endsWith("/oauth/token") ? res(200, { access_token: "m" }) : res(200, [{ user_id: "google-oauth2|1", identities: [{ connection: "google-oauth2" }] }]))), "g@example.com");
    expect(social.user).toBeUndefined();
    const down = await run(load("get_user.js", "getByEmail", async () => res(500, {})), "x@example.com");
    expect(down).toEqual({ err: null, user: undefined });
  });
});

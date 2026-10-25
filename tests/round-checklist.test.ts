import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { accounts, users } from "@/server/db/schema";
import { resetAuth0TokenCache } from "@/server/services/auth0-management";

const MGMT = { AUTH0_DOMAIN: "multies-test.us.auth0.com", AUTH0_MGMT_CLIENT_ID: "mgmt-id", AUTH0_MGMT_CLIENT_SECRET: "mgmt-secret" };

/** Stubs the Auth0 token and Management API; records every call. */
function stubAuth0(handler: (method: string, url: string, body?: string) => Response | undefined = () => undefined) {
  const calls: { method: string; url: string; body?: string }[] = [];
  resetAuth0TokenCache();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, body });
    const custom = handler(method, url, body);
    if (custom) return custom;
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: "tok", expires_in: 86400 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({});
  });
  return calls;
}

/** A person who signs in only through Auth0: no password account, one auth0 account. */
async function auth0Person(env: Record<string, string> = MGMT) {
  const ctx = await makeTestApp(env);
  const c = new Client(ctx.app);
  await c.signup("idp@acme.io");
  const u = (await ctx.db.select().from(users).where(eq(users.email, "idp@acme.io")).get())!;
  await ctx.db.update(accounts).set({ providerId: "auth0", accountId: "auth0|idp1", password: null }).where(eq(accounts.userId, u.id));
  return { ...ctx, c, userId: u.id };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("delete my account as an Auth0 person", () => {
  it("needs no password, removes the Auth0 login, then deletes the account", async () => {
    const ctx = await auth0Person();
    expect((await ctx.c.get("/api/account/me")).body.hasPassword).toBe(false);
    const calls = stubAuth0();
    const res = await ctx.c.call("DELETE", "/api/account", { confirm: "DELETE" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deletedWorkspaces: 1 });
    expect(calls.some((x) => x.method === "DELETE" && x.url === "https://multies-test.us.auth0.com/api/v2/users/auth0%7Cidp1")).toBe(true);
    expect(await ctx.db.select().from(users).where(eq(users.id, ctx.userId)).get()).toBeUndefined();
  });

  it("deletes nothing and says so when Auth0 refuses", async () => {
    const ctx = await auth0Person();
    stubAuth0((m) => (m === "DELETE" ? new Response("boom", { status: 500 }) : undefined));
    const res = await ctx.c.call("DELETE", "/api/account", { confirm: "DELETE" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("idp_delete_failed");
    expect(res.body.error.message).toMatch(/nothing was deleted/);
    expect(await ctx.db.select().from(users).where(eq(users.id, ctx.userId)).get()).toBeTruthy();
  });

  it("asks for a fresh sign in when the session is old, before touching Auth0", async () => {
    const ctx = await auth0Person();
    const calls = stubAuth0();
    ctx.deps.now = () => new Date(Date.now() + 60 * 60_000);
    const res = await ctx.c.call("DELETE", "/api/account", { confirm: "DELETE" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("reauth_required");
    expect(calls.filter((x) => x.method === "DELETE")).toHaveLength(0);
    expect(await ctx.db.select().from(users).where(eq(users.id, ctx.userId)).get()).toBeTruthy();
  });

  it("a password person still reports hasPassword", async () => {
    const { app } = await makeTestApp();
    const c = new Client(app);
    await c.signup("pw@acme.io");
    expect((await c.get("/api/account/me")).body.hasPassword).toBe(true);
  });
});

describe("resend the verification email", () => {
  it("finds the unverified Auth0 password account and starts a verification job, answering the same either way", async () => {
    const { app } = await makeTestApp(MGMT);
    const calls = stubAuth0((_m, url) => (url.includes("/users-by-email")
      ? Response.json([{ user_id: "auth0|new1", email_verified: false, identities: [{ provider: "auth0", connection: "Username-Password-Authentication", user_id: "new1" }] }])
      : undefined));
    const c = new Client(app);
    const res = await c.post("/api/account/resend-verification", { email: "New@Acme.io" });
    expect(res.status).toBe(200);
    expect(calls.some((x) => x.url.includes("users-by-email?email=new%40acme.io"))).toBe(true);
    const job = calls.find((x) => x.url.endsWith("/jobs/verification-email"));
    expect(JSON.parse(job!.body!)).toMatchObject({ user_id: "auth0|new1" });
    stubAuth0((_m, url) => (url.includes("/users-by-email") ? Response.json([]) : undefined));
    expect((await c.post("/api/account/resend-verification", { email: "nobody@acme.io" })).status).toBe(200);
  });

  it("checks the address and rate limits", async () => {
    const { app } = await makeTestApp(MGMT);
    stubAuth0((_m, url) => (url.includes("/users-by-email") ? Response.json([]) : undefined));
    const c = new Client(app);
    expect((await c.post("/api/account/resend-verification", { email: "nope" })).status).toBe(422);
    for (let i = 0; i < 3; i++) expect((await c.post("/api/account/resend-verification", { email: "a@acme.io" })).status).toBe(200);
    expect((await c.post("/api/account/resend-verification", { email: "a@acme.io" })).status).toBe(429);
  });
});

describe("contact form", () => {
  it("sends the message to the support address with Reply-To set to the visitor", async () => {
    const { app, outbound } = await makeTestApp({ SUPPORT_EMAIL: "contact@fintex.au" });
    const c = new Client(app);
    const res = await c.post("/api/contact", { name: "Ada", email: "Ada@Acme.io", company: "Acme", message: "We'd like a demo for six people." });
    expect(res.status).toBe(200);
    const sent = outbound.sent.at(-1)!;
    expect(sent.to).toEqual(["contact@fintex.au"]);
    expect(sent.replyTo).toBe("ada@acme.io");
    expect(sent.subject).toBe("Contact form: Ada");
    expect(sent.text).toContain("We'd like a demo for six people.");
  });

  it("answers field errors for bad input", async () => {
    const { app, outbound } = await makeTestApp();
    const c = new Client(app);
    const res = await c.post("/api/contact", { name: "", email: "not-an-email", message: "hi" });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.details?.fields ?? {}).sort()).toEqual(["email", "message", "name"]);
    expect(outbound.sent).toHaveLength(0);
  });

  it("quietly drops a filled honeypot and rate limits by network", async () => {
    const { app, outbound } = await makeTestApp();
    const c = new Client(app);
    expect((await c.post("/api/contact", { name: "Bot", email: "bot@spam.io", message: "Buy cheap things now", website: "http://spam" })).status).toBe(200);
    expect(outbound.sent).toHaveLength(0);
    for (let i = 0; i < 5; i++) expect((await c.post("/api/contact", { name: "Ada", email: "ada@acme.io", message: "A real question here." })).status).toBe(200);
    expect((await c.post("/api/contact", { name: "Ada", email: "ada@acme.io", message: "A real question here." })).status).toBe(429);
  });
});

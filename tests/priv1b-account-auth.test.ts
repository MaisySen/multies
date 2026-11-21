/**
 * PRIV1b batch "account-auth": P37 (account mail through the workspace's own domain), P41 (Require SSO through an
 * OAuth grant), P48 (recovery ends OAuth grants; banned people's tokens and keys stop), P49 (Better Auth delete-user
 * closed over HTTP), P70 (OAuth code exchange race and refresh token reuse). Mobile web link items: priv1b-account-auth-link.test.ts.
 */
import { describe, it, expect } from "vitest";
import { and, eq, isNull, like } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { makeTestApp, Client } from "./helpers";
import { authFor } from "@/server/auth/options";
import { auditLogs, domains, mailboxes, messages, notifications, oauthGrants, organizations, sessions, users, verifications } from "@/server/db/schema";
import { pkceChallenge } from "@/server/services/developer/oauth";

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
const verifier = "v".repeat(20) + "-verifier-for-pkce-tests-0123456789";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const form = (app: App, p: Record<string, string>) => app.request("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost" }, body: new URLSearchParams(p).toString() });

async function clientId(app: App) {
  const reg = await app.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
  return ((await reg.json()) as { client_id: string }).client_id;
}
async function approveFor(c: Client, cid: string, orgId?: string) {
  const request = { client_id: cid, redirect_uri: REDIRECT, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "s", scope: "mcp:read mcp:write" };
  return c.post("/api/oauth/authorize", { decision: "allow", scope: "full", request, ...(orgId ? { orgId } : {}) });
}
const codeOf = (r: { body: { redirectTo: string } }) => new URL(r.body.redirectTo).searchParams.get("code")!;
async function exchange(app: App, cid: string, code: string) {
  return form(app, { grant_type: "authorization_code", code, client_id: cid, redirect_uri: REDIRECT, code_verifier: verifier });
}
async function connect(app: App, c: Client, orgId?: string) {
  const cid = await clientId(app);
  const a = await approveFor(c, cid, orgId);
  expect(a.status).toBe(200);
  const tr = await exchange(app, cid, codeOf(a));
  expect(tr.status).toBe(200);
  return { cid, ...((await tr.json()) as { access_token: string; refresh_token: string }) };
}
const refresh = (app: App, cid: string, rt: string) => form(app, { grant_type: "refresh_token", refresh_token: rt, client_id: cid });
const mcp = (app: App, token: string) => app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });

describe("PRIV1b (P37): account mail through the workspace's own domain", () => {
  it("an alias at a colleague's sign in address is refused, in the app and over v1; other aliases still work", async () => {
    const w = await privacyWorld();
    const pat = `pat${w.n}@acme.io`;
    const r = await w.admin.c.post("/api/aliases", { domainId: w.domainId, localPart: `pat${w.n}`, destinations: [`ada${w.n}@acme.io`] });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain("sign in address");
    const o = await w.owner.post("/api/aliases", { domainId: w.domainId, localPart: `pat${w.n}`, destinations: [`olive${w.n}@acme.io`] });
    expect(o.status).toBe(409);
    expect(await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.address, pat)).get()).toBeFalsy();
    const key = (await w.owner.post("/api/developer/keys", { name: "k", scope: "full" })).body;
    const secret = (key.secret ?? key.key?.secret) as string;
    expect(secret).toMatch(/^mm_live_/);
    const v1 = await w.ctx.app.request("/api/v1/aliases", { method: "POST", headers: { host: "localhost", "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ domainId: w.domainId, localPart: `pat${w.n}`, destinations: [`olive${w.n}@acme.io`] }) });
    expect(v1.status).toBe(409);
    const ok = await w.admin.c.post("/api/aliases", { domainId: w.domainId, localPart: `sales${w.n}`, destinations: [`ada${w.n}@acme.io`] });
    expect(ok.status).toBe(201);
  });

  it("a password reset never reaches a catch all; it does reach the person's own mailbox", async () => {
    const w = await privacyWorld();
    const adaBox = (await w.admin.c.post("/api/mailboxes", { domainId: w.domainId, localPart: `ada${w.n}`, displayName: "Ada" })).body.mailbox.id as string;
    await w.ctx.db.update(domains).set({ catchAllMailboxId: adaBox }).where(eq(domains.id, w.domainId));
    const anon = new Client(w.ctx.app);
    const rq = await anon.call("POST", "/api/auth/request-password-reset", { email: `pat${w.n}@acme.io`, redirectTo: "/reset-password" }, { "cf-connecting-ip": "203.0.113.61" });
    expect(rq.status).toBe(200);
    const caught = await w.ctx.db.select().from(messages).where(eq(messages.mailboxId, adaBox)).all();
    expect(caught.length).toBe(0);
    // Legitimate: Olive's own mailbox at her sign in address gets her reset mail inside the platform.
    const oliveBox = (await w.owner.post("/api/mailboxes", { domainId: w.domainId, localPart: `olive${w.n}`, displayName: "Olive" })).body.mailbox.id as string;
    await anon.call("POST", "/api/auth/request-password-reset", { email: `olive${w.n}@acme.io`, redirectTo: "/reset-password" }, { "cf-connecting-ip": "203.0.113.62" });
    const own = await w.ctx.db.select({ subject: messages.subject }).from(messages).where(eq(messages.mailboxId, oliveBox)).all();
    expect(own.some((m) => /reset/i.test(m.subject ?? ""))).toBe(true);
    expect((await w.ctx.db.select().from(messages).where(eq(messages.mailboxId, adaBox)).all()).length).toBe(0);
  });

  it("a mailbox at a colleague's sign in address tells that colleague and writes an audit row; their own or a team address does not", async () => {
    const w = await privacyWorld();
    const mk = await w.admin.c.post("/api/mailboxes", { domainId: w.domainId, localPart: `pat${w.n}`, displayName: "Pat" });
    expect(mk.status).toBe(201);
    const box = mk.body.mailbox.id as string;
    const note = await w.ctx.db.select().from(notifications).where(and(eq(notifications.userId, w.pat.id), eq(notifications.type, "security.mailbox_at_login"))).all();
    expect(note.length).toBe(1);
    expect(note[0].entityId).toBe(box);
    expect(note[0].title).toContain(`pat${w.n}@acme.io`);
    const listed = await w.pat.c.get("/api/notifications");
    expect(JSON.stringify(listed.body)).toContain("sign in address");
    const row = await w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, w.orgId), eq(auditLogs.action, "mailbox.created_at_member_login"))).get();
    expect(row?.targetId).toBe(box);
    expect(row?.actorUserId).toBe(w.admin.id);
    // A plain team address and a person's own address raise nothing.
    expect((await w.admin.c.post("/api/mailboxes", { domainId: w.domainId, localPart: `ops${w.n}`, displayName: "Ops" })).status).toBe(201);
    expect((await w.owner.post("/api/mailboxes", { domainId: w.domainId, localPart: `olive${w.n}`, displayName: "Olive" })).status).toBe(201);
    const all = await w.ctx.db.select().from(notifications).where(eq(notifications.type, "security.mailbox_at_login")).all();
    expect(all.length).toBe(1);
  });

  it("the notice reaches the member even with status updates turned off", async () => {
    const w = await privacyWorld();
    expect((await w.pat.c.put("/api/notifications/settings", { settings: { status: { inApp: false, push: false } } })).status).toBe(200);
    expect((await w.admin.c.post("/api/mailboxes", { domainId: w.domainId, localPart: `pat${w.n}`, displayName: "Pat" })).status).toBe(201);
    const note = await w.ctx.db.select().from(notifications).where(and(eq(notifications.userId, w.pat.id), eq(notifications.type, "security.mailbox_at_login"))).all();
    expect(note.length).toBe(1);
  });

  it("an agent inbox at a member's sign in address is refused; other agent addresses still work", async () => {
    const w = await privacyWorld();
    const r = await w.admin.c.post("/api/agents", { name: "Pat bot", localPart: `pat${w.n}` });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain("sign in address");
    expect(await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.address, `pat${w.n}@acme.io`)).get()).toBeFalsy();
    // Not even the member herself: an agent inbox is never a person's mailbox.
    expect((await w.owner.post("/api/agents", { name: "Olive bot", localPart: `olive${w.n}` })).status).toBe(409);
    const ok = await w.admin.c.post("/api/agents", { name: "Helper", localPart: `helper${w.n}` });
    expect(ok.status).toBe(201);
    expect(ok.body.agent.address).toBe(`helper${w.n}@acme.io`);
  });
});

describe("PRIV1b (P41): Require SSO holds for OAuth grants", () => {
  it("a password session cannot approve an app for an SSO workspace; the owner and an SSO session can", async () => {
    const w = await privacyWorld();
    const app = w.ctx.app;
    await w.ctx.db.update(organizations).set({ requireSso: true }).where(eq(organizations.id, w.orgId));
    expect((await w.member.c.get(`/api/mail/messages?mailboxId=${w.boxes.team}&folder=inbox`)).status).toBe(403);
    // The bypass: a side workspace becomes active, then the grant names the SSO workspace.
    expect((await w.member.c.post("/api/account/workspaces", { name: "Side" })).status).toBeLessThan(300);
    const cid = await clientId(app);
    const a = await approveFor(w.member.c, cid, w.orgId);
    expect(a.status).toBe(403);
    expect(a.body.error.code).toBe("sso_required");
    // The consent screen says so before Allow.
    const q = new URLSearchParams({ client_id: cid, redirect_uri: REDIRECT, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "s", scope: "mcp:read mcp:write" });
    const consent = await w.member.c.get(`/api/oauth/authorize?${q}`);
    expect(consent.status).toBe(200);
    const listed = consent.body.workspaces as { id: string; ssoRequired: boolean }[];
    expect(listed.find((x) => x.id === w.orgId)?.ssoRequired).toBe(true);
    expect(listed.some((x) => x.id !== w.orgId && x.ssoRequired === false)).toBe(true);
    expect(((await w.owner.get(`/api/oauth/authorize?${q}`)).body.workspaces as { id: string; ssoRequired: boolean }[]).find((x) => x.id === w.orgId)?.ssoRequired).toBe(false);
    expect(await w.ctx.db.select().from(oauthGrants).where(eq(oauthGrants.userId, w.member.id)).get()).toBeFalsy();
    // The owner is the break glass account.
    expect((await approveFor(w.owner, cid, w.orgId)).status).toBe(200);
    // A member signed in through SSO still connects apps.
    await w.ctx.db.update(sessions).set({ loginMethod: "google" }).where(eq(sessions.userId, w.admin.id));
    const viaSso = await approveFor(w.admin.c, cid, w.orgId);
    expect(viaSso.status).toBe(200);
    const tr = await exchange(app, cid, codeOf(viaSso));
    const tok = ((await tr.json()) as { access_token: string }).access_token;
    expect((await mcp(app, tok)).status).toBe(200);
  });

  it("turning enforcement on ends grants made before it, except the owner's", async () => {
    const w = await privacyWorld();
    const app = w.ctx.app;
    const maxT = await connect(app, w.member.c);
    const oliveT = await connect(app, w.owner);
    expect((await mcp(app, maxT.access_token)).status).toBe(200);
    (w.ctx.deps.config.auth.social as Record<string, unknown>).google = { clientId: "g", clientSecret: "s" };
    const on = await w.owner.put("/api/org/sso", { required: true });
    expect(on.status).toBe(200);
    expect((await mcp(app, maxT.access_token)).status).toBe(401);
    expect((await refresh(app, maxT.cid, maxT.refresh_token)).status).toBe(400);
    expect((await mcp(app, oliveT.access_token)).status).toBe(200);
  });
});

describe("PRIV1b (P48): recovery ends OAuth grants; a ban stops tokens and keys", () => {
  it("change password ends the person's apps", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("victim1@acme.io");
    const t = await connect(ctx.app, c);
    expect((await mcp(ctx.app, t.access_token)).status).toBe(200);
    const cp = await c.post("/api/auth/change-password", { currentPassword: "a-strong-password", newPassword: "new-strong-pass-2", revokeOtherSessions: true });
    expect(cp.status).toBe(200);
    expect((await mcp(ctx.app, t.access_token)).status).toBe(401);
    expect((await refresh(ctx.app, t.cid, t.refresh_token)).status).toBe(400);
    // The person can connect again afterwards.
    const again = await connect(ctx.app, c);
    expect((await mcp(ctx.app, again.access_token)).status).toBe(200);
  });

  it("sign out everywhere ends the person's apps, and only theirs", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("victim2@acme.io");
    const other = new Client(ctx.app);
    await other.signup("bystander2@acme.io");
    const t = await connect(ctx.app, c);
    const o = await connect(ctx.app, other);
    expect((await c.post("/api/auth/revoke-sessions", {})).status).toBe(200);
    expect((await mcp(ctx.app, t.access_token)).status).toBe(401);
    expect((await mcp(ctx.app, o.access_token)).status).toBe(200);
  });

  it("signing out other sessions ends the person's apps", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("victim4@acme.io");
    const t = await connect(ctx.app, c);
    expect((await c.post("/api/auth/revoke-other-sessions", {})).status).toBe(200);
    expect((await mcp(ctx.app, t.access_token)).status).toBe(401);
    expect((await refresh(ctx.app, t.cid, t.refresh_token)).status).toBe(400);
    expect((await c.get("/api/account/me")).status).toBe(200);
  });

  it("a platform admin's ban through the admin endpoint ends the person's apps", async () => {
    const ctx = await makeTestApp();
    const ops = new Client(ctx.app);
    await ops.signup("ops-ban@acme.io");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops-ban@acme.io"));
    const c = new Client(ctx.app);
    await c.signup("victim5@acme.io");
    const bystander = new Client(ctx.app);
    await bystander.signup("bystander5@acme.io");
    const t = await connect(ctx.app, c);
    const o = await connect(ctx.app, bystander);
    const id = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, "victim5@acme.io")).get())!.id;
    // OPS1: /api/auth/admin/* is closed over HTTP; the console bans through Better Auth in process, which runs the same hook.
    expect((await ops.post("/api/auth/admin/ban-user", { userId: id })).status).toBe(404);
    await authFor(ctx.deps).api.banUser({ headers: new Headers({ cookie: ops.cookie }), body: { userId: id } });
    expect(await ctx.db.select().from(oauthGrants).where(and(eq(oauthGrants.userId, id), isNull(oauthGrants.revokedAt))).get()).toBeFalsy();
    // Lifting the ban does not bring the old grant back.
    await ctx.db.update(users).set({ banned: false }).where(eq(users.id, id));
    expect((await refresh(ctx.app, t.cid, t.refresh_token)).status).toBe(400);
    expect((await mcp(ctx.app, o.access_token)).status).toBe(200);
  });

  it("a password reset ends the person's apps", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("victim3@acme.io");
    const t = await connect(ctx.app, c);
    const anon = new Client(ctx.app);
    expect((await anon.call("POST", "/api/auth/request-password-reset", { email: "victim3@acme.io", redirectTo: "/reset-password" }, { "cf-connecting-ip": "203.0.113.71" })).status).toBe(200);
    const v = await ctx.db.select().from(verifications).where(like(verifications.identifier, "reset-password:%")).get();
    const token = v!.identifier.slice("reset-password:".length);
    const rs = await anon.call("POST", "/api/auth/reset-password", { token, newPassword: "fresh-strong-pass-3" }, { "cf-connecting-ip": "203.0.113.72" });
    expect(rs.status).toBe(200);
    expect((await mcp(ctx.app, t.access_token)).status).toBe(401);
    expect((await refresh(ctx.app, t.cid, t.refresh_token)).status).toBe(400);
  });

  it("a banned person's OAuth token and API key stop working; unbanned they work", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("banme@acme.io");
    const t = await connect(ctx.app, c);
    const key = (await c.post("/api/developer/keys", { name: "k", scope: "full" })).body;
    const secret = (key.secret ?? key.key?.secret) as string;
    expect(secret).toMatch(/^mm_live_/);
    const v1 = () => ctx.app.request("/api/v1/mailboxes", { headers: { host: "localhost", authorization: `Bearer ${secret}` } });
    expect((await v1()).status).toBe(200);
    expect((await mcp(ctx.app, t.access_token)).status).toBe(200);
    await ctx.db.update(users).set({ banned: true }).where(eq(users.email, "banme@acme.io"));
    expect((await mcp(ctx.app, t.access_token)).status).toBe(401);
    expect((await v1()).status).toBe(401);
    // An expired ban no longer counts.
    await ctx.db.update(users).set({ banExpires: new Date(Date.now() - 60_000) }).where(eq(users.email, "banme@acme.io"));
    expect((await v1()).status).toBe(200);
    expect((await mcp(ctx.app, t.access_token)).status).toBe(200);
  });
});

describe("PRIV1b (P49): account deletion needs the password", () => {
  it("POST /api/auth/delete-user is closed over HTTP; DELETE /api/account with the password still deletes", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("pw@acme.io");
    const r = await c.post("/api/auth/delete-user", {});
    expect(r.status).toBe(404);
    expect((await c.post("/api/auth/delete-user/", {})).status).toBe(404);
    expect(await ctx.db.select().from(users).where(eq(users.email, "pw@acme.io")).get()).toBeTruthy();
    const noPw = await c.call("DELETE", "/api/account", { confirm: "DELETE" });
    expect(noPw.status).toBe(400);
    expect(noPw.body.error.code).toBe("password_required");
    const ok = await c.call("DELETE", "/api/account", { confirm: "DELETE", password: "a-strong-password" });
    expect(ok.status).toBe(200);
    expect(await ctx.db.select().from(users).where(eq(users.email, "pw@acme.io")).get()).toBeFalsy();
  });
});

describe("PRIV1b (P70): OAuth code and refresh token reuse", () => {
  it("two racing exchanges of one code never both get tokens", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("race@acme.io");
    const cid = await clientId(ctx.app);
    const code = codeOf(await approveFor(c, cid));
    const [a, b] = await Promise.all([exchange(ctx.app, cid, code), exchange(ctx.app, cid, code)]);
    const ok = [a, b].filter((r) => r.status === 200);
    expect(ok.length).toBeLessThanOrEqual(1);
    expect([a, b].some((r) => r.status === 400)).toBe(true);
    // Whatever the first got, the grant is ended: a code used twice may be stolen.
    for (const r of ok) {
      const t = (await r.json()) as { access_token: string };
      expect((await mcp(ctx.app, t.access_token)).status).toBe(401);
    }
  });

  it("replaying a rotated refresh token ends the grant; normal rotation keeps working", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("rot@acme.io");
    const t = await connect(ctx.app, c);
    const r1 = await refresh(ctx.app, t.cid, t.refresh_token);
    expect(r1.status).toBe(200);
    const t1 = (await r1.json()) as { access_token: string; refresh_token: string };
    const r2 = await refresh(ctx.app, t.cid, t1.refresh_token);
    expect(r2.status).toBe(200);
    const t2 = (await r2.json()) as { access_token: string; refresh_token: string };
    expect((await mcp(ctx.app, t2.access_token)).status).toBe(200);
    // The old token comes back (a stolen copy): refused, and the live chain ends too.
    const replay = await refresh(ctx.app, t.cid, t.refresh_token);
    expect(replay.status).toBe(400);
    expect((await refresh(ctx.app, t.cid, t2.refresh_token)).status).toBe(400);
    expect((await mcp(ctx.app, t2.access_token)).status).toBe(401);
  });
});

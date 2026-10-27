import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, sessions, users } from "@/server/db/schema";
import { clearAuthCache } from "@/server/auth/guards";
import { workspaceMark, workspaceMarkCookie, WORKSPACE_MARK_COOKIE } from "@/server/auth/workspace-mark";
import { fakeIdpR25, R25_IDP, socialSignIn } from "./fake-idp-r25";

/*
 * Multiws (27 Oct 2026): one account in several workspaces. The owner reported that he could not get into his
 * other workspaces: a new sign in opened the workspace he had joined last, the phone app had no switcher, and on
 * the web a failed switch said nothing while a read cached in another isolate could still show the old workspace.
 */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => { ctx = await makeTestApp(); clearAuthCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

const tokenOf = (link: string) => link.split("/invite/")[1];
const orgName = async (c: Client) => (await c.get("/api/account/me")).body.organization?.name as string | undefined;

/** One person in three workspaces: their own (Acme), one they were invited to (Beta), one they made (Gamma). */
async function personInThree(app = ctx) {
  const boss = new Client(app.app);
  await boss.signup("boss@beta.io", "Bea Boss", "Beta");
  const me = new Client(app.app);
  await me.signup("Multi@acme.io", "Mo Multi", "Acme");
  const inv = await boss.post("/api/team/invites", { email: "multi@acme.io", role: "admin" });
  expect(inv.status).toBe(201);
  const acc = await me.post(`/api/invites/${tokenOf(inv.body.link)}/accept`);
  expect(acc.status).toBe(200);
  const made = await me.post("/api/account/workspaces", { name: "Gamma" });
  expect(made.status).toBe(201);
  const list = (await me.get("/api/account/workspaces")).body.workspaces as { id: string; name: string }[];
  const id = (n: string) => list.find((w) => w.name === n)!.id;
  return { boss, me, list, acme: id("Acme"), beta: id("Beta"), gamma: id("Gamma") };
}

describe("multiws: one account in several workspaces", () => {
  it("lists every workspace and switches each way, answering the workspace it opened", async () => {
    const { me, list, acme, beta, gamma } = await personInThree();
    expect(list.map((w) => w.name).sort()).toEqual(["Acme", "Beta", "Gamma"]);
    expect(await orgName(me)).toBe("Gamma");
    for (const [id, name] of [[acme, "Acme"], [beta, "Beta"], [gamma, "Gamma"], [beta, "Beta"], [acme, "Acme"]] as const) {
      const r = await me.post(`/api/account/workspaces/${id}/switch`);
      expect(r.status).toBe(200);
      expect(r.body.workspace).toMatchObject({ id, name });
      expect(await orgName(me)).toBe(name);
    }
  });

  it("refuses a workspace the person is not in and stays where they were", async () => {
    const { boss } = await personInThree();
    const other = new Client(ctx.app);
    await other.signup("other@zed.io", "Zed", "Zed");
    const bossOrg = (await boss.get("/api/account/me")).body.organization.id;
    const r = await other.post(`/api/account/workspaces/${bossOrg}/switch`);
    expect(r.status).toBe(404);
    expect(await orgName(other)).toBe("Zed");
  });

  it("a new sign in, on any device, opens the workspace switched to last", async () => {
    const { me, acme, beta } = await personInThree();
    await me.post(`/api/account/workspaces/${acme}/switch`);
    const phone = new Client(ctx.app);
    expect((await phone.login("multi@acme.io")).status).toBe(200);
    expect(await orgName(phone)).toBe("Acme");
    // Switching on the phone moves the next sign in too; the first device keeps its own choice.
    expect((await phone.post(`/api/account/workspaces/${beta}/switch`)).status).toBe(200);
    const laptop = new Client(ctx.app);
    await laptop.login("MULTI@acme.io");
    expect(await orgName(laptop)).toBe("Beta");
    expect(await orgName(me)).toBe("Acme");
  });

  it("records each switch in the workspace's activity log", async () => {
    const { me, acme, beta } = await personInThree();
    await me.post(`/api/account/workspaces/${acme}/switch`);
    await me.post(`/api/account/workspaces/${acme}/switch`); // already there: no second row
    await me.post(`/api/account/workspaces/${beta}/switch`);
    const rows = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "workspace.switched"));
    expect(rows.map((r) => r.orgId).sort()).toEqual([acme, beta].sort());
  });

  it("sets a fresh workspace mark on switch, join and create", async () => {
    const { me, acme } = await personInThree();
    const before = me.jar.get(WORKSPACE_MARK_COOKIE);
    expect(before).toBeTruthy(); // from creating Gamma
    await new Promise((r) => setTimeout(r, 2));
    await me.post(`/api/account/workspaces/${acme}/switch`);
    const after = me.jar.get(WORKSPACE_MARK_COOKIE);
    expect(after).toMatch(new RegExp(`^${acme}\\.`));
    expect(after).not.toBe(before);
  });

  it("a read cached before a switch made in another isolate is not served after it", async () => {
    const { me, acme, beta } = await personInThree();
    await me.post(`/api/account/workspaces/${acme}/switch`);
    // A plain read fills this isolate's cache for the session.
    expect((await me.get("/api/projects")).status).toBe(200);
    expect(await orgName(me)).toBe("Acme");
    // Another isolate handles the switch: the session row moves and the browser gets a new mark,
    // but this isolate's memory never hears about it.
    const token = decodeURIComponent(me.jar.get("mymail.session_token")!).split(".")[0];
    await ctx.db.update(sessions).set({ activeOrganizationId: beta }).where(eq(sessions.token, token));
    me.jar.set(WORKSPACE_MARK_COOKIE, `${beta}.other-isolate`);
    expect(await orgName(me)).toBe("Beta");
    const projects = await me.get("/api/projects");
    expect(projects.status).toBe(200);
  });

  it("joining a workspace by invite opens it and the old one is one switch away", async () => {
    const { me, acme } = await personInThree();
    await me.post(`/api/account/workspaces/${acme}/switch`);
    const third = new Client(ctx.app);
    await third.signup("ceo@delta.io", "Dee", "Delta");
    const inv = await third.post("/api/team/invites", { email: "multi@acme.io", role: "member" });
    expect((await me.post(`/api/invites/${tokenOf(inv.body.link)}/accept`)).status).toBe(200);
    expect(await orgName(me)).toBe("Delta");
    expect(((await me.get("/api/account/workspaces")).body.workspaces as unknown[]).length).toBe(4);
    expect((await me.post(`/api/account/workspaces/${acme}/switch`)).status).toBe(200);
    expect(await orgName(me)).toBe("Acme");
  });
});

describe("multiws: Google and email sign in for the same address", () => {
  it("both land on the one person, see every workspace and can switch both ways", async () => {
    const idp = await fakeIdpR25();
    const app = await makeTestApp({ ...R25_IDP, APP_URL: "http://localhost", AUTH_LOCAL_PASSWORD: "on", AUTH0_SOCIAL_CONNECTIONS: "google-oauth2" });
    clearAuthCache();
    const { me, acme, beta } = await personInThree(app);
    const person = (await app.db.select().from(users).where(eq(users.email, "multi@acme.io")).get())!;
    await app.db.update(users).set({ emailVerified: true }).where(eq(users.id, person.id));
    await me.post(`/api/account/workspaces/${beta}/switch`);

    // Google, with the capital letters the person might type.
    const g = await socialSignIn(app.app, idp, "google-oauth2", { sub: "google-oauth2|multi", email: "Multi@Acme.io", email_verified: true, name: "Mo Multi" });
    expect(g.cb.status).toBe(302);
    const gMe = await g.client.get("/api/account/me");
    expect(gMe.body.user.id).toBe(person.id);
    expect(gMe.body.organization.name).toBe("Beta");
    expect(((await g.client.get("/api/account/workspaces")).body.workspaces as unknown[]).length).toBe(3);
    expect((await g.client.post(`/api/account/workspaces/${acme}/switch`)).status).toBe(200);
    expect(await orgName(g.client)).toBe("Acme");

    // The email and password sign in afterwards is the same person and opens Acme, then switches back.
    const pw = new Client(app.app);
    expect((await pw.login("multi@acme.io")).status).toBe(200);
    expect((await pw.get("/api/account/me")).body.user.id).toBe(person.id);
    expect(await orgName(pw)).toBe("Acme");
    expect((await pw.post(`/api/account/workspaces/${beta}/switch`)).status).toBe(200);
    expect(await orgName(pw)).toBe("Beta");
    expect(await orgName(g.client)).toBe("Acme");
    const sessionsOf = await app.db.select().from(sessions).where(and(eq(sessions.userId, person.id)));
    expect(new Set(sessionsOf.map((s) => s.userId)).size).toBe(1);
  });
});

describe("multiws: the workspace mark", () => {
  it("reads only its own cookie and writes a safe value", () => {
    expect(workspaceMark(new Headers())).toBe("");
    expect(workspaceMark(new Headers({ cookie: "a=1; mymail.ws=org_x.k1; b=2" }))).toBe("org_x.k1");
    expect(workspaceMark(new Headers({ cookie: "xmymail.ws=no" }))).toBe("");
    const line = workspaceMarkCookie("org_abc;evil", true, 36);
    expect(line).toMatch(/^mymail\.ws=org_abcevil\.10; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    expect(workspaceMarkCookie("org_abc", false, 1)).not.toContain("Secure");
  });
});

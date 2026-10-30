import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { members, sessions, users, organizations } from "../src/server/db/schema";
import { testSessionEnv } from "../src/server/routes/test-session-r45";
import { bindTestSessionEnv } from "../src/server/test-session-env-r45";

const TOKEN = "x".repeat(40);

async function setup() {
  const t = await makeTestApp();
  const owner = new Client(t.app);
  const email = await owner.signup();
  const user = (await t.db.select().from(users).where(eq(users.email, email)).get())!;
  const member = (await t.db.select().from(members).where(eq(members.userId, user.id)).get())!;
  const env = { TEST_SESSION_TOKEN: TOKEN, TEST_SESSION_USER_ID: user.id, TEST_SESSION_ORG_ID: member.organizationId };
  const mint = (headers: Record<string, string>, e: Record<string, string> = env) =>
    t.app.request("/api/_test-session", { method: "POST", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: "{}" }, e);
  return { ...t, user, member, env, mint };
}

describe("R45 production test session", () => {
  it("is off unless all three settings are set and the token is long", () => {
    expect(testSessionEnv({})).toBeNull();
    expect(testSessionEnv({ TEST_SESSION_TOKEN: "short", TEST_SESSION_USER_ID: "usr_a", TEST_SESSION_ORG_ID: "org_a" })).toBeNull();
    expect(testSessionEnv({ TEST_SESSION_TOKEN: TOKEN, TEST_SESSION_USER_ID: "usr_a" })).toBeNull();
    expect(testSessionEnv({ TEST_SESSION_TOKEN: TOKEN, TEST_SESSION_USER_ID: "usr_a", TEST_SESSION_ORG_ID: "org_a" })).not.toBeNull();
  });

  it("answers 404 without the settings and with a wrong header", async () => {
    const s = await setup();
    expect((await s.mint({ "x-test-session": TOKEN }, {})).status).toBe(404);
    expect((await s.mint({ "x-test-session": TOKEN.slice(1) + "y" })).status).toBe(404);
    expect((await s.mint({})).status).toBe(404);
  });

  it("mints one working session for the test user in the test workspace, replacing the last one", async () => {
    const s = await setup();
    const a = await s.mint({ "x-test-session": TOKEN });
    expect(a.status).toBe(200);
    const body = (await a.json()) as { cookie: { name: string; value: string }; orgId: string };
    expect(body.orgId).toBe(s.member.organizationId);
    const me = await s.app.request("/api/account/me", { headers: { host: "localhost", cookie: `mymail.session_token=${body.cookie.value}` } });
    expect(me.status).toBe(200);
    const mj = (await me.json()) as { organization: { id: string; isDemo: boolean } };
    expect(mj.organization.id).toBe(s.member.organizationId);
    expect((await s.mint({ "x-test-session": TOKEN })).status).toBe(200);
    const rows = (await s.db.select().from(sessions).where(eq(sessions.userId, s.user.id)).all()).filter((r) => r.loginMethod === "test-session");
    expect(rows).toHaveLength(1);
  });

  it("refuses when the user is in another workspace too, or the workspace is a demo", async () => {
    const s = await setup();
    s.db.update(organizations).set({ isDemo: true }).where(eq(organizations.id, s.member.organizationId)).run();
    expect((await s.mint({ "x-test-session": TOKEN })).status).toBe(409);
    s.db.update(organizations).set({ isDemo: false }).where(eq(organizations.id, s.member.organizationId)).run();
    expect((await s.mint({ "x-test-session": TOKEN }, { ...s.env, TEST_SESSION_ORG_ID: "org_other" })).status).toBe(409);
  });

  it("reads the settings the Worker bound at boot when the app is called without an env (as on the Worker)", async () => {
    const s = await setup();
    try {
      bindTestSessionEnv(s.env);
      expect((await s.mint({ "x-test-session": TOKEN }, undefined as unknown as Record<string, string>)).status).toBe(200);
      expect((await s.mint({ "x-test-session": TOKEN.slice(1) + "y" }, undefined as unknown as Record<string, string>)).status).toBe(404);
    } finally { bindTestSessionEnv(undefined); }
  });
  it("multiws: allows a second workspace the test user is alone in, and refuses once anyone else is in it", async () => {
    const s = await setup();
    const first = await s.mint({ "x-test-session": TOKEN });
    const cookie = `mymail.session_token=${((await first.json()) as { cookie: { value: string } }).cookie.value}`;
    const made = await s.app.request("/api/account/workspaces", { method: "POST", headers: { host: "localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "QA second (test)" }) });
    expect(made.status).toBe(201);
    const second = ((await made.json()) as { id: string }).id;
    const again = await s.mint({ "x-test-session": TOKEN });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { orgId: string }).orgId).toBe(s.member.organizationId);
    // Someone else joins the second workspace: the test session is refused from then on.
    const other = new Client(s.app);
    const otherEmail = await other.signup();
    const otherUser = (await s.db.select().from(users).where(eq(users.email, otherEmail)).get())!;
    s.db.insert(members).values({ id: "mem_multiws_other", organizationId: second, userId: otherUser.id, role: "member" }).run();
    expect((await s.mint({ "x-test-session": TOKEN })).status).toBe(409);
  });
});

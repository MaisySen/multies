import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Webhook } from "standardwebhooks";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, members, messages, sessions, users } from "@/server/db/schema";
import { TEST_SENDS_PER_HOUR } from "@/server/services/mail/auth-email-settings";

/** R28: the Sign-up emails settings over MCP (get, update, regenerate secret, preview, test send), same rules as v1. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let mia: Client;
let key: string;
let orgId: string;

async function mcpFor(k: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${k}` } }, fetch: fetchViaApp }));
  return client;
}
type Res = { content: { text: string }[]; isError?: boolean };
const call = async (m: McpClient, name: string, args: Record<string, unknown> = {}) => (await m.callTool({ name, arguments: args })) as Res;
const data = (r: Res) => { expect(r.isError, r.content[0].text).toBeFalsy(); return JSON.parse(r.content[0].text); };
const errText = (r: Res) => { expect(r.isError).toBe(true); return r.content[0].text; };
const sent = () => ctx.db.select().from(messages).where(and(eq(messages.orgId, orgId), eq(messages.folder, "sent"))).all();

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@haajir.test", "Olive Owner");
  orgId = (await owner.get("/api/account/me")).body.organization.id;
  const d = (await owner.post("/api/domains", { name: "haajir.test" })).body.domain;
  const { body } = await owner.get(`/api/domains/${d.id}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await owner.post(`/api/domains/${d.id}/verify`);
  await owner.post("/api/mailboxes", { domainId: d.id, localPart: "no-reply", displayName: "Haajir" });
  await owner.post("/api/mailboxes", { domainId: d.id, localPart: "hello", displayName: "Hello" });
  key = (await owner.post("/api/developer/keys", { name: "HQ" })).body.secret;
  mia = new Client(ctx.app);
  await mia.signup("mia@haajir.test", "Mia Member", "");
  const u = (await ctx.db.select().from(users).where(eq(users.email, "mia@haajir.test")).get())!;
  await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role: "member" });
  await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
});

describe("Sign-up emails settings over MCP", () => {
  it("lists the five tools", async () => {
    const m = await mcpFor(key);
    const names = (await m.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_auth_email_settings", "update_auth_email_settings", "regenerate_auth_email_secret", "preview_auth_email", "send_auth_email_test"]));
  });

  it("gets, creates and updates settings with the API's validation, the secret once, audited", async () => {
    const m = await mcpFor(key);
    const empty = data(await call(m, "get_auth_email_settings"));
    expect(empty.settings).toBeNull();
    expect(empty.senders.map((s: { address: string }) => s.address)).toEqual(["hello@haajir.test", "no-reply@haajir.test"]);

    // Same checks as PUT /api/v1/auth-email-settings.
    expect(errText(await call(m, "update_auth_email_settings", { supabaseUrl: "https://x.supabase.co" }))).toContain("Pick the address");
    expect(errText(await call(m, "update_auth_email_settings", { from: "nobody@haajir.test", supabaseUrl: "https://x.supabase.co" }))).toMatch(/^validation_failed|^\w+:/);
    expect(errText(await call(m, "update_auth_email_settings", { from: "no-reply@haajir.test", supabaseUrl: "http://x.supabase.co" }))).toContain("https://");
    expect(errText(await call(m, "update_auth_email_settings", { from: "no-reply@haajir.test", supabaseUrl: "https://x.supabase.co", branding: { brandColor: "red" } }))).toContain("brandColor");

    const made = data(await call(m, "update_auth_email_settings", { from: "no-reply@haajir.test", supabaseUrl: "https://abcd1234.supabase.co/", appName: "Haajir", senderName: "Haajir School" }));
    expect(made.secret).toMatch(/^v1,whsec_/);
    expect(made.settings).toMatchObject({ enabled: true, from: "no-reply@haajir.test", appName: "Haajir", senderName: "Haajir School", supabaseUrl: "https://abcd1234.supabase.co" });
    const got = data(await call(m, "get_auth_email_settings"));
    expect(JSON.stringify(got)).not.toContain(String(made.secret).slice(9));
    expect(got.settings.secret.set).toBe(true);

    const up = data(await call(m, "update_auth_email_settings", { enabled: false, branding: { brandColor: "#0F7B6C" } }));
    expect(up.secret).toBeUndefined();
    expect(up.settings).toMatchObject({ enabled: false, branding: { brandColor: "#0f7b6c" } });
    const actions = (await ctx.db.select().from(auditLogs).where(eq(auditLogs.orgId, orgId)).all()).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["auth_email_settings.created", "auth_email_settings.updated"]));
  });

  it("regenerates the signing secret once, the old one stops working, and the value is neither audited nor logged", async () => {
    const m = await mcpFor(key);
    const made = data(await call(m, "update_auth_email_settings", { from: "no-reply@haajir.test", supabaseUrl: "https://abcd1234.supabase.co" }));
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); }));
    const re = data(await call(m, "regenerate_auth_email_secret"));
    for (const s of spies) s.mockRestore();
    expect(re.secret).toMatch(/^v1,whsec_/);
    expect(re.secret).not.toBe(made.secret);
    const value = String(re.secret).slice(9);
    expect(logged.join("\n")).not.toContain(value);
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "auth_email_settings.secret_regenerated"))).all();
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(value);
    expect(JSON.stringify(data(await call(m, "get_auth_email_settings")))).not.toContain(value);

    const payload = JSON.stringify({ user: { email: "parent@example.com" }, email_data: { token: "111222", token_hash: "h1", email_action_type: "signup", redirect_to: "" } });
    const hook = (s: string) => {
      const now = new Date();
      const whId = `wh_${Math.random().toString(36).slice(2)}`; // Round 2: Supabase names each delivery; the same id twice is a replay
      return ctx.app.request(new URL(made.settings.endpointUrl).pathname, { method: "POST", headers: { "content-type": "application/json", "webhook-id": whId, "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": new Webhook(s.replace(/^v1,/, "")).sign(whId, now, payload) }, body: payload });
    };
    expect((await hook(made.secret)).status).toBe(401);
    expect((await hook(re.secret)).status).toBe(200);
  });

  it("previews one type with unsaved branding and stores nothing", async () => {
    const m = await mcpFor(key);
    const p = data(await call(m, "preview_auth_email", { type: "reauthentication", appName: "Haajir", email: "parent@example.com" }));
    expect(p.preview).toMatchObject({ type: "reauthentication", to: "parent@example.com" });
    expect(p.preview.text).toContain("123456");
    const def = data(await call(m, "preview_auth_email"));
    expect(def.preview.type).toBe("signup");
    expect(errText(await call(m, "preview_auth_email", { type: "nope" }))).toBeTruthy();
    expect(errText(await call(m, "preview_auth_email", { branding: { logoUrl: "javascript:alert(1)" } }))).toBeTruthy();
    expect(data(await call(m, "get_auth_email_settings")).settings).toBeNull();
    expect(await sent()).toHaveLength(0);
  });

  it("sends a test to the caller's own address, at most 5 an hour (shared with the API)", async () => {
    const m = await mcpFor(key);
    expect(errText(await call(m, "send_auth_email_test"))).toContain("not_found");
    data(await call(m, "update_auth_email_settings", { from: "no-reply@haajir.test", supabaseUrl: "https://x.supabase.co", appName: "Haajir" }));
    // One from the web page counts against the same hour.
    expect((await owner.post("/api/auth-email-settings/test", {})).status).toBe(200);
    for (let i = 1; i < TEST_SENDS_PER_HOUR; i++) {
      const r = data(await call(m, "send_auth_email_test", { type: i % 2 ? "recovery" : "signup" }));
      expect(r).toMatchObject({ sent: true, to: "owner@haajir.test", testSendsLeft: TEST_SENDS_PER_HOUR - i - 1 });
    }
    const limited = errText(await call(m, "send_auth_email_test"));
    expect(limited).toContain("rate_limited");
    expect(limited).toContain("test emails this hour");
    expect(await sent()).toHaveLength(TEST_SENDS_PER_HOUR);
    const tests = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "auth_email_settings.test_sent"))).all();
    expect(tests).toHaveLength(TEST_SENDS_PER_HOUR);
  });

  it("refuses members, agent keys and read only keys with a clear error", async () => {
    const m = await mcpFor(key);
    data(await call(m, "update_auth_email_settings", { from: "no-reply@haajir.test", supabaseUrl: "https://x.supabase.co" }));
    const agent = (await owner.post("/api/agents", { name: "Bot", localPart: "bot" })).body.apiKey.secret as string;
    const am = await mcpFor(agent);
    for (const [name, args] of [["get_auth_email_settings", {}], ["update_auth_email_settings", { enabled: false }], ["regenerate_auth_email_secret", {}], ["preview_auth_email", {}], ["send_auth_email_test", {}]] as const) {
      const t = errText(await call(am, name, args));
      expect(t).toContain("forbidden");
      expect(t).toContain("owners and admins");
    }
    // A member can't hold a workspace key (keys are for admins), and an agent member's key acts with the member role.
    expect((await mia.post("/api/developer/keys", { name: "Mia" })).status).toBe(403);
    const ro = await mcpFor((await owner.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret);
    expect(data(await call(ro, "get_auth_email_settings")).settings.enabled).toBe(true);
    expect(data(await call(ro, "preview_auth_email")).preview.type).toBe("signup");
    for (const name of ["update_auth_email_settings", "regenerate_auth_email_secret", "send_auth_email_test"]) expect(errText(await call(ro, name, name === "update_auth_email_settings" ? { enabled: false } : {}))).toContain("read_only_key");
    expect(data(await call(m, "get_auth_email_settings")).settings.enabled).toBe(true);
    expect(await sent()).toHaveLength(0);
  });
});

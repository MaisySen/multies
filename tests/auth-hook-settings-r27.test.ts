import { describe, it, expect, beforeEach } from "vitest";
import { Webhook } from "standardwebhooks";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, members, messages, sessions, users } from "@/server/db/schema";
import { maskSecret, newHookSecret, TEST_SENDS_PER_HOUR } from "@/server/services/mail/auth-email-settings";

/** R27: the Sign-up emails settings page over the R25 auth email hook (web and v1). */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
let mia: Client;
let key: string;
let orgId: string;

async function api(k: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${k}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const put = (c: Client, body: unknown) => c.put("/api/auth-email-settings", body);

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

describe("secret helpers", () => {
  it("makes Standard Webhooks secrets and masks all but the last 4 characters", () => {
    const s = newHookSecret();
    expect(s).toMatch(/^whsec_[A-Za-z0-9+/=]{40,}$/);
    expect(newHookSecret()).not.toBe(s);
    const m = maskSecret(s);
    expect(m.endsWith(s.slice(-4))).toBe(true);
    expect(m).not.toContain(s.slice(6, -4));
  });
});

describe("Sign-up emails settings", () => {
  it("creates settings with a secret shown once, masks it after, and the hook verifies with it", async () => {
    const empty = await owner.get("/api/auth-email-settings");
    expect(empty.status).toBe(200);
    expect(empty.body.settings).toBeNull();
    expect(empty.body.senders.map((s: { address: string }) => s.address)).toEqual(["hello@haajir.test", "no-reply@haajir.test"]);

    const made = await put(owner, { from: "no-reply@haajir.test", supabaseUrl: "https://abcd1234.supabase.co/", appName: "Haajir", senderName: "Haajir School" });
    expect(made.status).toBe(200);
    expect(made.body.secret).toMatch(/^v1,whsec_/);
    const secret = made.body.secret as string;
    expect(made.body.settings).toMatchObject({ enabled: true, from: "no-reply@haajir.test", appName: "Haajir", senderName: "Haajir School", supabaseUrl: "https://abcd1234.supabase.co" });
    expect(made.body.settings.endpointUrl).toMatch(/\/api\/auth-hooks\/supabase\/ahk_/);

    const got = await owner.get("/api/auth-email-settings");
    expect(JSON.stringify(got.body)).not.toContain(secret.slice(9));
    expect(got.body.settings.secret).toEqual({ set: true, masked: maskSecret(secret.slice(3)) });
    const v1 = await api(key, "GET", "/auth-email-settings");
    expect(v1.status).toBe(200);
    expect(JSON.stringify(v1.body)).not.toContain(secret.slice(9));

    // The hook takes the secret, and the From name is the sender name.
    const payload = JSON.stringify({ user: { email: "parent@example.com" }, email_data: { token: "111222", token_hash: "h1", email_action_type: "signup", redirect_to: "" } });
    const call = (s: string) => {
      const now = new Date();
      const whId = `wh_${Math.random().toString(36).slice(2)}`; // Round 2: Supabase names each delivery; the same id twice is a replay
      return ctx.app.request(new URL(made.body.settings.endpointUrl).pathname, { method: "POST", headers: { "content-type": "application/json", "webhook-id": whId, "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": new Webhook(s.replace(/^v1,/, "")).sign(whId, now, payload) }, body: payload });
    };
    expect((await call(secret)).status).toBe(200);
    const sent = await ctx.db.select().from(messages).where(and(eq(messages.orgId, orgId), eq(messages.folder, "sent"))).all();
    expect(sent).toHaveLength(1);
    expect(sent[0].fromName).toBe("Haajir School");

    // Regenerate: new secret once, the old one stops working, audited without the value.
    const re = await owner.post("/api/auth-email-settings/secret", {});
    expect(re.status).toBe(200);
    expect(re.body.secret).not.toBe(secret);
    expect((await call(secret)).status).toBe(401);
    expect((await call(re.body.secret)).status).toBe(200);
    const logs = await ctx.db.select().from(auditLogs).where(eq(auditLogs.orgId, orgId)).all();
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["auth_email_settings.created", "auth_email_settings.secret_regenerated"]));
    const all = JSON.stringify(logs);
    expect(all).not.toContain(secret.slice(9));
    expect(all).not.toContain(String(re.body.secret).slice(9));
  });

  it("validates input and audits the fields that changed", async () => {
    expect((await put(owner, { supabaseUrl: "https://x.supabase.co" })).body.error.message).toContain("Pick the address");
    expect((await put(owner, { from: "nobody@haajir.test", supabaseUrl: "https://x.supabase.co" })).status).toBe(422);
    expect((await put(owner, { from: "no-reply@haajir.test", supabaseUrl: "http://x.supabase.co" })).body.error.message).toContain("https://");
    expect((await put(owner, { from: "no-reply@haajir.test", supabaseUrl: "https://x.supabase.co", branding: { brandColor: "red" } })).body.error.message).toContain("brandColor");
    expect((await put(owner, { from: "no-reply@haajir.test", supabaseUrl: "https://x.supabase.co", senderName: "Two\nlines" })).status).toBe(422);
    expect((await put(owner, { from: "no-reply@haajir.test", supabaseUrl: "https://x.supabase.co", surprise: 1 })).status).toBe(422);
    expect((await put(owner, { from: "no-reply@haajir.test", supabaseUrl: "https://x.supabase.co" })).status).toBe(200);
    const up = await put(owner, { enabled: false, from: "hello@haajir.test", branding: { brandColor: "#0F7B6C", templates: { signup: { subject: "Welcome to {appName}" } }, secondaryLanguage: { lang: "ne", templates: { signup: { intro: "नमस्ते" } } } } });
    expect(up.status).toBe(200);
    expect(up.body.secret).toBeUndefined();
    expect(up.body.settings).toMatchObject({ enabled: false, from: "hello@haajir.test", branding: { brandColor: "#0f7b6c", templates: { signup: { subject: "Welcome to {appName}" } } } });
    const row = (await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "auth_email_settings.updated"))).all())[0];
    expect(JSON.parse(row.metadata!)).toEqual({ fields: ["enabled", "from", "branding"], enabled: false });
    // A no-op PUT writes no audit entry.
    await put(owner, { enabled: false });
    expect(await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "auth_email_settings.updated"))).all()).toHaveLength(1);
  });

  it("refuses members, agent keys and read only keys (403)", async () => {
    await put(owner, { from: "no-reply@haajir.test", supabaseUrl: "https://x.supabase.co" });
    expect((await mia.get("/api/auth-email-settings")).status).toBe(403);
    expect((await put(mia, { enabled: false })).status).toBe(403);
    expect((await mia.post("/api/auth-email-settings/secret", {})).status).toBe(403);
    expect((await mia.post("/api/auth-email-settings/test", {})).status).toBe(403);
    expect((await mia.post("/api/auth-email-settings/preview", {})).status).toBe(403);
    const agent = (await owner.post("/api/agents", { name: "Bot", localPart: "bot" })).body.apiKey.secret;
    expect((await api(agent, "GET", "/auth-email-settings")).status).toBe(403);
    const ro = (await owner.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    expect((await api(ro, "PUT", "/auth-email-settings", { enabled: false })).status).toBe(403);
    expect((await api(key, "PUT", "/auth-email-settings", { enabled: false })).status).toBe(200);
  });

  it("previews each type with unsaved changes, and a turned off hook sends nothing", async () => {
    const before = await owner.post("/api/auth-email-settings/preview", { type: "signup", appName: "Haajir", branding: { brandColor: "#0F7B6C", templates: { signup: { subject: "Welcome to {appName}", intro: "Hi {email}" } }, secondaryLanguage: { lang: "ne", templates: { signup: { subject: "स्वागत छ", intro: "नमस्ते" } } } } });
    expect(before.status).toBe(200);
    expect(before.body.preview.subject).toBe("Welcome to Haajir / स्वागत छ");
    expect(before.body.preview.html).toContain("#0f7b6c");
    expect(before.body.preview.html).toContain("नमस्ते");
    expect(before.body.preview.html).toContain("Hi parent@example.com");
    const code = await owner.post("/api/auth-email-settings/preview", { type: "reauthentication" });
    expect(code.body.preview.text).toContain("123456");
    expect((await owner.post("/api/auth-email-settings/preview", { type: "nope" })).status).toBe(422);
    expect((await owner.post("/api/auth-email-settings/preview", { type: "signup", branding: { logoUrl: "javascript:alert(1)" } })).status).toBe(422);
    const v1 = await api(key, "POST", "/auth-email-settings/preview", { type: "recovery" });
    expect(v1.body.preview.subject).toContain("password");

    const made = await put(owner, { from: "no-reply@haajir.test", supabaseUrl: "https://x.supabase.co", enabled: false });
    const payload = JSON.stringify({ user: { email: "p@example.com" }, email_data: { token: "1", token_hash: "h", email_action_type: "signup" } });
    const now = new Date();
    const res = await ctx.app.request(new URL(made.body.settings.endpointUrl).pathname, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "w", "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": new Webhook(String(made.body.secret).slice(3)).sign("w", now, payload) }, body: payload });
    expect(res.status).toBe(503);
    expect(await ctx.db.select().from(messages).where(and(eq(messages.orgId, orgId), eq(messages.folder, "sent"))).all()).toHaveLength(0);
  });

  it("sends a test to the admin's own address, at most 5 an hour", async () => {
    expect((await owner.post("/api/auth-email-settings/test", {})).status).toBe(404);
    await put(owner, { from: "no-reply@haajir.test", supabaseUrl: "https://x.supabase.co", appName: "Haajir" });
    for (let i = 0; i < TEST_SENDS_PER_HOUR; i++) {
      const r = await owner.post("/api/auth-email-settings/test", { type: i % 2 ? "recovery" : "signup" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ sent: true, to: "owner@haajir.test", testSendsLeft: TEST_SENDS_PER_HOUR - i - 1 });
    }
    const limited = await owner.post("/api/auth-email-settings/test", {});
    expect(limited.status).toBe(429);
    expect(limited.body.error.message).toContain("test emails this hour");
    const sent = await ctx.db.select().from(messages).where(and(eq(messages.orgId, orgId), eq(messages.folder, "sent"))).all();
    expect(sent).toHaveLength(TEST_SENDS_PER_HOUR);
    expect(sent.every((m) => m.subject.startsWith("Test: "))).toBe(true);
    expect((await owner.get("/api/auth-email-settings")).body.settings.testSendsLeft).toBe(0);
  });
});

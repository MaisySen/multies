import { describe, it, expect } from "vitest";
import { Webhook } from "standardwebhooks";
import { makeTestApp, Client } from "./helpers";
import { excerptOf } from "@/server/services/suite/docs";

const RESEND_SECRET = `whsec_${Buffer.from("resend-test-secret-0123456789ab").toString("base64")}`;

/** A stand-in for the outbound provider's domain and receiving API. */
function fakeProvider(opts: { refuse?: string } = {}) {
  const calls: string[] = [];
  let status = "not_started";
  const records = [
    { record: "DKIM", name: "resend._domainkey", type: "TXT", ttl: "Auto", status: "not_started", value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDtest" },
    { record: "SPF", name: "send", type: "MX", ttl: "Auto", status: "not_started", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
    { record: "SPF", name: "send", type: "TXT", ttl: "Auto", status: "not_started", value: "v=spf1 include:amazonses.com ~all" },
    { record: "SPF", name: "rsend", type: "CNAME", ttl: "Auto", status: "not_started", value: "send.forge.example.net" },
    { record: "Receiving", name: "@", type: "MX", ttl: "Auto", status: "not_started", value: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
  ];
  const raw = [
    "From: Bob <bob@example.com>", "To: support@haajir.test", "Subject: Login help", "Message-ID: <r13-1@example.com>",
    "Date: Sat, 24 Oct 2026 08:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "I cannot sign in.", "",
  ].join("\r\n");
  const json = (body: unknown, s = 200) => new Response(JSON.stringify(body), { status: s, headers: { "content-type": "application/json" } });
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.replace("https://api.resend.com", "")}`);
    if (url === "https://dl.test/raw/1") return new Response(raw);
    if (url.endsWith("/domains") && method === "POST") {
      if (opts.refuse) return json({ name: "validation_error", message: opts.refuse }, 403);
      return json({ id: "rd_1", name: JSON.parse(String(init!.body)).name, status, records });
    }
    if (url.endsWith("/domains") && method === "GET") return json({ data: [] });
    if (url.endsWith("/domains/rd_1/verify")) { status = "verified"; return json({ id: "rd_1" }); }
    if (url.endsWith("/domains/rd_1") && method === "GET") return json({ id: "rd_1", status, records });
    if (url.endsWith("/domains/rd_1") && method === "DELETE") return json({ deleted: true });
    if (url.endsWith("/emails/receiving/em_1")) return json({ id: "em_1", from: "Bob <bob@example.com>", to: ["support@haajir.test"], received_for: ["support@haajir.test"], raw: { download_url: "https://dl.test/raw/1" } });
    return json({ message: "not found" }, 404);
  }) as typeof fetch;
  return { fetch: f, calls };
}

async function publish(dns: { records: { mx?: Record<string, { exchange: string; priority: number }[]>; txt?: Record<string, string[]> } }, records: { id: string; type: string; fqdn: string; value: string; values?: { value: string; priority: number }[] }[]) {
  for (const r of records) {
    if (r.type === "MX") dns.records.mx = { ...dns.records.mx, [r.fqdn]: r.values!.map((v) => ({ exchange: v.value, priority: v.priority })) };
    else dns.records.txt = { ...dns.records.txt, [r.fqdn]: [...(dns.records.txt?.[r.fqdn] ?? []), r.value] };
  }
}

describe("customer domains on any DNS provider (round 13)", () => {
  it("shows the provider's exact records, verifies, takes support@, hello@ and no-reply@, and receives mail through the provider", async () => {
    const p = fakeProvider();
    const ctx = await makeTestApp({ RESEND_API_KEY: "re_test", RESEND_WEBHOOK_SECRET: RESEND_SECRET }, { fetch: p.fetch });
    const c = new Client(ctx.app);
    await c.signup();
    const made = await c.post("/api/domains", { name: "haajir.test" });
    expect(made.status).toBe(201);
    const d = made.body.domain;
    const byId = (id: string) => d.records.filter((r: { id: string }) => r.id === id);
    expect(byId("mx")[0]).toMatchObject({ type: "MX", host: "@", values: [{ value: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 }] });
    expect(byId("dkim")[0]).toMatchObject({ type: "TXT", host: "resend._domainkey", fqdn: "resend._domainkey.haajir.test" });
    expect(byId("return_mx")[0]).toMatchObject({ type: "MX", host: "send", fqdn: "send.haajir.test", value: "feedback-smtp.us-east-1.amazonses.com" });
    expect(byId("return_spf")[0]).toMatchObject({ type: "TXT", host: "send", value: "v=spf1 include:amazonses.com ~all" });
    expect(byId("return_cname")[0]).toMatchObject({ type: "CNAME", host: "rsend", fqdn: "rsend.haajir.test", value: "send.forge.example.net", required: false });
    expect(byId("spf")[0].value).toMatch(/^v=spf1 /);
    expect(byId("dmarc")[0].value).toMatch(/^v=DMARC1; p=quarantine/);
    expect(byId("ownership")).toHaveLength(1);
    expect(d.sending).toEqual({ status: "pending", detail: null });

    await publish(ctx.dns, d.records);
    const v = await c.post(`/api/domains/${d.id}/verify`);
    expect(v.body.report.verified).toBe(true);
    expect(v.body.domain.status).toBe("verified");
    expect(v.body.domain.sending.status).toBe("verified");
    expect(p.calls).toEqual(expect.arrayContaining(["POST /domains", "POST /domains/rd_1/verify", "GET /domains/rd_1"]));
    // Once the provider shows the domain as verified, a later check reads it and does not ask it to verify
    // again (a verify request would put it back to pending).
    const verifies = () => p.calls.filter((x) => x === "POST /domains/rd_1/verify").length;
    const before = verifies();
    const again = await c.post(`/api/domains/${d.id}/verify`);
    expect(again.body.domain.sending.status).toBe("verified");
    expect(verifies()).toBe(before);

    for (const localPart of ["support", "hello", "no-reply"]) {
      const mb = await c.post("/api/mailboxes", { domainId: d.id, localPart, displayName: localPart === "no-reply" ? "Haajir" : `Haajir ${localPart}` });
      expect(mb.status).toBe(201);
      expect(mb.body.mailbox.address).toBe(`${localPart}@haajir.test`);
    }

    const body = JSON.stringify({ type: "email.received", created_at: new Date().toISOString(), data: { email_id: "em_1", from: "bob@example.com", to: ["support@haajir.test"] } });
    const now = new Date();
    const sig = new Webhook(RESEND_SECRET).sign("msg_r13", now, body);
    const res = await ctx.app.request("/api/webhooks/resend", { method: "POST", headers: { "content-type": "application/json", "svix-id": "msg_r13", "svix-timestamp": String(Math.floor(now.getTime() / 1000)), "svix-signature": sig }, body });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, handled: true, received: 1 });
    const stored = await ctx.db.query.messages.findMany();
    expect(stored.map((m) => m.subject)).toContain("Login help");
  });

  it("keeps the domain and says why when the provider refuses it", async () => {
    const p = fakeProvider({ refuse: "This domain name is not allowed" });
    const ctx = await makeTestApp({ RESEND_API_KEY: "re_test" }, { fetch: p.fetch });
    const c = new Client(ctx.app);
    await c.signup();
    const made = await c.post("/api/domains", { name: "haajir.test" });
    expect(made.status).toBe(201);
    // R40 (MB-206): our own words, never the provider's (they stay in the server log and the stored status).
    expect(made.body.domain.sending).toEqual({ status: "error", detail: "We couldn't turn on sending for this domain yet. We'll try again when you check DNS." });
    // Without the provider's records the setup falls back to Multies' own MX and DKIM.
    expect(made.body.domain.records.find((r: { id: string }) => r.id === "dkim").value).toMatch(/^v=DKIM1; k=rsa; p=/);
  });

  it("a full provider plan queues the domain instead of failing (round 17)", async () => {
    const p = fakeProvider({ refuse: "You have reached your domain limit" });
    const ctx = await makeTestApp({ RESEND_API_KEY: "re_test" }, { fetch: p.fetch });
    const c = new Client(ctx.app);
    await c.signup();
    const made = await c.post("/api/domains", { name: "haajir.test" });
    expect(made.status).toBe(201);
    expect(made.body.domain.sending.status).toBe("queued");
  });

  it("registers nothing with a provider when outbound mail is the local log", async () => {
    const p = fakeProvider();
    const ctx = await makeTestApp({}, { fetch: p.fetch });
    const c = new Client(ctx.app);
    await c.signup();
    const made = await c.post("/api/domains", { name: "haajir.test" });
    expect(made.body.domain.sending).toBeNull();
    expect(p.calls).toEqual([]);
  });
});

describe("dogfood round 13", () => {
  it("doc list previews drop a first line that repeats the title", () => {
    expect(excerptOf("Brand", "Brand\nPrimary colour #0071E3\nText #1D1D1F")).toBe("Primary colour #0071E3\nText #1D1D1F");
    expect(excerptOf("Notes", "Agenda\nItem")).toBe("Agenda\nItem");
  });

  it("new projects use To do, In progress, In review and Done", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup();
    const proj = await c.post("/api/projects", { name: "Launch" });
    const names = (proj.body.project.statuses ?? proj.body.statuses ?? []).map((s: { name: string }) => s.name);
    expect(names).toEqual(["To do", "In progress", "In review", "Done"]);
  });

  it("a workspace key posts as the workspace, an agent member's key as the agent with its title", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup();
    const v1 = async (key: string, method: string, path: string, body?: unknown) => {
      const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };
    const wsKey = (await c.post("/api/developer/keys", { name: "Org setup script" })).body.secret as string;
    const ch = (await v1(wsKey, "POST", "/chat/channels", { name: "general-r13" })).body.channel;
    const a = (await v1(wsKey, "POST", `/chat/channels/${ch.id}/messages`, { body: "Welcome." })).body.message;
    expect(a.author.name).toBe("Acme");
    const agent = (await c.post("/api/team/agents", { name: "Builder", title: "Engineering lead" })).body;
    const b = (await v1(agent.secret, "POST", `/chat/channels/${ch.id}/messages`, { body: "Shipping today." })).body.message;
    expect(b.author).toMatchObject({ name: "Builder", title: "Engineering lead", agent: true });
    const list = (await c.get(`/api/chat/channels/${ch.id}/messages`)).body.messages;
    expect(list.find((m: { id: string }) => m.id === b.id).author).toMatchObject({ name: "Builder", title: "Engineering lead", agent: true });
  });
});

describe("transactional email without SMTP (round 13)", () => {
  async function setup() {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup();
    const d = (await c.post("/api/domains", { name: "haajir.test" })).body.domain;
    await publish(ctx.dns, d.records);
    expect((await c.post(`/api/domains/${d.id}/verify`)).body.domain.status).toBe("verified");
    expect((await c.post("/api/mailboxes", { domainId: d.id, localPart: "no-reply", displayName: "Haajir" })).status).toBe(201);
    const key = (await c.post("/api/developer/keys", { name: "Haajir app" })).body.secret as string;
    const v1 = async (method: string, path: string, body?: unknown) => {
      const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };
    return { ctx, c, v1 };
  }

  it("sends from an address through the API", async () => {
    const { ctx, v1 } = await setup();
    const r = await v1("POST", "/messages", { from: "no-reply@haajir.test", to: ["teacher@example.com"], subject: "Welcome", text: "Hello" });
    expect(r.status).toBe(200);
    expect(ctx.outbound.sent.at(-1)).toMatchObject({ from: { address: "no-reply@haajir.test" }, to: ["teacher@example.com"], subject: "Welcome" });
    expect((await v1("POST", "/messages", { from: "nobody@haajir.test", to: ["a@example.com"], subject: "x", text: "y" })).status).toBe(422);
  });

  it("takes Supabase's Send Email Hook: signed calls become emails from no-reply@, bad signatures are refused", async () => {
    const { ctx, v1 } = await setup();
    const secret = `v1,whsec_${Buffer.from("supabase-hook-secret-0123456789").toString("base64")}`;
    const made = await v1("POST", "/auth-email-hooks", { from: "no-reply@haajir.test", secret, supabaseUrl: "https://abcd1234.supabase.co", appName: "Haajir" });
    expect(made.status).toBe(201);
    expect(made.body.hook.url).toMatch(/\/api\/auth-hooks\/supabase\/ahk_/);
    expect(JSON.stringify((await v1("GET", "/auth-email-hooks")).body)).not.toContain("whsec_");
    const path = new URL(made.body.hook.url).pathname;
    const call = async (payload: unknown, key = secret) => {
      const body = JSON.stringify(payload);
      const now = new Date();
      const sig = new Webhook(key.replace(/^v1,/, "")).sign("wh_1", now, body);
      const res = await ctx.app.request(path, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "wh_1", "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": sig }, body });
      return { status: res.status, body: await res.json() };
    };
    const ok = await call({ user: { email: "Teacher@Example.com" }, email_data: { token: "305805", token_hash: "abc123", redirect_to: "https://haajir.test/welcome", email_action_type: "signup", site_url: "https://haajir.test" } });
    expect(ok).toEqual({ status: 200, body: {} });
    const mail = ctx.outbound.sent.at(-1)!;
    expect(mail.from.address).toBe("no-reply@haajir.test");
    expect(mail.to).toEqual(["teacher@example.com"]);
    expect(mail.subject).toBe("Confirm your email for Haajir");
    expect(mail.text).toContain("https://abcd1234.supabase.co/auth/v1/verify?token=abc123&type=signup&redirect_to=https%3A%2F%2Fhaajir.test%2Fwelcome");
    expect(mail.text).toContain("305805");

    const before = ctx.outbound.sent.length;
    const change = await call({ user: { email: "old@example.com", new_email: "new@example.com" }, email_data: { token: "111111", token_hash: "hash-for-new", token_new: "222222", token_hash_new: "hash-for-current", email_action_type: "email_change", redirect_to: "", site_url: "https://haajir.test" } });
    expect(change.status).toBe(200);
    const two = ctx.outbound.sent.slice(before);
    expect(two.map((m) => m.to[0])).toEqual(["old@example.com", "new@example.com"]);
    expect(two[0].text).toContain("token=hash-for-current");
    expect(two[1].text).toContain("token=hash-for-new");

    const forged = await call({ user: { email: "x@example.com" }, email_data: { email_action_type: "recovery", token_hash: "z" } }, `v1,whsec_${Buffer.from("not-the-secret-not-the-secret-0").toString("base64")}`);
    expect(forged.status).toBe(401);
  });
});

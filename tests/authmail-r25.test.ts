import { describe, it, expect, beforeEach } from "vitest";
import { Webhook } from "standardwebhooks";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { authEmail, parseBrandingInput } from "@/server/services/mail/auth-email-hooks";
import { AUTH_EMAIL_TYPES, buttonTextColor, fillPlaceholders, mergeBranding, parseBranding, renderAuthEmail } from "@/server/services/mail/auth-email-branding";

/** R25 (MB-60, found by Haajir): branded auth emails for the Supabase Send Email Hook. */
const parseOrThrow = (v: unknown) => parseBrandingInput(v);
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
let key: string;

const SECRET = `v1,whsec_${Buffer.from("supabase-hook-secret-0123456789").toString("base64")}`;
const LINK = "https://abcd1234.supabase.co/auth/v1/verify?token=abc&type=signup&redirect_to=";

async function api(k: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${k}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

async function workspace(c: Client, domain: string) {
  const d = (await c.post("/api/domains", { name: domain })).body.domain;
  const { body } = await c.get(`/api/domains/${d.id}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${d.id}/verify`)).body.domain.status).toBe("verified");
  expect((await c.post("/api/mailboxes", { domainId: d.id, localPart: "no-reply", displayName: "Haajir" })).status).toBe(201);
}

async function hookCall(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const now = new Date();
  const sig = new Webhook(SECRET.replace(/^v1,/, "")).sign("wh_1", now, body);
  const res = await ctx.app.request(path, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "wh_1", "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": sig }, body });
  return res.status;
}

const HAAJIR = {
  logoUrl: "https://haajir.test/logo.png",
  brandColor: "#0F7B6C",
  replyTo: "Support@Haajir.test",
  footer: "Haajir, Kathmandu. Questions? Reply to this email.",
  templates: {
    signup: { subject: "Welcome to {appName}", intro: "Hi {email}, confirm your email to finish setting up {appName}.\n\nYour code is {code}.", buttonLabel: "Confirm my email" },
    recovery: { subject: "Reset your {appName} password" },
  },
  secondaryLanguage: {
    lang: "ne",
    templates: { signup: { subject: "हाजिरमा स्वागत छ", intro: "नमस्ते {email}, {appName} सुरु गर्न आफ्नो इमेल पुष्टि गर्नुहोस्।", buttonLabel: "इमेल पुष्टि गर्नुहोस्" } },
    note: "तपाईंले यो अनुरोध गर्नुभएको होइन भने यो इमेल बेवास्ता गर्नुहोस्।",
  },
};

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@haajir.test", "Olive Owner");
  await workspace(owner, "haajir.test");
  key = (await owner.post("/api/developer/keys", { name: "Haajir HQ" })).body.secret;
});

describe("rendering (pure)", () => {
  it("with nothing set, every type is byte for byte the round 13 email", () => {
    for (const type of [...AUTH_EMAIL_TYPES, "something_new"]) {
      const link = type === "email" || type === "reauthentication" ? null : LINK;
      const before = authEmail("Haajir", type, link, "305805");
      expect(renderAuthEmail(null, type, link, "305805", { appName: "Haajir", email: "a@b.test" })).toEqual(before);
      expect(renderAuthEmail({}, type, link, undefined, { appName: "Haajir", email: "a@b.test" })).toEqual(authEmail("Haajir", type, link, undefined));
      // A reply-to alone changes only the header, not the body.
      const r = renderAuthEmail({ replyTo: "help@haajir.test" }, type, link, "305805", { appName: "Haajir", email: "a@b.test" });
      expect({ subject: r.subject, text: r.text, html: r.html }).toEqual(before);
      expect(r.replyTo).toBe("help@haajir.test");
    }
    expect(authEmail("Haajir", "signup", LINK, "1").text).toContain("Confirm your email address to finish signing up for Haajir.");
  });

  it("with branding: logo, colour, footer, per type text and placeholders", () => {
    const b = mergeBranding(null, parseOrThrow(HAAJIR))!;
    expect(b.brandColor).toBe("#0f7b6c");
    expect(b.replyTo).toBe("support@haajir.test");
    const m = renderAuthEmail(b, "signup", LINK, "305805", { appName: "Haajir", email: "Parent@Example.com" });
    expect(m.subject).toBe("Welcome to Haajir / हाजिरमा स्वागत छ");
    expect(m.html).toContain('<img src="https://haajir.test/logo.png" alt="Haajir"');
    expect(m.html).toContain("background:#0f7b6c;color:#fff");
    expect(m.html).toContain(">Confirm my email</a>");
    expect(m.html).toContain("<p>Hi Parent@Example.com, confirm your email to finish setting up Haajir.</p><p>Your code is 305805.</p>");
    expect(m.html).toContain("Haajir, Kathmandu. Questions? Reply to this email.");
    expect(m.text).toContain("Hi Parent@Example.com, confirm your email to finish setting up Haajir.\n\nYour code is 305805.");
    expect(m.text).toContain(LINK);
    expect(m.text.trim().endsWith("Haajir, Kathmandu. Questions? Reply to this email.")).toBe(true);
    expect(m.replyTo).toBe("support@haajir.test");
    // A type with only a subject keeps the default body; a type with no template keeps the default text.
    const rec = renderAuthEmail(b, "recovery", LINK, undefined, { appName: "Haajir", email: "x@y.test" });
    expect(rec.subject).toBe("Reset your Haajir password");
    expect(rec.text).toContain("Someone asked to reset the password for your Haajir account.");
    expect(renderAuthEmail(b, "invite", LINK, undefined, { appName: "Haajir", email: "x@y.test" }).subject).toBe("You're invited to Haajir");
    // Code only types never grow a button, whatever the label says.
    const code = renderAuthEmail(mergeBranding(null, parseOrThrow({ templates: { reauthentication: { buttonLabel: "Go", intro: "Code {code} for {appName}" } } })), "reauthentication", null, "999111", { appName: "Haajir", email: "x@y.test" });
    expect(code.html).not.toContain("<a ");
    expect(code.text.startsWith("Code 999111 for Haajir")).toBe(true);
    // A light brand colour gets dark button text.
    expect(buttonTextColor("#ffd60a")).toBe("#1d1d1f");
    expect(buttonTextColor("#0071e3")).toBe("#fff");
  });

  it("placeholders: the three names fill, others stay as typed, a missing code is empty", () => {
    expect(fillPlaceholders("{appName} {email} {code} {name} {{appName}} {APPNAME}", { appName: "Haajir", email: "a@b.test", code: "12" })).toBe("Haajir a@b.test 12 {name} {Haajir} {APPNAME}");
    expect(fillPlaceholders("code: [{code}]", { appName: "H", email: "e" })).toBe("code: []");
  });

  it("the second language block sits under the main text with its own lang, button and note", () => {
    const m = renderAuthEmail(mergeBranding(null, parseOrThrow(HAAJIR)), "signup", LINK, "305805", { appName: "Haajir", email: "p@x.test" });
    const i = m.html.indexOf('<div lang="ne" dir="auto"');
    expect(i).toBeGreaterThan(m.html.indexOf("If you didn&#39;t ask for this"));
    expect(m.html.slice(i)).toContain("नमस्ते p@x.test, Haajir सुरु गर्न आफ्नो इमेल पुष्टि गर्नुहोस्।");
    expect(m.html.slice(i)).toContain(">इमेल पुष्टि गर्नुहोस्</a>");
    expect(m.html.slice(i)).toContain("तपाईंले यो अनुरोध गर्नुभएको होइन");
    expect(m.text.indexOf("नमस्ते")).toBeGreaterThan(m.text.indexOf("If you didn't ask for this"));
    expect(m.text).toContain(`इमेल पुष्टि गर्नुहोस्: ${LINK}`);
    // A type without second language text has no block (and no stray note).
    const inv = renderAuthEmail(mergeBranding(null, parseOrThrow(HAAJIR)), "invite", LINK, undefined, { appName: "Haajir", email: "p@x.test" });
    expect(inv.html).not.toContain('lang="ne"');
    expect(inv.text).not.toContain("तपाईंले");
  });

  it("hostile input is escaped or refused, never taken as HTML", () => {
    const evil = "<script>alert(1)</script><img src=x onerror=alert(2)>\"'&";
    const b = mergeBranding(null, parseOrThrow({ footer: evil, templates: { signup: { intro: evil, buttonLabel: "<b>x</b>", subject: "Hi <b>{appName}</b>" } }, secondaryLanguage: { lang: "ne", templates: { signup: { intro: evil } } } }))!;
    const m = renderAuthEmail(b, "signup", LINK, "<i>1</i>", { appName: "<App>", email: "\"><svg onload=1>@x.test" });
    expect(m.html).not.toMatch(/<script|<img src=x|<svg|<b>|<i>|onerror=alert\(2\)>/);
    expect(m.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(m.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(m.subject).toBe("Hi <b><App></b>");
    // Refused at the door: non https logos, CSS in the colour, header breaking subjects, unknown keys and types.
    for (const bad of [
      { logoUrl: "javascript:alert(1)" }, { logoUrl: "http://haajir.test/logo.png" }, { logoUrl: "https://x.test/a\" onerror=\"alert(1)" }, { logoUrl: "data:image/png;base64,AAAA" },
      { brandColor: "red;background:url(https://evil.test)" }, { brandColor: "#12345" }, { replyTo: "not an email" },
      { templates: { signup: { subject: "Hi\r\nBcc: victim@x.test" } } }, { footer: "a\nb" }, { templates: { signup: { html: "<b>" } } }, { templates: { welcome: { subject: "x" } } },
      { secondaryLanguage: { lang: "ne\"><script>", templates: {} } }, { extra: 1 },
    ]) {
      expect(() => parseOrThrow(bad), JSON.stringify(bad)).toThrow();
    }
    // A stored value that no longer validates is ignored (the default email), not rendered.
    expect(parseBranding('{"logoUrl":"javascript:x"}')).toBeNull();
    expect(parseBranding("not json")).toBeNull();
  });
});


describe("REST: create, PATCH, GET and preview", () => {
  it("create takes branding, PATCH merges it, GET shows it (never the secret), and the hook sends the branded mail with Reply-To", async () => {
    const made = await api(key, "POST", "/auth-email-hooks", { from: "no-reply@haajir.test", secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Haajir", branding: { brandColor: "#0F7B6C" } });
    expect(made.status).toBe(201);
    expect(made.body.hook.branding).toEqual({ brandColor: "#0f7b6c" });
    const id = made.body.hook.id as string;
    const p = await api(key, "PATCH", `/auth-email-hooks/${id}`, { branding: HAAJIR });
    expect(p.status).toBe(200);
    expect(p.body.hook.branding.replyTo).toBe("support@haajir.test");
    expect(p.body.hook.branding.templates.signup.buttonLabel).toBe("Confirm my email");
    // Merge: one type changes, the others stay; null clears one field.
    const p2 = await api(key, "PATCH", `/auth-email-hooks/${id}`, { branding: { footer: null, templates: { recovery: { subject: "New password for {appName}" } } } });
    expect(p2.body.hook.branding.footer).toBeUndefined();
    expect(p2.body.hook.branding.templates.signup.subject).toBe("Welcome to {appName}");
    expect(p2.body.hook.branding.templates.recovery.subject).toBe("New password for {appName}");
    const list = await api(key, "GET", "/auth-email-hooks");
    expect(list.body.hooks[0].branding.logoUrl).toBe("https://haajir.test/logo.png");
    expect(JSON.stringify(list.body)).not.toMatch(/whsec_|secret/i);
    expect(JSON.stringify(p2.body)).not.toMatch(/whsec_/);

    const status = await hookCall(new URL(made.body.hook.url).pathname, { user: { email: "Parent@Example.com" }, email_data: { token: "305805", token_hash: "abc123", redirect_to: "https://haajir.test/welcome", email_action_type: "signup", site_url: "https://haajir.test" } });
    expect(status).toBe(200);
    const mail = ctx.outbound.sent.at(-1)!;
    expect(mail.replyTo).toBe("support@haajir.test");
    expect(mail.subject).toBe("Welcome to Haajir / हाजिरमा स्वागत छ");
    expect(mail.html).toContain("background:#0f7b6c");
    expect(mail.html).toContain('lang="ne"');
    expect(mail.text).toContain("https://abcd1234.supabase.co/auth/v1/verify?token=abc123&type=signup");
    expect(mail.text).toContain("Hi parent@example.com,");

    // branding: null goes back to exactly the round 13 email, without Reply-To.
    expect((await api(key, "PATCH", `/auth-email-hooks/${id}`, { branding: null })).body.hook.branding).toBeNull();
    await hookCall(new URL(made.body.hook.url).pathname, { user: { email: "p2@example.com" }, email_data: { token: "1", token_hash: "h", redirect_to: "", email_action_type: "signup", site_url: "https://haajir.test" } });
    const plain = ctx.outbound.sent.at(-1)!;
    expect(plain.subject).toBe("Confirm your email for Haajir");
    expect(plain.replyTo).toBeFalsy();
  });

  it("PATCH refuses hostile values with a 422 naming the field; appName and from change too", async () => {
    const id = (await api(key, "POST", "/auth-email-hooks", { from: "no-reply@haajir.test", secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Haajir" })).body.hook.id;
    const bad = await api(key, "PATCH", `/auth-email-hooks/${id}`, { branding: { logoUrl: "javascript:alert(1)" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/^branding\.logoUrl: /);
    expect((await api(key, "POST", "/auth-email-hooks", { from: "no-reply@haajir.test", secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", branding: { brandColor: "blue" } })).status).toBe(422);
    expect((await api(key, "GET", "/auth-email-hooks")).body.hooks).toHaveLength(1);
    const renamed = await api(key, "PATCH", `/auth-email-hooks/${id}`, { appName: "Haajir HQ" });
    expect(renamed.body.hook).toMatchObject({ appName: "Haajir HQ", from: "no-reply@haajir.test", branding: null });
    expect((await api(key, "PATCH", `/auth-email-hooks/${id}`, { from: "nobody@haajir.test" })).status).toBe(422);
  });

  it("preview returns subject, html and text for a type and sends nothing; unsaved branding can be tried", async () => {
    const id = (await api(key, "POST", "/auth-email-hooks", { from: "no-reply@haajir.test", secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Haajir", branding: HAAJIR })).body.hook.id;
    const sent = ctx.outbound.sent.length;
    const pv = await api(key, "POST", `/auth-email-hooks/${id}/preview?type=signup`);
    expect(pv.status).toBe(200);
    expect(pv.body.preview).toMatchObject({ type: "signup", to: "parent@example.com", subject: "Welcome to Haajir / हाजिरमा स्वागत छ", replyTo: "support@haajir.test" });
    expect(pv.body.preview.html).toContain("https://haajir.test/logo.png");
    expect(pv.body.preview.text).toContain("Your code is 123456.");
    const tryIt = await api(key, "POST", `/auth-email-hooks/${id}/preview?type=magiclink`, { email: "ram@example.com", branding: { templates: { magiclink: { subject: "Sign in to {appName}, {email}" } } } });
    expect(tryIt.body.preview.subject).toBe("Sign in to Haajir, ram@example.com");
    expect((await api(key, "GET", "/auth-email-hooks")).body.hooks[0].branding.templates.magiclink).toBeUndefined();
    expect((await api(key, "POST", `/auth-email-hooks/${id}/preview?type=welcome`)).status).toBe(422);
    expect(ctx.outbound.sent.length).toBe(sent);
  });
});

describe("permissions", () => {
  it("a read only key can list and preview but not PATCH; another workspace's hook is 404; agent and member keys are refused", async () => {
    const id = (await api(key, "POST", "/auth-email-hooks", { from: "no-reply@haajir.test", secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Haajir" })).body.hook.id;
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret as string;
    expect((await api(ro, "GET", "/auth-email-hooks")).status).toBe(200);
    expect((await api(ro, "POST", `/auth-email-hooks/${id}/preview?type=recovery`)).status).toBe(200);
    const denied = await api(ro, "PATCH", `/auth-email-hooks/${id}`, { branding: { footer: "x" } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("read_only_key");
    expect((await api(ro, "POST", "/auth-email-hooks", { from: "no-reply@haajir.test", secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co" })).status).toBe(403);

    const other = new Client(ctx.app);
    await other.signup("boss@other.test", "Other Boss");
    const otherKey = (await other.post("/api/developer/keys", { name: "Other" })).body.secret as string;
    expect((await api(otherKey, "PATCH", `/auth-email-hooks/${id}`, { branding: { footer: "mine now" } })).status).toBe(404);
    expect((await api(otherKey, "POST", `/auth-email-hooks/${id}/preview?type=signup`)).status).toBe(404);
    expect((await api(key, "GET", "/auth-email-hooks")).body.hooks[0].branding).toBeNull();

    const agent = (await owner.post("/api/team/agents", { name: "Builder" })).body;
    expect((await api(agent.secret, "PATCH", `/auth-email-hooks/${id}`, { branding: { footer: "x" } })).status).toBe(403);
  });

  it("MCP: update_auth_email_hook brands with a write key; a read only key and another workspace are refused", async () => {
    const id = (await api(key, "POST", "/auth-email-hooks", { from: "no-reply@haajir.test", secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Haajir" })).body.hook.id;
    const connect = async (k: string) => {
      const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
      const client = new McpClient({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${k}` } }, fetch: fetchViaApp }));
      return client;
    };
    const mcp = await connect(key);
    const r = await mcp.callTool({ name: "update_auth_email_hook", arguments: { hookId: id, branding: { replyTo: "help@haajir.test", secondaryLanguage: HAAJIR.secondaryLanguage } } }) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeFalsy();
    const hook = JSON.parse(r.content[0].text).hook;
    expect(hook.branding.replyTo).toBe("help@haajir.test");
    expect(hook.branding.secondaryLanguage.lang).toBe("ne");
    const bad = await mcp.callTool({ name: "update_auth_email_hook", arguments: { hookId: id, branding: { logoUrl: "http://x.test/a.png" } } }) as { content: { text: string }[]; isError?: boolean };
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/validation_failed: branding\.logoUrl/);
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret as string;
    const roRes = await (await connect(ro)).callTool({ name: "update_auth_email_hook", arguments: { hookId: id, branding: null } }) as { content: { text: string }[]; isError?: boolean };
    expect(roRes.isError).toBe(true);
    expect(roRes.content[0].text).toMatch(/read_only_key/);
    const other = new Client(ctx.app);
    await other.signup("boss@other.test", "Other Boss");
    const otherKey = (await other.post("/api/developer/keys", { name: "Other" })).body.secret as string;
    const nf = await (await connect(otherKey)).callTool({ name: "update_auth_email_hook", arguments: { hookId: id, branding: null } }) as { content: { text: string }[]; isError?: boolean };
    expect(nf.isError).toBe(true);
    expect(nf.content[0].text).toMatch(/not_found/);
    expect((await api(key, "GET", "/auth-email-hooks")).body.hooks[0].branding.replyTo).toBe("help@haajir.test");
  });
});

import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { isJsonContentType } from "@/server/middleware";
import { isPublicHost } from "@/server/lib/ssrf";
import { scrubEvent, scrubUrl } from "@/shared/sentry-scrub";

// Round 11 security audit: regression tests for what it changed.

describe("CSRF guard", () => {
  it("accepts JSON media types only, not JSON named inside a parameter", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/merge-patch+json")).toBe(true);
    expect(isJsonContentType("text/plain; charset=application/json")).toBe(false);
    expect(isJsonContentType("text/plain;application/json")).toBe(false);
    expect(isJsonContentType("multipart/form-data; boundary=application/json")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });

  it("refuses a cookie request whose body is text/plain, and a cross-site request with no Origin", async () => {
    const { app } = await makeTestApp();
    const c = new Client(app);
    await c.signup("csrf@example.com");
    const plain = await c.call("POST", "/api/tasks", undefined, { "content-type": "text/plain; charset=application/json" });
    expect(plain.status).toBe(403);
    const sneaky = await app.request("/api/tasks", { method: "POST", headers: { cookie: c.cookie, host: "localhost", "content-type": "text/plain;application/json" }, body: JSON.stringify({ title: "x" }) });
    expect(sneaky.status).toBe(403);
    const crossSite = await c.call("POST", "/api/tasks", { title: "x" }, { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body.error.code).toBe("bad_origin");
    const sameOrigin = await c.call("POST", "/api/tasks", { title: "Fine" }, { "sec-fetch-site": "same-origin" });
    expect(sameOrigin.status).toBe(201);
  });
});

describe("outgoing webhook targets (SSRF)", () => {
  const host = (u: string) => new URL(u).hostname;
  it("refuses loopback, private, link-local, metadata and internal names in every spelling", () => {
    for (const u of [
      "https://localhost/x", "https://LOCALHOST./x", "https://127.0.0.1/x", "https://127.1/x", "https://2130706433/x", "https://0x7f.0.0.1/x",
      "https://0.0.0.0/x", "https://10.1.2.3/x", "https://172.16.0.1/x", "https://172.31.255.255/x", "https://192.168.1.1/x",
      "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/x", "https://198.18.0.1/x", "https://224.0.0.1/x",
      "https://[::1]/x", "https://[::]/x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:10.0.0.1]/x", "https://[fd00::1]/x", "https://[fe80::1]/x",
      "https://db.internal/x", "https://printer.local/x", "https://router.lan/x", "https://intranet/x",
    ]) expect([u, isPublicHost(host(u))]).toEqual([u, false]);
  });
  it("allows public names and addresses", () => {
    for (const u of ["https://hooks.example.com/x", "https://8.8.8.8/x", "https://172.32.0.1/x", "https://[2606:4700::1111]/x", "https://[::ffff:8.8.8.8]/x"]) {
      expect([u, isPublicHost(host(u))]).toEqual([u, true]);
    }
  });
  it("refuses private webhook URLs the old pattern let through, in production", async () => {
    const { app } = await makeTestApp({ APP_MODE: "production" });
    const c = new Client(app);
    await c.signup("hooks@example.com");
    for (const url of ["https://[::ffff:169.254.169.254]/hook", "https://100.100.100.200/hook", "https://[fe80::1]/hook", "https://metadata/hook"]) {
      expect([url, (await c.post("/api/developer/webhooks", { url, events: ["*"] })).status]).toEqual([url, 400]);
    }
  });
});

describe("Sentry scrubbing", () => {
  it("drops bodies, cookies and credential headers, and masks tokens and emails", () => {
    const e = scrubEvent({
      message: "Login failed for ada@example.com with Bearer abcdefghijklmnop",
      request: { url: "https://x.test/api/auth/reset?token=s3cret&email=a@b.co", data: { password: "hunter2" }, cookies: { s: "1" }, query_string: "token=s3cret",
        headers: { authorization: "Bearer mm_live_abcdefghijkl", cookie: "s=1", "user-agent": "UA", "cf-connecting-ip": "1.2.3.4" } },
      user: { id: "usr_1", email: "ada@example.com", ip_address: "1.2.3.4" },
      extra: { apiKey: "mm_live_zzzzzzzzzzzz", note: "from bob@example.org" },
      exception: { values: [{ value: "Failed query: params: ada@example.com" }] },
      breadcrumbs: [{ data: { url: "/api/x?code=123456" } }],
    });
    const s = JSON.stringify(e);
    for (const leak of ["hunter2", "s3cret", "ada@example.com", "bob@example.org", "mm_live_abcdefghijkl", "mm_live_zzzzzzzzzzzz", "abcdefghijklmnop", "1.2.3.4", "123456"]) expect(s).not.toContain(leak);
    expect(e.user).toEqual({ id: "usr_1" });
    expect(e.request.headers["user-agent"]).toBe("UA");
    expect(scrubUrl("/a?b=1&c=2")).toBe("/a?b=[redacted]&c=[redacted]");
  });
});

describe("stored content", () => {
  it("drops javascript: and data: links from docs and keeps safe ones", async () => {
    const { app } = await makeTestApp();
    const c = new Client(app);
    await c.signup("docs@example.com");
    const text = (href: string) => ({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] });
    const content = { type: "doc", content: [{ type: "paragraph", content: [text("javascript:alert(1)"), text(" JaVa\tScRiPt:alert(2)"), text("data:text/html,x"), text("https://example.com"), text("mailto:a@example.com")] }] };
    const made = await c.post("/api/docs", { title: "Links", content });
    expect(made.status).toBe(201);
    const doc = await c.get(`/api/docs/${made.body.id ?? made.body.doc?.id}`);
    const s = JSON.stringify(doc.body);
    expect(s).not.toMatch(/"href":"\s*(javascript|data):/i);
    expect(s).not.toMatch(/"href":"[^"]*script:/i);
    expect(s).toContain('"href":"https://example.com"');
    expect(s).toContain('"href":"mailto:a@example.com"');
  });
});

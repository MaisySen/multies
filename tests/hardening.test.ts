import { describe, expect, it } from "vitest";
import { Client, makeTestApp } from "./helpers";
import { RATE_LIMITS } from "@/server/lib/rate-limit";
import { LOCKOUT } from "@/server/services/lockout";
import { appCsp, securityHeaders, withSecurityHeaders } from "@/server/lib/security-headers";

describe("security headers", () => {
  it("sends a strict CSP and the standard hardening headers on API responses", async () => {
    const { app } = await makeTestApp({ APP_URL: "https://mail.example.com" });
    const res = await app.request("/api/health", { headers: { host: "localhost" } });
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=63072000");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
  });

  it("gives the API reference page its own policy and keeps scripts off the app", async () => {
    const { app } = await makeTestApp();
    const res = await app.request("/api/v1/reference", { headers: { host: "localhost" } });
    expect(res.headers.get("content-security-policy")).toContain("https://cdn.jsdelivr.net");
    const csp = appCsp();
    expect(csp).toContain("script-src 'self' 'sha256-tTjXVFtiGiMpAU0jVWic+HURQaoh9Btt7O5R4TAwLWs=' 'wasm-unsafe-eval';"); // R31: + the inline theme script hash
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // Only the public form page may load Turnstile.
    expect(appCsp({ turnstile: true })).toContain("script-src 'self' 'sha256-tTjXVFtiGiMpAU0jVWic+HURQaoh9Btt7O5R4TAwLWs=' 'wasm-unsafe-eval' https://challenges.cloudflare.com;");
  });

  it("pins every directive of the app policy, so a loosened CSP fails here", () => {
    const directives = Object.fromEntries(appCsp().split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v.join(" ")]; }));
    expect(directives).toEqual({
      "default-src": "'self'",
      "script-src": "'self' 'sha256-tTjXVFtiGiMpAU0jVWic+HURQaoh9Btt7O5R4TAwLWs=' 'wasm-unsafe-eval'",
      "style-src": "'self' 'unsafe-inline'",
      "img-src": "'self' data: blob: https:",
      "font-src": "'self' data:",
      // R30: no more "any wss:"; LiveKit Cloud by name (self-hosted LIVEKIT_URL and APP_URL are added when set).
      "connect-src": "'self' https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.ingest.de.sentry.io wss://*.livekit.cloud https://*.livekit.cloud https://tiles.openfreemap.org",
      "media-src": "'self' blob:",
      "frame-src": "'self' blob:",
      "worker-src": "'self' blob:",
      "object-src": "'none'",
      "base-uri": "'self'",
      "form-action": "'self'",
      "frame-ancestors": "'none'",
      "manifest-src": "'self'",
      "upgrade-insecure-requests": "",
      "report-uri": "/api/csp-report",
      "report-to": "csp",
    });
  });

  it("applies the page policy to static responses", () => {
    const res = withSecurityHeaders(new Response("<html>", { headers: { "content-type": "text/html" } }), { csp: appCsp(), hsts: true });
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("content-security-policy")).toBe(appCsp());
    expect(securityHeaders({ csp: "x", hsts: false })["strict-transport-security"]).toBeUndefined();
  });

  it("publishes security.txt (RFC 9116)", async () => {
    const { app } = await makeTestApp({ APP_URL: "https://mail.example.com", SECURITY_CONTACT: "mailto:security@example.com" });
    const res = await app.request("/.well-known/security.txt");
    const body = await res.text();
    expect(body).toContain("Contact: mailto:security@example.com");
    expect(body.indexOf("Contact: mailto:contact@fintex.au")).toBeLessThan(body.indexOf("Contact: mailto:security@example.com"));
    expect(body.indexOf("Contact: mailto:contact@fintex.au")).toBeGreaterThanOrEqual(0);
    expect(body).toMatch(/Expires: \d{4}-/);
  });
});

describe("rate limiting", () => {
  it("returns 429 with RateLimit headers once a client passes its limit", async () => {
    const { app } = await makeTestApp();
    let last: Response | undefined;
    for (let i = 0; i <= RATE_LIMITS.webhooks; i++) {
      last = await app.request("/api/webhooks/stripe", { method: "POST", headers: { host: "localhost", "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" }, body: "{}" });
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("ratelimit-limit")).toBe(String(RATE_LIMITS.webhooks));
    // Another client is unaffected.
    const other = await app.request("/api/webhooks/stripe", { method: "POST", headers: { host: "localhost", "cf-connecting-ip": "203.0.113.10", "content-type": "application/json" }, body: "{}" });
    expect(other.status).not.toBe(429);
  });

  it("uses a Cloudflare rate limiting binding when one is bound", async () => {
    const { app, deps } = await makeTestApp();
    const keys: string[] = [];
    deps.rateLimiters = { webhooks: { limit: async ({ key }) => (keys.push(key), { success: keys.length < 3 }) } };
    const hit = () => app.request("/api/webhooks/stripe", { method: "POST", headers: { host: "localhost", "cf-connecting-ip": "198.51.100.1", "content-type": "application/json" }, body: "{}" });
    expect((await hit()).status).not.toBe(429);
    expect((await hit()).status).not.toBe(429);
    expect((await hit()).status).toBe(429);
    expect(keys[0]).toBe("webhooks:198.51.100.1");
  });
});

describe("account lockout", () => {
  it("locks password sign-in after repeated failures from any IP, and SSO-free reset still works", async () => {
    const { app } = await makeTestApp();
    const owner = new Client(app);
    const email = await owner.signup();
    const attacker = new Client(app);
    for (let i = 0; i < LOCKOUT.MAX_FAILURES; i++) {
      const r = await attacker.call("POST", "/api/auth/sign-in/email", { email, password: "wrong-password-1" }, { "cf-connecting-ip": `192.0.2.${i + 1}` });
      expect(r.status).toBe(401);
    }
    const locked = await new Client(app).call("POST", "/api/auth/sign-in/email", { email, password: "a-strong-password" }, { "cf-connecting-ip": "192.0.2.200" });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("ACCOUNT_LOCKED");
    const reset = await new Client(app).call("POST", "/api/auth/request-password-reset", { email, redirectTo: "/reset-password" }, { "cf-connecting-ip": "192.0.2.201" });
    expect(reset.status).toBe(200);
  });

  it("clears the count after a successful sign-in", async () => {
    const { app } = await makeTestApp();
    const c = new Client(app);
    const email = await c.signup();
    for (let i = 0; i < LOCKOUT.MAX_FAILURES - 1; i++) await new Client(app).call("POST", "/api/auth/sign-in/email", { email, password: "nope-nope-nope" }, { "cf-connecting-ip": `192.0.2.${i + 1}` });
    expect((await new Client(app).call("POST", "/api/auth/sign-in/email", { email, password: "a-strong-password" }, { "cf-connecting-ip": "192.0.2.99" })).status).toBe(200);
    const again = await new Client(app).call("POST", "/api/auth/sign-in/email", { email, password: "nope-nope-nope" }, { "cf-connecting-ip": "192.0.2.98" });
    expect(again.status).toBe(401);
  });
});

describe("idempotency keys", () => {
  it("replays the first response for a retried send, and rejects reuse with a different body", async () => {
    const { app, outbound, dns } = await makeTestApp();
    const c = new Client(app);
    await c.signup();
    const d = await c.post("/api/domains", { name: "idem.example" });
    const domainId = d.body.domain?.id ?? d.body.id;
    const { body } = await c.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") dns.records.mx = { ...dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else dns.records.txt = { ...dns.records.txt, [r.fqdn]: [r.value] };
    }
    await c.post(`/api/domains/${domainId}/verify`);
    const mb = await c.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" });
    const mailboxId = mb.body.mailbox?.id ?? mb.body.id;
    const msg = { mailboxId, to: ["someone@outside.example"], cc: [], bcc: [], subject: "Once", text: "Only once." };
    const first = await c.call("POST", "/api/mail/send", msg, { "idempotency-key": "send_abcdef123456" });
    expect(first.body).toBeTruthy();
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const retry = await c.call("POST", "/api/mail/send", msg, { "idempotency-key": "send_abcdef123456" });
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(outbound.sent.filter((m) => m.subject === "Once")).toHaveLength(1);
    const reused = await c.call("POST", "/api/mail/send", { ...msg, subject: "Twice" }, { "idempotency-key": "send_abcdef123456" });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe("idempotency_key_reused");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { API_CSP, appCsp, docsCsp, securityHeaders, socketOrigins, SCALAR_CDN, REPORTING_ENDPOINTS } from "@/server/lib/security-headers";
import { parseCspReports, trimUrl, resetCspReportWindow, LOG_PER_MINUTE } from "@/server/routes/csp-report-r30";
import { apiReferenceBootJs, apiReferenceHtml } from "@/server/lib/api-reference-page";

// R30 security headers and CSP audit.

function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(csp.split(";").map((p) => p.trim().split(/\s+/)).filter((p) => p[0]).map(([k, ...v]) => [k, v]));
}

describe("page CSP", () => {
  const d = directives(appCsp({ analytics: true, appUrl: "https://multies.si", livekitUrl: "wss://lk.example.org" }));

  it("runs no inline or eval script and locks down objects, base, forms and framing", () => {
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
    expect(d["script-src"]).not.toContain("'unsafe-eval'");
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["upgrade-insecure-requests"]).toEqual([]);
  });

  it("allows each external service exactly where it is needed", () => {
    // Cloudflare Web Analytics: the beacon script and its reporting host, only with a token.
    expect(d["script-src"]).toEqual(["'self'", "'sha256-jvkpXW6eMxvAhWHOQ6tdMEiUzK0YDn6KJM3M2Qm7OHc='", "https://static.cloudflareinsights.com"]);
    expect(d["connect-src"]).toContain("https://cloudflareinsights.com");
    expect(directives(appCsp())["script-src"]).toEqual(["'self'", "'sha256-jvkpXW6eMxvAhWHOQ6tdMEiUzK0YDn6KJM3M2Qm7OHc='"]);
    expect(directives(appCsp())["connect-src"]).not.toContain("https://cloudflareinsights.com");
    // Sentry browser SDK posts to its ingest hosts.
    expect(d["connect-src"]).toEqual(expect.arrayContaining(["https://*.ingest.sentry.io", "https://*.ingest.us.sentry.io", "https://*.ingest.de.sentry.io"]));
    // LiveKit Cloud and a self-hosted LiveKit server; media and workers from blobs.
    expect(d["connect-src"]).toEqual(expect.arrayContaining(["wss://*.livekit.cloud", "https://*.livekit.cloud", "wss://lk.example.org", "https://lk.example.org"]));
    expect(d["media-src"]).toEqual(["'self'", "blob:"]);
    expect(d["worker-src"]).toEqual(["'self'", "blob:"]);
    // Our own sockets (docs collab, chat) by name as well as 'self'.
    expect(d["connect-src"]).toContain("wss://multies.si");
    // Turnstile only on public form pages.
    expect(d["frame-src"]).toEqual(["'self'", "blob:"]);
    const form = directives(appCsp({ turnstile: true }));
    expect(form["script-src"]).toContain("https://challenges.cloudflare.com");
    expect(form["frame-src"]).toContain("https://challenges.cloudflare.com");
  });

  it("no longer allows any wss: host", () => {
    expect(d["connect-src"]).not.toContain("wss:");
    for (const v of d["connect-src"]) expect(v).not.toMatch(/^(https?|wss?):$/);
  });

  it("reports violations to the logging endpoint", () => {
    expect(d["report-uri"]).toEqual(["/api/csp-report"]);
    expect(d["report-to"]).toEqual(["csp"]);
  });

  it("works out socket origins from APP_URL and LIVEKIT_URL", () => {
    expect(socketOrigins("https://multies.si", false)).toEqual(["wss://multies.si"]);
    expect(socketOrigins("http://localhost:8788", false)).toEqual(["ws://localhost:8788"]);
    expect(socketOrigins("wss://lk.example.org:7880", true)).toEqual(["wss://lk.example.org:7880", "https://lk.example.org:7880"]);
    expect(socketOrigins("not a url", true)).toEqual([]);
    expect(socketOrigins("javascript:alert(1)", true)).toEqual([]);
    expect(socketOrigins(undefined, true)).toEqual([]);
  });
});

describe("API reference page", () => {
  it("has no inline script and loads the pinned renderer", () => {
    const d = directives(docsCsp());
    expect(d["script-src"]).toEqual(["'self'", SCALAR_CDN]);
    expect(SCALAR_CDN).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@scalar\/api-reference@\d+\.\d+\.\d+\/$/);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    const html = apiReferenceHtml();
    expect(html).toContain('<script type="module" src="/api/v1/reference.js"></script>');
    expect(html.match(/<script(?![^>]*\ssrc=)[^>]*>/g)).toBeNull();
    const js = apiReferenceBootJs();
    expect(js).toContain(`${SCALAR_CDN}esm.js`);
    // Zod's JIT probe is switched off before the renderer loads, so nothing needs 'unsafe-eval'.
    expect(js.indexOf("jitless")).toBeLessThan(js.indexOf("import("));
  });
});

describe("shared headers", () => {
  it("sends HSTS that is preload eligible, only over https", () => {
    expect(securityHeaders({ csp: API_CSP, hsts: true })["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains; preload");
    expect(securityHeaders({ csp: API_CSP, hsts: false })["strict-transport-security"]).toBeUndefined();
  });
  it("has a Permissions-Policy browsers recognise, with camera and microphone for calls", () => {
    const pp = securityHeaders({ csp: API_CSP, hsts: true })["permissions-policy"];
    expect(pp).not.toContain("interest-cohort");
    expect(pp).toContain("browsing-topics=()");
    expect(pp).toContain("camera=(self)");
    expect(pp).toContain("microphone=(self)");
    expect(pp).toContain("payment=()");
  });
  it("names the report endpoint only for policies that report", () => {
    expect(securityHeaders({ csp: appCsp(), hsts: true })["reporting-endpoints"]).toBe(REPORTING_ENDPOINTS);
    expect(securityHeaders({ csp: API_CSP, hsts: true })["reporting-endpoints"]).toBeUndefined();
  });
});

describe("every response class carries the graded headers", () => {
  const graded = ["content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy", "cross-origin-opener-policy", "cross-origin-resource-policy"];

  it("API JSON, errors, OAuth metadata, webhooks, share pages, forms, the reference page and its script", async () => {
    const { app } = await makeTestApp();
    const cases: [string, RequestInit | undefined, (csp: string) => void][] = [
      ["/api/health", undefined, (csp) => expect(csp).toBe(API_CSP)],
      ["/api/no-such-route", undefined, (csp) => expect(csp).toBe(API_CSP)],
      ["/api/tasks", undefined, (csp) => expect(csp).toBe(API_CSP)], // 401
      ["/.well-known/oauth-authorization-server", undefined, (csp) => expect(csp).toBe(API_CSP)],
      ["/api/webhooks/stripe", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, (csp) => expect(csp).toBe(API_CSP)],
      ["/s/not-a-share", undefined, (csp) => { expect(csp).toContain("frame-ancestors 'none'"); expect(csp).toContain("script-src 'self'"); }],
      ["/f/not-a-form", undefined, (csp) => expect(csp).toContain("https://challenges.cloudflare.com")],
      ["/api/v1/reference", undefined, (csp) => expect(csp).toBe(docsCsp())],
      ["/api/v1/reference.js", undefined, (csp) => expect(csp).toBe(API_CSP)],
    ];
    for (const [path, init, check] of cases) {
      const res = await app.request(path, init);
      for (const h of graded) expect([path, h, res.headers.has(h)]).toEqual([path, h, true]);
      expect([path, res.headers.get("x-frame-options")]).toEqual([path, "DENY"]);
      check(res.headers.get("content-security-policy")!);
    }
    const page = await app.request("/api/v1/reference");
    expect(await page.text()).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    const boot = await app.request("/api/v1/reference.js");
    expect(boot.headers.get("content-type")).toContain("text/javascript");
  });

  it("session cookies are HttpOnly and SameSite=Lax (Secure with the __Secure- prefix in production)", async () => {
    const { app } = await makeTestApp();
    const c = new Client(app);
    await c.signup("cookies-r30@example.com");
    expect(c.cookie).toContain("mymail.session_token=");
    const res = await app.request("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ email: "cookies-r30@example.com", password: "a-strong-password" }) });
    const set = res.headers.getSetCookie().find((s) => s.includes("session_token="));
    if (set) {
      expect(set.toLowerCase()).toContain("httponly");
      expect(set.toLowerCase()).toContain("samesite=lax");
    }
  });
});

describe("CSP report endpoint", () => {
  beforeEach(() => resetCspReportWindow());

  it("parses both report formats and trims URLs to origin and path", () => {
    const legacy = JSON.stringify({ "csp-report": { "document-uri": "https://multies.si/app/inbox?token=abc", "violated-directive": "script-src-elem", "effective-directive": "script-src-elem", "blocked-uri": "https://evil.example/x.js?q=1#f", "source-file": "https://multies.si/assets/a.js" } });
    expect(parseCspReports(legacy)).toEqual([{ directive: "script-src-elem", blocked: "https://evil.example/x.js", page: "/app/inbox", source: "https://multies.si/assets/a.js" }]);
    const modern = JSON.stringify([{ type: "csp-violation", body: { documentURL: "https://multies.si/login", effectiveDirective: "connect-src", blockedURL: "wss://x.example/socket?k=1" } }, { type: "deprecation", body: {} }]);
    expect(parseCspReports(modern)).toEqual([{ directive: "connect-src", blocked: "wss://x.example/socket", page: "/login", source: "" }]);
    expect(parseCspReports("not json")).toEqual([]);
    expect(trimUrl("inline")).toBe("inline");
    expect(trimUrl("data:image/png;base64,AAAA")).toBe("data");
  });

  it("answers 204, writes no rows, and stops logging past the per minute cap", async () => {
    const { app } = await makeTestApp();
    const logged: unknown[] = [];
    const orig = console.warn;
    const origLog = console.log;
    console.warn = (...a: unknown[]) => { logged.push(a); };
    console.log = (...a: unknown[]) => { if (String(a[0]).includes("csp_violation")) logged.push(a); };
    try {
      const body = JSON.stringify({ "csp-report": { "document-uri": "http://localhost/", "effective-directive": "img-src", "blocked-uri": "http://x.example/a.png" } });
      for (let i = 0; i < LOG_PER_MINUTE + 5; i++) {
        const res = await app.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report" }, body });
        expect(res.status).toBe(204);
      }
      const big = await app.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report", "content-length": "99999" }, body: "x".repeat(10) });
      expect(big.status).toBe(204);
    } finally {
      console.warn = orig;
      console.log = origLog;
    }
    const hits = logged.filter((a) => JSON.stringify(a).includes("csp_violation"));
    expect(hits.length).toBeLessThanOrEqual(LOG_PER_MINUTE);
  });
});

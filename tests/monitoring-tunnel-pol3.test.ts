import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { makeTestApp } from "./helpers";
import { envelopeDsn, parseDsn, resetMonitoringTunnelLimits, sameDsn, MAX_BODY, PER_IP_PER_MINUTE } from "../src/server/routes/monitoring-tunnel-handler-pol3";
import { MONITORING_TUNNEL_PATH } from "../src/server/routes/monitoring-tunnel-pol3";

/** POL3: the same origin tunnel for browser error reports (checks, caps, limits, forwards server side). */
const DSN = "https://abc123@o111.ingest.us.sentry.io/222";
const env = (dsn = DSN) => `${JSON.stringify({ event_id: "e1", sent_at: "2026-11-03T05:00:00Z", dsn })}\n{"type":"event"}\n{"message":"pol3 tunnel test"}\n`;

let calls: { url: string; init: RequestInit }[] = [];
let answer: () => Response = () => new Response("{}", { status: 200 });
const stub = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return answer(); }) as typeof fetch;

async function app(extra: Record<string, string> = { SENTRY_DSN_WEB: DSN }) {
  const ctx = await makeTestApp(extra, { fetch: stub });
  const post = (body: BodyInit, headers: Record<string, string> = {}) => ctx.app.request(MONITORING_TUNNEL_PATH, { method: "POST", body, headers: { "content-type": "text/plain;charset=UTF-8", ...headers } });
  return { ctx, post };
}

beforeEach(() => { calls = []; answer = () => new Response("{}", { status: 200 }); resetMonitoringTunnelLimits(); });

describe("monitoring tunnel (POL3)", () => {
  it("parses DSNs and compares host, project and key", () => {
    expect(parseDsn(DSN)).toEqual({ host: "o111.ingest.us.sentry.io", projectId: "222", publicKey: "abc123" });
    expect(parseDsn("http://abc@o1.ingest.sentry.io/2")).toBeNull();
    expect(parseDsn("https://o1.ingest.sentry.io/2")).toBeNull();
    expect(parseDsn("https://k@o1.ingest.sentry.io/a/2")).toBeNull();
    expect(sameDsn(envelopeDsn(env()), parseDsn(DSN))).toBe(true);
    expect(sameDsn(envelopeDsn(env("https://abc123@o111.ingest.us.sentry.io/999")), parseDsn(DSN))).toBe(false);
    expect(sameDsn(envelopeDsn(env("https://other@o111.ingest.us.sentry.io/222")), parseDsn(DSN))).toBe(false);
    expect(envelopeDsn("not json\n{}")).toBeNull();
  });

  it("forwards our envelope to our project's ingest URL, with no cookie or caller headers", async () => {
    const { post } = await app();
    const r = await post(env(), { cookie: "__Host-mymail.session_token=secret", "x-forwarded-for": "1.2.3.4" });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://o111.ingest.us.sentry.io/api/222/envelope/");
    const h = new Headers(calls[0].init.headers);
    expect(h.get("cookie")).toBeNull();
    expect(h.get("x-forwarded-for")).toBeNull();
    expect(h.get("content-type")).toBe("application/x-sentry-envelope");
    expect(new TextDecoder().decode(calls[0].init.body as ArrayBuffer)).toContain("pol3 tunnel test");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses another project or key, a missing DSN, an empty or junk body, and anything over the cap", async () => {
    const { post } = await app();
    expect((await post(env("https://abc123@o111.ingest.us.sentry.io/999"))).status).toBe(400);
    expect((await post(env("https://abc123@evil.example.com/222"))).status).toBe(400);
    expect((await post(`{"event_id":"x"}\n{}`)).status).toBe(400);
    expect((await post("hello")).status).toBe(400);
    expect((await post("")).status).toBe(400);
    expect((await post(env() + "x".repeat(MAX_BODY)))).toHaveProperty("status", 413);
    expect(calls).toHaveLength(0);
  });

  it("answers 404 and forwards nothing when no web DSN is set", async () => {
    const { post } = await app({});
    expect((await post(env())).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("limits each address per minute and passes the tracker's rate limit answer back", async () => {
    const { post } = await app();
    for (let i = 0; i < PER_IP_PER_MINUTE; i++) expect((await post(env())).status).toBe(200);
    const over = await post(env());
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    resetMonitoringTunnelLimits();
    answer = () => new Response("", { status: 429, headers: { "retry-after": "30", "x-sentry-rate-limits": "30:error:organization" } });
    const limited = await post(env());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-sentry-rate-limits")).toBe("30:error:organization");
    answer = () => { throw new Error("network down"); };
    expect((await post(env())).status).toBe(502);
  });

  it("needs no session or CSRF header and writes nothing to the database limiter", async () => {
    const { post } = await app();
    const r = await post(env(), { origin: "https://elsewhere.example" });
    expect(r.status).toBe(200);
  });

  it("the browser SDK is pointed at the tunnel, and the route module loads its handler lazily", () => {
    const web = readFileSync(new URL("../src/web/lib/sentry.ts", import.meta.url), "utf8");
    expect(web).toContain(`tunnel: "${MONITORING_TUNNEL_PATH}"`);
    const route = readFileSync(new URL("../src/server/routes/monitoring-tunnel-pol3.ts", import.meta.url), "utf8");
    expect(route).toMatch(/await import\("\.\/monitoring-tunnel-handler-pol3"\)/);
    expect(route).not.toMatch(/^import .*monitoring-tunnel-handler-pol3/m);
  });
});

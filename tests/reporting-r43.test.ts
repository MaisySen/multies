import { afterEach, describe, expect, it, vi } from "vitest";
import { configureReporting, flushReporting, reportException, reportingClientExists, reportingClientsCreated, resetReportingForTests } from "../src/entry/reporting";
import { loadConfig } from "../src/server/config";

/* R43 (MB-199): no per request reporting wrapper. The client is made only when an error is reported, with the real
 * address, and events leave on flush (inside ctx.waitUntil in the worker). */

afterEach(() => { resetReportingForTests(); vi.unstubAllGlobals(); });

describe("R43 lazy error reporting", () => {
  it("makes no client until there is an error to report, and none at all without an address", () => {
    configureReporting({ environment: "production" });
    expect(reportException(new Error("x"))).toBeUndefined();
    expect(reportingClientExists()).toBe(false);
    expect(reportingClientsCreated()).toBe(0);
  });

  it("creates one client on the first error, with the real address, and sends the event on flush", async () => {
    const sent: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { sent.push({ url: String(url), body: String(init.body) }); return new Response("{}", { status: 200 }); }));
    configureReporting({ dsn: "https://abc123@o1.ingest.example.io/42", environment: "staging", release: "r43test" });
    expect(reportingClientExists()).toBe(false);
    const id = reportException(new Error("Multies API report test"), { where: "unit" });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const id2 = reportException(new Error("second"));
    expect(id2).toMatch(/^[0-9a-f]{32}$/);
    expect(reportingClientsCreated()).toBe(1);
    await flushReporting(2000);
    expect(sent.length).toBe(2);
    expect(sent[0]!.url).toContain("o1.ingest.example.io/api/42/envelope/");
    expect(sent[0]!.body).toContain("Multies API report test");
    expect(sent[0]!.body).toContain("\"environment\":\"staging\"");
    expect(sent[0]!.body).toContain("\"release\":\"r43test\"");
  });

  it("carries another environment's name when the report is about it", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { sent.push(String(init.body)); return new Response("{}"); }));
    configureReporting({ dsn: "https://abc123@o1.ingest.example.io/42", environment: "production" });
    reportException(new Error("staging is down"), { environment: "staging" });
    await flushReporting(2000);
    expect(sent[0]).toContain("\"environment\":\"staging\"");
    expect(sent[0]).toContain("reported_by");
  });
});

describe("R43 config switches", () => {
  it("reads BACKGROUND_COPY and IMPORT_STEP_CAP_ORGS", () => {
    const base = { APP_SECRET: "x".repeat(48) };
    expect(loadConfig(base).backgroundCopy).toBe(false);
    expect(loadConfig({ ...base, BACKGROUND_COPY: "true" }).backgroundCopy).toBe(true);
    expect(loadConfig({ ...base, IMPORT_STEP_CAP_ORGS: "org_abc123def,org_zzz999yyy" }).importStepCapOrgs).toEqual(["org_abc123def", "org_zzz999yyy"]);
    expect(() => loadConfig({ ...base, IMPORT_STEP_CAP_ORGS: "everyone" })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { beforeEach } from "vitest";
import { endWarmup, replayD1, resetWarmupForTests, warmHotRoutes, warmupActive, type WarmFixture } from "../src/entry/warmup";
import fixtureJson from "../src/entry/warm-fixture.json";

// R42 (MB-199): the startup warm up must never leave its stand ins in place and must never touch real data.
describe("startup warm up", () => {
  beforeEach(() => resetWarmupForTests());
  const fixture: WarmFixture = { cookie: "x=1", routes: ["/api/a", "/api/b"], calls: [{ sql: "select 1", method: "all", ret: { results: [{ a: 1 }] } }] };

  it("swaps the platform classes only while it runs and puts them back", async () => {
    const RealRequest = globalThis.Request, RealResponse = globalThis.Response, RealHeaders = globalThis.Headers, realUUID = crypto.randomUUID;
    let seenInside: unknown = null;
    const app = { fetch: (req: Request) => { seenInside = globalThis.Request; expect(crypto.randomUUID()).toMatch(/^00000000-/); return new Response(JSON.stringify({ ok: req.url })); } };
    const report = await warmHotRoutes(app, fixture, "https://example.test", (fn) => fn());
    expect(report).toMatchObject({ ran: 2, ok: 2, statuses: [200, 200] });
    expect(seenInside).not.toBe(RealRequest);
    expect(globalThis.Request).toBe(RealRequest);
    expect(globalThis.Response).toBe(RealResponse);
    expect(globalThis.Headers).toBe(RealHeaders);
    expect(crypto.randomUUID).toBe(realUUID);
    expect(warmupActive()).toBe(false);
  });

  it("runs once per isolate: after a real request it does nothing", async () => {
    endWarmup();
    let called = 0;
    const report = await warmHotRoutes({ fetch: () => { called++; return new Response("{}"); } }, fixture, "https://example.test", (fn) => fn());
    expect(report.ran).toBe(0);
    expect(called).toBe(0);
  });

  it("a failing route only makes it less warm", async () => {
    const app = { fetch: () => { throw new Error("boom"); } };
    const report = await warmHotRoutes(app, fixture, "https://example.test", (fn) => fn());
    expect(report.ok).toBe(0);
    expect(report.error).toContain("boom");
    expect(globalThis.Request.name).not.toBe("WarmRequest");
  });

  it("the replay database answers from the fixture and refuses everything once a real request started", async () => {
    const db = replayD1(fixture);
    expect(await (db.prepare("select 1").bind(1) as unknown as { all(): Promise<unknown> }).all()).toEqual({ results: [{ a: 1 }] });
    expect(await (db.prepare("select 2") as unknown as { all(): Promise<unknown> }).all()).toEqual({ results: [], success: true, meta: { changes: 0 } });
    endWarmup();
    expect(warmupActive()).toBe(false);
    await expect((db.prepare("select 1") as unknown as { all(): Promise<unknown> }).all()).rejects.toThrow(/warm up over/);
  });

  it("the shipped fixture covers the hot routes and holds no real address", () => {
    const f = fixtureJson as unknown as WarmFixture;
    expect(f.routes).toEqual(expect.arrayContaining(["/api/account/me", "/api/counts", "/api/my-work", "/api/dashboard", "/api/team", "/api/org"]));
    expect(f.calls.length).toBeGreaterThan(10);
    const text = JSON.stringify(f);
    for (const m of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) expect(m).toMatch(/\.(test|example)$/);
    expect(text.length).toBeLessThan(80_000);
  });
});

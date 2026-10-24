import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { checkWriteBudget, levelFor, resetWriteBudgetCache, writeBudget } from "@/server/services/write-budget";
import { runMaintenance } from "@/server/services/maintenance";
import { resolveApiKey, LAST_USED_EVERY_MS } from "@/server/services/developer/api-keys";
import { loadConfig } from "@/server/config";

const ACCOUNT = "acc123";
/** A fake Cloudflare GraphQL endpoint that answers `rows` written today, split over two databases. */
function analytics(rows: number, calls = { n: 0 }) {
  return (async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    calls.n++;
    const half = Math.floor(rows / 2);
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [
      { sum: { rowsWritten: half }, dimensions: { databaseId: "prod" } },
      { sum: { rowsWritten: rows - half }, dimensions: { databaseId: "staging" } },
    ] }] } }, errors: null }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}
const env = (extra: Record<string, string> = {}) => ({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT, ...extra });

describe("D1 write budget", () => {
  beforeEach(() => resetWriteBudgetCache());

  it("is off without an analytics token, and refuses nothing", async () => {
    const { deps, app } = await makeTestApp({ DEMO_MODE: "true" });
    expect((await writeBudget(deps)).level).toBe("off");
    expect((await new Client(app).post("/api/account/demo")).status).toBe(201);
  });

  it("maps the count to levels at 60% and 80% of the budget, both configurable", () => {
    const cfg = loadConfig({ APP_SECRET: "t".repeat(40) }).writeBudget;
    expect(cfg.daily).toBe(100_000);
    expect(levelFor(59_999, cfg)).toBe("ok");
    expect(levelFor(60_000, cfg)).toBe("warn");
    expect(levelFor(80_000, cfg)).toBe("shed");
    const custom = loadConfig({ APP_SECRET: "t".repeat(40), D1_DAILY_WRITE_BUDGET: "50000", WRITE_BUDGET_WARN_PCT: "50", WRITE_BUDGET_SHED_PCT: "70" }).writeBudget;
    expect(levelFor(25_000, custom)).toBe("warn");
    expect(levelFor(35_000, custom)).toBe("shed");
  });

  it("sums every database on the account and reads analytics at most every five minutes", async () => {
    const calls = { n: 0 };
    const { deps } = await makeTestApp(env(), { fetch: analytics(61_001, calls) });
    const r = await writeBudget(deps);
    expect(r).toMatchObject({ level: "warn", rowsWritten: 61_001, budget: 100_000, byDatabase: { prod: 30_500, staging: 30_501 } });
    await writeBudget(deps);
    expect(calls.n).toBe(1);
  });

  it("keeps working when analytics fails", async () => {
    const { deps } = await makeTestApp(env(), { fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
    expect((await writeBudget(deps)).level).toBe("off");
  });

  it("the cron logs the count and reports an error once per level per day", async () => {
    const reported: string[] = [];
    const { deps } = await makeTestApp(env(), { fetch: analytics(85_000) });
    deps.reportError = (e) => { reported.push((e as Error).message); return undefined; };
    await checkWriteBudget(deps);
    await checkWriteBudget(deps);
    expect(reported).toEqual(["D1 writes today: 85000 of 100000 (85%), level shed"]);
    const out = await runMaintenance(deps);
    expect(out.writes).toEqual({ level: "shed", rowsWritten: 85_000 });
  });

  it("production pauses new demos from 80% but keeps sign in and writes working", async () => {
    const { app } = await makeTestApp(env({ DEMO_MODE: "true" }), { fetch: analytics(80_500) });
    const r = await new Client(app).post("/api/account/demo");
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("demo_paused");
    const u = new Client(app);
    const email = await u.signup();
    expect((await new Client(app).login(email)).status).toBe(200);
    expect((await u.post("/api/projects", { name: "Still works" })).status).toBe(201);
  });

  it("production still opens demos at the warn level", async () => {
    const { app } = await makeTestApp(env({ DEMO_MODE: "true" }), { fetch: analytics(65_000) });
    expect((await new Client(app).post("/api/account/demo")).status).toBe(201);
  });

  it("strict mode (staging) answers writes read only from 60%, keeps reads, and health shows the count", async () => {
    const ok = await makeTestApp(env({ WRITE_BUDGET_GUARD: "strict" }), { fetch: analytics(10_000) });
    const u = new Client(ok.app);
    await u.signup();
    resetWriteBudgetCache();
    const ctx = await makeTestApp(env({ WRITE_BUDGET_GUARD: "strict" }), { fetch: analytics(60_000) });
    const c = new Client(ctx.app);
    const signup = await c.post("/api/auth/sign-up/email", { name: "A", email: "a@example.com", password: "a-strong-password" });
    expect(signup.status).toBe(503);
    expect(signup.body.error.code).toBe("read_only");
    expect((await c.get("/api/config")).status).toBe(200);
    const health = await c.get("/api/health");
    expect(health.body.writes).toMatchObject({ today: 60_000, budget: 100_000, level: "warn" });
  });
});

describe("last used throttles", () => {
  it("an API key's last used time is written at most every 15 minutes", async () => {
    const { deps, app } = await makeTestApp();
    const u = new Client(app);
    await u.signup();
    const key = await u.post("/api/developer/keys", { name: "poller", scope: "read" });
    const token = key.body.secret;
    expect(typeof token).toBe("string");
    let t = Date.now();
    deps.now = () => new Date(t);
    const client = (deps.db as unknown as { $client: { prepare: (q: string) => unknown } }).$client;
    const prepare = client.prepare.bind(client);
    let writes = 0;
    client.prepare = (q: string) => { if (/^update "api_keys"/i.test(q)) writes++; return prepare(q); };
    await resolveApiKey(deps, `Bearer ${token}`);
    t += 60_000;
    await resolveApiKey(deps, `Bearer ${token}`);
    t += LAST_USED_EVERY_MS;
    await resolveApiKey(deps, `Bearer ${token}`);
    expect(writes).toBe(2);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { loadConfig } from "@/server/config";
import { appSettings, organizations, usageCounters } from "@/server/db/schema";
import {
  FLUSH_ROWS, WORKSPACE_ROWS_METRIC, flushAllWorkspaces, isBudgetExempt, recordWorkspaceWrites, resetWorkspaceBudget,
  runMetered, withWriteMeter, workspaceLevel, workspaceUsage,
} from "@/server/services/workspace-budget";

const day = () => new Date().toISOString().slice(0, 10);

/** A minimal stand in for a D1 binding: every statement answers `rows_written` = the number in its SQL comment. */
function fakeD1() {
  const stmt = (sql: string) => {
    const n = Number(/\/\*(\d+)\*\//.exec(sql)?.[1] ?? 0);
    const s = {
      n,
      bind: (..._args: unknown[]) => s,
      run: async () => ({ meta: { rows_written: n } }),
      all: async () => ({ results: [], meta: { rows_written: n } }),
      first: async () => null,
      raw: async () => [],
    };
    return s;
  };
  return { prepare: (sql: string) => stmt(sql), // Like D1, a batch runs the statements itself (their own methods are not called) and answers each meta.
    batch: async (list: { n: number }[]) => list.map((x) => ({ meta: { rows_written: x.n } })) };
}

async function seed(db: Awaited<ReturnType<typeof makeTestApp>>["db"], orgId: string, count: number) {
  await db.insert(usageCounters).values({ orgId, period: day(), metric: WORKSPACE_ROWS_METRIC, count })
    .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.period, usageCounters.metric], set: { count } });
  // The per isolate copy of the counter is up to a minute old by design; a test reads afresh.
  resetWorkspaceBudget();
}

describe("R48 per workspace write budget (MB-235)", () => {
  beforeEach(() => resetWorkspaceBudget());

  it("defaults to 20,000 rows a day with a notice from 80%, and 0 turns it off", () => {
    const cfg = loadConfig({ APP_SECRET: "t".repeat(40) }).workspaceBudget;
    expect(cfg).toEqual({ daily: 20_000, nearAt: 0.8 });
    expect(loadConfig({ APP_SECRET: "t".repeat(40), WORKSPACE_DAILY_WRITES: "0" }).workspaceBudget.daily).toBe(0);
    expect(workspaceLevel(15_999, cfg)).toBe("ok");
    expect(workspaceLevel(16_000, cfg)).toBe("near");
    expect(workspaceLevel(20_000, cfg)).toBe("over");
    expect(workspaceLevel(50, { daily: 0, nearAt: 0.8 })).toBe("off");
  });

  it("meters D1 writes per request from meta.rows_written, including batches, and never reads", async () => {
    const d1 = withWriteMeter(fakeD1());
    const { rows } = await runMetered(async () => {
      await d1.prepare("insert into t values (1) /*3*/").bind(1).run();
      await d1.prepare("select * from t /*99*/").all();
      await d1.prepare("update t set a = 1 /*2*/").run();
      await d1.batch([d1.prepare("insert into t /*4*/"), d1.prepare("delete from t /*1*/")] as never);
    });
    expect(rows).toBe(3 + 2 + 4 + 1);
    // Outside a metered request nothing is counted and nothing breaks.
    await d1.prepare("insert into t /*5*/").run();
    expect(withWriteMeter(d1)).toBe(d1);
  });

  it("keeps sign in, account, billing, presence, MCP and every read open", () => {
    for (const p of ["/api/auth/sign-in/email", "/api/account/me", "/api/account/switch", "/api/billing/checkout", "/api/threads/t1/presence", "/api/v1/mcp", "/api/health"]) expect(isBudgetExempt("POST", p)).toBe(true);
    for (const p of ["/api/tasks", "/api/org", "/api/v1/tasks", "/api/chat/channels/x/messages"]) expect(isBudgetExempt("POST", p)).toBe(false);
    expect(isBudgetExempt("GET", "/api/tasks")).toBe(true);
  });

  it("holds only the busy workspace to its budget: a calm 429 on its writes, reads still work, other workspaces untouched", async () => {
    const ctx = await makeTestApp({ WORKSPACE_DAILY_WRITES: "1000" });
    const a = new Client(ctx.app); await a.signup("a@busy.io", "Ann", "Busy");
    const b = new Client(ctx.app); await b.signup("b@calm.io", "Ben", "Calm");
    const busy = (await ctx.db.select().from(organizations).where(eq(organizations.name, "Busy")).get())!;
    await seed(ctx.db, busy.id, 1000);

    const w = await a.patch("/api/org", { name: "Busy two" });
    expect(w.status).toBe(429);
    expect(w.body.error.code).toBe("workspace_budget");
    expect(w.body.error.message).toMatch(/daily limit/);
    expect(w.body.error.message).toMatch(/other workspaces are not affected/);
    expect(w.body.error.message).not.toMatch(/[\u2013\u2014]/);
    expect((await a.get("/api/org")).status).toBe(200);
    expect((await a.get("/api/account/me")).status).toBe(200);
    // The other workspace writes as normal.
    expect((await b.patch("/api/org", { name: "Calm two" })).status).toBe(200);
    // Turned off, nobody is held.
    resetWorkspaceBudget();
    const off = await makeTestApp({ WORKSPACE_DAILY_WRITES: "0" });
    const c = new Client(off.app); await c.signup("c@off.io", "Cy", "Off");
    const offOrg = (await off.db.select().from(organizations).where(eq(organizations.name, "Off")).get())!;
    await seed(off.db, offOrg.id, 10_000_000);
    expect((await c.patch("/api/org", { name: "Off two" })).status).toBe(200);
  });

  it("marks writes near the budget with a header and still lets them through", async () => {
    const ctx = await makeTestApp({ WORKSPACE_DAILY_WRITES: "1000" });
    const a = new Client(ctx.app); await a.signup("n@near.io", "Nia", "Near");
    const org = (await ctx.db.select().from(organizations).where(eq(organizations.name, "Near")).get())!;
    await seed(ctx.db, org.id, 850);
    const res = await ctx.app.request("/api/org", { method: "PATCH", headers: { cookie: a.cookie, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ name: "Near two" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-workspace-budget")).toBe("near");
  });

  it("tallies rows per workspace, writes one counter row per flush, and tells the admins once per level per day", async () => {
    const ctx = await makeTestApp({ WORKSPACE_DAILY_WRITES: "1000" });
    const a = new Client(ctx.app); await a.signup("t@tally.io", "Tia", "Tally");
    const org = (await ctx.db.select().from(organizations).where(eq(organizations.name, "Tally")).get())!;
    expect(recordWorkspaceWrites(ctx.deps, org.id, 10)).toBeUndefined(); // small and fresh: held in memory
    expect((await workspaceUsage(ctx.deps, org.id)).used).toBe(10);
    await recordWorkspaceWrites(ctx.deps, org.id, FLUSH_ROWS + 800); // crosses 80%: flush and notice
    const row = await ctx.db.select().from(usageCounters).where(and(eq(usageCounters.orgId, org.id), eq(usageCounters.period, day()), eq(usageCounters.metric, WORKSPACE_ROWS_METRIC))).get();
    expect(row?.count).toBe(FLUSH_ROWS + 810);
    const alerts = await ctx.db.select().from(appSettings).all();
    expect(alerts.filter((s) => s.key.startsWith(`ws_budget_alert:${org.id}:`)).map((s) => s.key.split(":").at(-1))).toEqual(["over"]);
    await recordWorkspaceWrites(ctx.deps, org.id, FLUSH_ROWS);
    expect((await ctx.db.select().from(appSettings).all()).filter((s) => s.key.startsWith("ws_budget_alert:")).length).toBe(1);
    const mails = (ctx.outbound as unknown as { sent?: { subject?: string }[] }).sent ?? [];
    if (mails.length) expect(mails.some((m) => /limit for changes/.test(m.subject ?? ""))).toBe(true);
    // The cron writes out what is left.
    recordWorkspaceWrites(ctx.deps, org.id, 5);
    await flushAllWorkspaces(ctx.deps);
    const after = await ctx.db.select().from(usageCounters).where(and(eq(usageCounters.orgId, org.id), eq(usageCounters.metric, WORKSPACE_ROWS_METRIC))).get();
    expect(after?.count).toBe(FLUSH_ROWS + 810 + FLUSH_ROWS + 5);
  });

  it("shows today's busiest workspaces on /api/health as counts only", async () => {
    const ctx = await makeTestApp({ WORKSPACE_DAILY_WRITES: "1000" });
    const a = new Client(ctx.app); await a.signup("h@health.io", "Hal", "Health");
    const org = (await ctx.db.select().from(organizations).where(eq(organizations.name, "Health")).get())!;
    await seed(ctx.db, org.id, 900);
    const h = await new Client(ctx.app).get("/api/health");
    expect(h.body.workspaces).toMatchObject({ budget: 1000, nearAt: 80, top: [900], near: 1, over: 0 });
    expect(JSON.stringify(h.body)).not.toContain(org.id);
  });
});

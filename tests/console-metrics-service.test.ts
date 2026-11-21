/** OPS1 Trends: the platform metrics rollup, backfill and reads (services/console/metrics.ts), on seeded rows with a fixed clock. */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import {
  abuseEvents, agentRuns, aiUsageDaily, contentReports, deliveries, domains, jobs, mailboxes, organizations,
  platformMetricsDaily, uptimeChecks, usageCounters, users, webhookDeliveries, webhookEndpoints,
} from "@/server/db/schema";
import {
  FLOW_METRICS, MAX_CATCH_UP_DAYS, PLATFORM_METRICS, STOCK_METRICS, backfillFlowMetrics, computeDay, readMetrics,
  readWorkspaceTrends, rollPlatformMetrics, type MetricKey,
} from "@/server/services/console/metrics";
import { resetWriteBudgetCache } from "@/server/services/write-budget";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
const NOW = new Date("2026-11-21T10:00:00Z");
const TODAY = "2026-11-21";
const YESTERDAY = "2026-11-20";
const at = (iso: string) => new Date(iso);
/** Two moments inside yesterday (its first and last millisecond) and two just outside it. */
const INSIDE = ["2026-11-20T00:00:00.000Z", "2026-11-20T23:59:59.999Z"];
const OUTSIDE = ["2026-11-19T23:59:59.999Z", "2026-11-21T00:00:00.000Z"];

/** Rows changed per table by write statements (one per row; the upsert's update counts one too). */
function meter(db: unknown) {
  const c = (db as { $client: { prepare: (q: string) => Record<string, (...a: unknown[]) => unknown> } }).$client;
  const prepare = c.prepare.bind(c);
  const changes = () => (prepare("select total_changes() n").get() as { n: number }).n;
  const byTable: Record<string, number> = {};
  c.prepare = (q: string) => {
    const st = prepare(q);
    const table = /^\s*(?:insert(?: or \w+)? into|update|delete from)\s+["`]?(\w+)/i.exec(q)?.[1];
    if (!table) return st;
    for (const fn of ["run", "all", "get"]) {
      const orig = st[fn].bind(st);
      st[fn] = (...a: unknown[]) => { const before = changes(); const r = orig(...a); byTable[table] = (byTable[table] ?? 0) + (changes() - before); return r; };
    }
    return st;
  };
  return () => { const out = { ...byTable }; for (const k of Object.keys(byTable)) delete byTable[k]; return out; };
}

let seq = 0;
const id = (p: string) => `${p}_${String(++seq).padStart(12, "0")}`;

async function seedOrg(ctx: Ctx, o: Partial<typeof organizations.$inferInsert> = {}) {
  const orgId = o.id ?? id("org");
  await ctx.db.insert(organizations).values({ id: orgId, name: orgId, createdAt: at("2026-01-01T00:00:00Z"), ...o });
  return orgId;
}

/**
 * Seeds every source table: for each flow metric, two rows inside yesterday and two just outside it (so yesterday
 * counts 2), plus a demo workspace whose rows must never count.
 */
async function seedAll(ctx: Ctx) {
  const db = ctx.db;
  const org = await seedOrg(ctx, { id: "org_live", plan: "pro", subscriptionStatus: "active" });
  const demo = await seedOrg(ctx, { id: "org_demo", isDemo: true });
  await seedOrg(ctx, { compPlan: true });
  await seedOrg(ctx, { pastDueSince: at("2026-11-01T00:00:00Z"), suspendedAt: at("2026-11-02T00:00:00Z") });
  const moments = [...INSIDE, ...OUTSIDE];
  for (const m of moments) {
    await db.insert(users).values({ id: id("usr"), email: `${id("e")}@x.io`, name: "U", createdAt: at(m) });
    await seedOrg(ctx, { createdAt: at(m) });
    await db.insert(deliveries).values([
      { id: id("dlv"), orgId: org, direction: "outbound", fromAddress: "a@x.io", toAddress: "b@y.io", status: "delivered", provider: "log", createdAt: at(m) },
      { id: id("dlv"), orgId: org, direction: "outbound", fromAddress: "a@x.io", toAddress: "b@y.io", status: "bounced", provider: "log", createdAt: at(m) },
      { id: id("dlv"), orgId: org, direction: "inbound", fromAddress: "b@y.io", toAddress: "a@x.io", status: "received", provider: "log", createdAt: at(m) },
      { id: id("dlv"), orgId: demo, direction: "outbound", fromAddress: "d@x.io", toAddress: "b@y.io", status: "sent", provider: "log", createdAt: at(m) },
    ]);
    await db.insert(agentRuns).values([
      { id: id("run"), orgId: org, taskId: "tsk_x", agentUserId: "usr_agent", status: "succeeded", createdAt: at(m) },
      { id: id("run"), orgId: org, taskId: "tsk_y", agentUserId: "usr_agent", status: "failed", createdAt: at(m) },
      { id: id("run"), orgId: demo, taskId: "tsk_z", agentUserId: "usr_agent", status: "failed", createdAt: at(m) },
    ]);
    await db.insert(jobs).values([
      { id: id("job"), type: "t", payload: "{}", status: "dead", runAt: at(m), updatedAt: at(m) },
      { id: id("job"), type: "t", payload: "{}", status: "done", runAt: at(m), updatedAt: at(m) },
    ]);
    await db.insert(abuseEvents).values([{ id: id("abe"), orgId: org, kind: "k", createdAt: at(m) }, { id: id("abe"), orgId: demo, kind: "k", createdAt: at(m) }]);
    await db.insert(contentReports).values({ id: id("rep"), reporterUserId: "usr_r", targetType: "user", reason: "spam", status: m === INSIDE[0] ? "resolved" : "open", createdAt: at(m) });
    await db.insert(webhookDeliveries).values([
      { id: id("whd"), orgId: org, endpointId: "whe_1", eventType: "e", payload: "{}", status: "failed", createdAt: at(m) },
      { id: id("whd"), orgId: org, endpointId: "whe_1", eventType: "e", payload: "{}", status: "delivered", createdAt: at(m) },
    ]);
  }
  await db.insert(webhookEndpoints).values({ id: "whe_1", orgId: org, url: "https://hook.example/x", secretEnc: "s", events: "[]" });
  // ai_usage_daily: the global rows count, the per workspace rows must not be added on top.
  await db.insert(aiUsageDaily).values([
    { day: YESTERDAY, orgId: "*", calls: 3, units: 30 }, { day: YESTERDAY, orgId: "ask:*", calls: 1, units: 7 },
    { day: YESTERDAY, orgId: "socialwrite:*", calls: 1, units: 5 }, { day: YESTERDAY, orgId: org, calls: 3, units: 30 },
    { day: YESTERDAY, orgId: `ask:${org}`, calls: 1, units: 1 }, { day: "2026-11-19", orgId: "*", calls: 9, units: 90 },
  ]);
  // Stock sources.
  await db.insert(domains).values([
    { id: "dom_1", orgId: org, name: "a.io", status: "verified", verificationToken: "t", dkimSelector: "s", dkimPublicKey: "p", dkimPrivateKeyEnc: "e" },
    { id: "dom_2", orgId: org, name: "b.io", status: "pending", verificationToken: "t", dkimSelector: "s", dkimPublicKey: "p", dkimPrivateKeyEnc: "e" },
  ]);
  await db.insert(mailboxes).values([
    { id: "mbx_1", orgId: org, domainId: "dom_1", localPart: "a", address: "a@a.io", displayName: "A", quotaMb: 100, usedBytes: 3 * 1_048_576 },
    { id: "mbx_2", orgId: org, domainId: "dom_1", localPart: "b", address: "b@a.io", displayName: "B", quotaMb: 100, usedBytes: 1_048_576 },
  ]);
  await db.insert(uptimeChecks).values([
    { id: id("upc"), at: at("2026-11-20T01:00:00Z"), ok: true, latencyMs: 1, components: "{}" },
    { id: id("upc"), at: at("2026-11-20T02:00:00Z"), ok: true, latencyMs: 1, components: "{}" },
    { id: id("upc"), at: at("2026-11-20T03:00:00Z"), ok: true, latencyMs: 1, components: "{}" },
    { id: id("upc"), at: at("2026-11-20T04:00:00Z"), ok: false, latencyMs: 1, components: "{}" },
    { id: id("upc"), at: at("2026-11-21T01:00:00Z"), ok: false, latencyMs: 1, components: "{}" },
  ]);
  await db.insert(usageCounters).values([
    { orgId: org, period: YESTERDAY, metric: "d1_rows", count: 500 },
    { orgId: demo, period: YESTERDAY, metric: "d1_rows", count: 20 },
    { orgId: org, period: TODAY, metric: "d1_rows", count: 70 },
    { orgId: org, period: "2026-11", metric: "meeting_participant_minutes", count: 999 },
  ]);
  return { org, demo };
}

async function setup(env: Record<string, string> = {}, opts: Parameters<typeof makeTestApp>[1] = {}) {
  resetWriteBudgetCache();
  const ctx = await makeTestApp(env, opts);
  ctx.deps.now = () => NOW;
  // Seeded rows point at tasks and users that the metrics never join; the foreign keys are not what is under test.
  (ctx.db as unknown as { $client: { pragma: (s: string) => void } }).$client.pragma("foreign_keys = OFF");
  return ctx;
}

const stored = async (ctx: Ctx) => ctx.db.select().from(platformMetricsDaily).orderBy(platformMetricsDaily.day, platformMetricsDaily.metric);

let ctx: Ctx;
let seeded: { org: string; demo: string };
beforeEach(async () => { ctx = await setup(); seeded = await seedAll(ctx); });

describe("the registry", () => {
  it("has the plan's metrics, unique keys, flow and stock", () => {
    const keys = PLATFORM_METRICS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(FLOW_METRICS).toEqual(["signups", "workspaces_created", "deliveries_sent", "deliveries_failed", "ai_calls", "ai_units", "agent_runs", "agent_runs_failed", "jobs_dead", "abuse_events", "reports_opened", "webhook_deliveries_failed"]);
    expect(STOCK_METRICS).toEqual(["users_total", "workspaces_total", "workspaces_paid", "workspaces_comp", "workspaces_past_due", "workspaces_suspended", "mailboxes_total", "domains_verified", "storage_mb", "d1_rows_written", "uptime_pct"]);
  });
});

describe("computeDay", () => {
  it("counts each flow metric only within its UTC day, demo workspaces and per workspace AI rows left out", async () => {
    const v = await computeDay(ctx.deps, YESTERDAY);
    expect(v).toMatchObject({
      signups: 2, workspaces_created: 2, deliveries_sent: 4, deliveries_failed: 2, ai_calls: 5, ai_units: 42,
      agent_runs: 4, agent_runs_failed: 2, jobs_dead: 2, abuse_events: 2, reports_opened: 2, webhook_deliveries_failed: 2,
    });
  });

  it("gives stock metrics for yesterday and today only", async () => {
    const y = await computeDay(ctx.deps, YESTERDAY);
    // 4 seeded workspaces + 4 created around the day; the demo one is left out.
    expect(y).toMatchObject({
      users_total: 4, workspaces_total: 7, workspaces_paid: 1, workspaces_comp: 1, workspaces_past_due: 1, workspaces_suspended: 1,
      mailboxes_total: 2, domains_verified: 1, storage_mb: 4, d1_rows_written: 520, uptime_pct: 75,
    });
    const t = await computeDay(ctx.deps, TODAY);
    expect(t).toMatchObject({ users_total: 4, d1_rows_written: 70, uptime_pct: 0 });
    const old = await computeDay(ctx.deps, "2026-11-18");
    for (const k of STOCK_METRICS) expect(old[k]).toBeUndefined();
    expect(old.signups).toBe(0);
  });

  it("leaves out flow metrics older than their source keeps, and stocks that have no data", async () => {
    const v = await computeDay(ctx.deps, "2026-11-18"); // AI usage rows are kept two days
    expect(v.ai_calls).toBeUndefined();
    expect((await computeDay(ctx.deps, "2026-11-19")).ai_calls).toBe(9);
    expect((await computeDay(ctx.deps, "2026-10-01")).jobs_dead).toBeUndefined();
    await ctx.db.delete(uptimeChecks);
    expect((await computeDay(ctx.deps, YESTERDAY)).uptime_pct).toBeUndefined();
    const off = await setup({ WORKSPACE_DAILY_WRITES: "0" });
    expect((await computeDay(off.deps, YESTERDAY)).d1_rows_written).toBeUndefined();
    await expect(computeDay(ctx.deps, "2026-13-01")).rejects.toThrow(/not a day/);
  });
});

describe("rollPlatformMetrics", () => {
  it("rolls yesterday once: flows and stocks, about one row a metric, and nothing on the next pass", async () => {
    await ctx.db.insert(platformMetricsDaily).values({ day: "2026-11-19", metric: "users_total", value: 3, updatedAt: NOW });
    const take = meter(ctx.db);
    const r = await rollPlatformMetrics(ctx.deps, NOW);
    expect(r.skipped).toBeUndefined();
    expect(r.days).toEqual([YESTERDAY]);
    expect(r.rows).toHaveLength(PLATFORM_METRICS.length);
    // Exactly one row written per metric, and no other table touched.
    expect(take()).toEqual({ platform_metrics_daily: PLATFORM_METRICS.length });
    const y = (await stored(ctx)).filter((s) => s.day === YESTERDAY);
    expect(Object.fromEntries(y.map((s) => [s.metric, s.value]))).toMatchObject({ signups: 2, deliveries_sent: 4, users_total: 4, uptime_pct: 75 });

    const again = await rollPlatformMetrics(ctx.deps, NOW);
    expect(again).toMatchObject({ skipped: "up_to_date", rows: [] });
    expect(take()).toEqual({});
  });

  it("catches up at most 7 missed days, with stocks for yesterday only", async () => {
    await ctx.db.insert(platformMetricsDaily).values({ day: "2026-10-01", metric: "users_total", value: 1, updatedAt: NOW });
    const r = await rollPlatformMetrics(ctx.deps, NOW);
    expect(r.days).toHaveLength(MAX_CATCH_UP_DAYS);
    expect(r.days[0]).toBe("2026-11-14");
    expect(r.days.at(-1)).toBe(YESTERDAY);
    const rows = await stored(ctx);
    expect(rows.filter((s) => s.metric === "users_total").map((s) => s.day)).toEqual(["2026-10-01", YESTERDAY]);
    expect(rows.filter((s) => s.metric === "signups").map((s) => s.day)).toEqual(r.days);
    // AI usage is kept two days, so the older catch-up days get no AI row (a gap, not a zero).
    expect(rows.filter((s) => s.metric === "ai_calls").map((s) => s.day)).toEqual(["2026-11-19", YESTERDAY]);
  });

  it("with an empty table rolls the last 7 days; from a recent day, only the missing ones", async () => {
    expect((await rollPlatformMetrics(ctx.deps, NOW)).days).toHaveLength(7);
    const next = await rollPlatformMetrics(ctx.deps, new Date("2026-11-23T00:05:00Z"));
    expect(next.days).toEqual(["2026-11-21", "2026-11-22"]);
  });

  it("does nothing while optional writes are paused", async () => {
    const analytics = (async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 90_000 }, dimensions: { databaseId: "prod" } }] }] } }, errors: null }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const shed = await setup({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acc" }, { fetch: analytics });
    await seedAll(shed);
    const take = meter(shed.db);
    expect(await rollPlatformMetrics(shed.deps, NOW)).toMatchObject({ skipped: "writes_paused", rows: [] });
    expect(await backfillFlowMetrics(shed.deps, 5)).toMatchObject({ skipped: "writes_paused", rows: [] });
    expect(take()).toEqual({});
    expect(await stored(shed)).toEqual([]);
    resetWriteBudgetCache();
  });
});

describe("backfillFlowMetrics", () => {
  it("takes 1 to 90 days", async () => {
    for (const bad of [0, 91, 1.5, -3, Number.NaN]) await expect(backfillFlowMetrics(ctx.deps, bad)).rejects.toThrow(RangeError);
  });

  it("writes flow metrics only, within each source's retention, and is idempotent", async () => {
    const take = meter(ctx.db);
    const r = await backfillFlowMetrics(ctx.deps, 90);
    expect(r.days).toHaveLength(90);
    expect(r.days[0]).toBe("2026-08-23");
    expect(r.days.at(-1)).toBe(YESTERDAY);
    const rows = await stored(ctx);
    expect(take()).toEqual({ platform_metrics_daily: rows.length });
    expect(rows.length).toBe(r.rows.length);
    const metrics = new Set(rows.map((s) => s.metric));
    for (const k of STOCK_METRICS) expect(metrics.has(k)).toBe(false);
    const daysOf = (m: MetricKey) => rows.filter((s) => s.metric === m).length;
    expect(daysOf("signups")).toBe(90);
    expect(daysOf("ai_calls")).toBe(2);
    expect(daysOf("jobs_dead")).toBe(29);
    expect(daysOf("webhook_deliveries_failed")).toBe(29);
    // 8 metrics kept for good x 90 days + AI 2 x 2 + jobs and webhooks 2 x 29.
    expect(rows.length).toBe(8 * 90 + 2 * 2 + 2 * 29);

    const again = await backfillFlowMetrics(ctx.deps, 90);
    expect(again.rows).toEqual(r.rows);
    expect(await stored(ctx)).toHaveLength(rows.length);
    expect((await stored(ctx)).find((s) => s.day === YESTERDAY && s.metric === "signups")?.value).toBe(2);
  });

  it("then a rollup still adds yesterday's stocks", async () => {
    await backfillFlowMetrics(ctx.deps, 3);
    const r = await rollPlatformMetrics(ctx.deps, NOW);
    expect(r.rows.filter((x) => x.day === YESTERDAY).map((x) => x.metric)).toContain("users_total");
  });
});

describe("readMetrics", () => {
  it("reads stored days, computes today live and leaves gaps as null", async () => {
    await rollPlatformMetrics(ctx.deps, NOW); // 2026-11-14 .. 2026-11-20
    await ctx.db.insert(users).values({ id: "usr_today", email: "today@x.io", name: "T", createdAt: at("2026-11-21T09:00:00Z") });
    const r = await readMetrics(ctx.deps, { metrics: ["signups", "users_total", "uptime_pct"], from: "2026-11-12", to: "2026-11-30" });
    expect(r.to).toBe(TODAY);
    expect(r.liveDay).toBe(TODAY);
    expect(r.days).toHaveLength(10);
    // Before the first rollup day: null, not 0.
    expect(r.series.signups!.slice(0, 2)).toEqual([null, null]);
    expect(r.series.signups![r.days.indexOf("2026-11-18")]).toBe(0);
    expect(r.series.signups![r.days.indexOf(YESTERDAY)]).toBe(2);
    // Today, live: the account made a few minutes ago (OUTSIDE[1] is today too).
    expect(r.series.signups!.at(-1)).toBe(2);
    expect(r.series.users_total!.at(-1)).toBe(5);
    // Stock history starts at the first rollup's yesterday.
    expect(r.series.users_total![r.days.indexOf("2026-11-19")]).toBeNull();
    expect(r.firstDay).toEqual({ signups: "2026-11-14", users_total: YESTERDAY, uptime_pct: YESTERDAY });
  });

  it("a stored day that is missing reads as null, and a past range has no live day", async () => {
    await rollPlatformMetrics(ctx.deps, NOW);
    await ctx.db.delete(platformMetricsDaily).where(eq(platformMetricsDaily.day, "2026-11-16"));
    const r = await readMetrics(ctx.deps, { metrics: ["deliveries_sent"], from: "2026-11-15", to: "2026-11-17" });
    expect(r).toMatchObject({ liveDay: null, days: ["2026-11-15", "2026-11-16", "2026-11-17"], series: { deliveries_sent: [0, null, 0] } });
  });

  it("refuses unknown metrics and bad ranges", async () => {
    await expect(readMetrics(ctx.deps, { metrics: ["nope"], from: TODAY, to: TODAY })).rejects.toThrow(/unknown metric/);
    await expect(readMetrics(ctx.deps, { metrics: [], from: TODAY, to: TODAY })).rejects.toThrow();
    await expect(readMetrics(ctx.deps, { metrics: ["signups"], from: TODAY, to: "2026-11-01" })).rejects.toThrow(/after/);
    await expect(readMetrics(ctx.deps, { metrics: ["signups"], from: "2020-01-01", to: TODAY })).rejects.toThrow(/at most/);
  });
});

describe("readWorkspaceTrends", () => {
  it("groups one workspace's deliveries, AI usage and daily counters by day", async () => {
    const r = await readWorkspaceTrends(ctx.deps, seeded.org, { from: "2026-11-17", to: "2026-11-25" });
    expect(r.days).toEqual(["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"]);
    expect(r.series.deliveries_sent).toEqual([0, 0, 2, 4, 2]);
    expect(r.series.deliveries_failed).toEqual([0, 0, 1, 2, 1]);
    expect(r.series.deliveries_received).toEqual([0, 0, 1, 2, 1]);
    // AI usage is kept two days: older days are null.
    expect(r.series.ai_calls).toEqual([null, null, 0, 4, 0]);
    expect(r.series.ai_units).toEqual([null, null, 0, 30, 0]);
    // Daily counters only (the monthly meeting minutes row is left out); no row is null.
    expect(r.series["usage:d1_rows"]).toEqual([null, null, null, 500, 70]);
    expect(Object.keys(r.series).some((k) => k.includes("meeting"))).toBe(false);
    // Another workspace sees none of it.
    const other = await readWorkspaceTrends(ctx.deps, seeded.demo, { from: "2026-11-20", to: "2026-11-20" });
    expect(other.series.deliveries_failed).toEqual([0]);
    expect(other.series.deliveries_sent).toEqual([2]);
  });
});

describe("query plans", () => {
  it("the indexed sources use their indexes", async () => {
    const plan = async (q: string) => ((await ctx.db.all(sql.raw(`explain query plan ${q}`))) as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(await plan("select count(*) from deliveries where org_id in (select id from organizations where is_demo = 0) and created_at >= 0 and created_at < 1 and direction = 'outbound'")).toMatch(/deliveries_org_idx/);
    expect(await plan("select count(*) from abuse_events where org_id in (select id from organizations) and created_at >= 0 and created_at < 1")).toMatch(/abuse_events_org_idx/);
    expect(await plan("select count(*) from content_reports where status in ('open','resolved','dismissed') and created_at >= 0 and created_at < 1")).toMatch(/content_reports_status_idx/);
    expect(await plan("select count(*) from webhook_deliveries where endpoint_id in (select id from webhook_endpoints) and created_at >= 0 and created_at < 1 and status = 'failed'")).toMatch(/webhook_deliveries_(endpoint|due)_idx/);
    expect(await plan("select count(*) from jobs where status = 'dead' and updated_at >= 0 and updated_at < 1")).toMatch(/jobs_due_idx/);
    expect(await plan("select max(day) from platform_metrics_daily where metric = 'users_total'")).toMatch(/platform_metrics_daily_metric_idx/);
    expect(await plan("select count(*) from uptime_checks where at >= 0 and at < 1")).toMatch(/uptime_checks_at_idx/);
  });
});

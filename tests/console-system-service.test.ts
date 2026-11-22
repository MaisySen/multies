import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { loginThrottle, organizations, uptimeChecks, usageCounters } from "@/server/db/schema";
import { HttpError } from "@/server/lib/errors";
import { RATE_LIMITS } from "@/server/lib/rate-limit";
import { LOCKOUT, lockedUntil, recordFailure } from "@/server/services/lockout";
import { resetBreakers } from "@/server/services/resilience";
import { WORKSPACE_ROWS_METRIC } from "@/server/services/workspace-budget";
import { clearLockout, listLockouts, systemSnapshot, LOCKOUT_SORT_FIELDS } from "@/server/services/console/system";
import type { ConsoleCursor, ConsolePage, ConsolePageResult } from "@/server/services/console/jobs";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
const page = <F extends string>(field: F, dir: "asc" | "desc" = "desc", limit = 50, cursor: ConsoleCursor | null = null): ConsolePage<F> => ({ limit, cursor, sort: { field, dir } });

async function walk<T>(fetch: (cursor: ConsoleCursor | null) => Promise<ConsolePageResult<T>>, id: (t: T) => string) {
  const out: string[] = [];
  let cursor: ConsoleCursor | null = null;
  for (let i = 0; i < 100; i++) {
    const r = await fetch(cursor);
    out.push(...r.items.map(id));
    if (!r.next) break;
    cursor = r.next;
  }
  return out;
}

async function expectHttp(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    if (code) expect((e as HttpError).code).toBe(code);
    return;
  }
  throw new Error(`expected HTTP ${status}`);
}

let ctx: Ctx;
beforeEach(async () => {
  resetBreakers();
  ctx = await makeTestApp({ WORKSPACE_DAILY_WRITES: "1000", SENTRY_DSN_API: "https://key@sentry.example/1" });
});

describe("systemSnapshot", () => {
  it("combines release, migrations, budgets, busiest workspaces, integrations, breakers, rate limits and uptime, with no secrets", async () => {
    await new Client(ctx.app).signup("owner@alpha.test", "Owner", "Alpha");
    await new Client(ctx.app).signup("owner@beta.test", "Owner", "Beta");
    const alpha = (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Alpha")).get())!.id;
    const beta = (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Beta")).get())!.id;
    const day = new Date().toISOString().slice(0, 10);
    await ctx.db.delete(usageCounters).where(eq(usageCounters.metric, WORKSPACE_ROWS_METRIC));
    await ctx.db.insert(usageCounters).values({ orgId: alpha, period: day, metric: WORKSPACE_ROWS_METRIC, count: 950 });
    await ctx.db.insert(usageCounters).values({ orgId: beta, period: day, metric: WORKSPACE_ROWS_METRIC, count: 20 });
    await ctx.db.insert(usageCounters).values({ orgId: beta, period: "2000-01-01", metric: WORKSPACE_ROWS_METRIC, count: 99_999 });
    await ctx.db.insert(uptimeChecks).values({ id: "upc_1", at: new Date(), ok: true, latencyMs: 12, components: JSON.stringify({ app: "operational" }) });
    await ctx.db.insert(uptimeChecks).values({ id: "upc_2", at: new Date(), ok: false, latencyMs: 40, components: JSON.stringify({ app: "down" }) });

    const s = await systemSnapshot(ctx.deps);
    expect(s.release).toBe(ctx.deps.config.release);
    expect(s.mode).toBe(ctx.deps.config.mode);
    expect(s.migrations).toEqual({ ok: true, pending: [] });
    // No analytics token in tests: the meter is off and says so.
    expect(s.database).toEqual({ meter: "off", writes: null, reads: null });
    expect(s.busiestWorkspaces.day).toBe(day);
    expect(s.busiestWorkspaces.budget).toBe(1000);
    expect(s.busiestWorkspaces.items).toEqual([
      { orgId: alpha, workspaceName: "Alpha", ownerEmail: "owner@alpha.test", rowsWritten: 950, level: "near" },
      { orgId: beta, workspaceName: "Beta", ownerEmail: "owner@beta.test", rowsWritten: 20, level: "ok" },
    ]);
    expect(s.integrations).toMatchObject({ outbound: expect.any(String), billing: expect.any(Boolean), auth0: expect.any(Boolean), writeBudgetMeter: false, sentryApi: true });
    expect(s.circuitBreakers).toEqual({ scope: "this_isolate", providers: [{ provider: "outbound", state: "closed" }, { provider: "stripe", state: "closed" }] });
    expect(s.rateLimits.perMinute).toEqual(RATE_LIMITS);
    expect(s.rateLimits.store).toEqual({ auth: "database", api: "database", webhooks: "database", app: "database", handoff: "database" });
    expect(s.rateLimits.lockout).toEqual({ maxFailures: LOCKOUT.MAX_FAILURES, windowMs: LOCKOUT.WINDOW_MS, lockForMs: LOCKOUT.LOCK_FOR_MS });
    expect(s.uptime?.days).toHaveLength(90);
    expect(s.uptime?.days.at(-1)).toMatchObject({ checks: 2, uptime: 0.5, worst: "down" });
    const text = JSON.stringify(s);
    expect(text).not.toContain("sentry.example");
    expect(text).not.toContain(ctx.deps.config.appSecret);
  });
});

describe("login lockouts", () => {
  const now = () => new Date();
  async function lock(email: string, failures: number = LOCKOUT.MAX_FAILURES) {
    for (let i = 0; i < failures; i++) await recordFailure(ctx.db, email, now());
  }

  it("lists current lockouts (default) or every account with failures, pages, rejects bad sorts", async () => {
    for (let i = 0; i < 7; i++) await lock(`locked${i}@example.com`);
    await lock("almost@example.com", 3);
    await new Client(ctx.app).signup("person@example.com", "Person", "P");
    await lock("person@example.com");
    // An expired lock is not current.
    await ctx.db.insert(loginThrottle).values({ email: "expired@example.com", failures: 10, windowStart: new Date(Date.now() - 3_600_000), lockedUntil: new Date(Date.now() - 60_000) });

    const r = await listLockouts(ctx.deps, {}, page("lockedUntil", "desc", 200));
    expect(r.items).toHaveLength(8);
    expect(r.items.every((x) => x.locked && x.unlocksInMs > 0 && x.failures === LOCKOUT.MAX_FAILURES)).toBe(true);
    expect(r.items.find((x) => x.email === "person@example.com")?.userId).toMatch(/.+/);
    expect(r.items.find((x) => x.email === "locked0@example.com")?.userId).toBeNull();
    const all = await listLockouts(ctx.deps, { lockedOnly: false }, page("failures", "asc", 200));
    expect(all.items.map((x) => x.email)).toEqual(expect.arrayContaining(["almost@example.com", "expired@example.com"]));
    expect(all.items[0]).toMatchObject({ email: "almost@example.com", locked: false, unlocksInMs: 0, failures: 3 });
    for (const field of LOCKOUT_SORT_FIELDS) {
      const full = (await listLockouts(ctx.deps, { lockedOnly: false }, page(field, "desc", 200))).items.map((x) => x.email);
      const ids = await walk((cursor) => listLockouts(ctx.deps, { lockedOnly: false }, page(field, "desc", 3, cursor)), (x) => x.email);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(full);
      expect(ids).toHaveLength(10);
    }
    await expectHttp(listLockouts(ctx.deps, {}, page("email" as never)), 422, "invalid_sort");
  });

  it("clears a lockout through lockout.ts so sign-in may proceed, and 404s when there is nothing to clear", async () => {
    await lock("Locked@Example.com");
    expect(await lockedUntil(ctx.db, "locked@example.com", now())).not.toBeNull();
    const r = await clearLockout(ctx.deps, "  LOCKED@example.com ");
    expect(r).toEqual({ email: "locked@example.com", cleared: true, wasLocked: true, failures: LOCKOUT.MAX_FAILURES });
    expect(await lockedUntil(ctx.db, "locked@example.com", now())).toBeNull();
    expect((await listLockouts(ctx.deps, {}, page("lockedUntil"))).items).toEqual([]);
    await expectHttp(clearLockout(ctx.deps, "locked@example.com"), 404);
    await expectHttp(clearLockout(ctx.deps, ""), 422);
  });
});

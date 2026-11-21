/**
 * OPS1: /api/console/metrics, Trends (Phase 5). Daily platform metrics and per workspace trends.
 *
 * GET  /api/console/metrics?metrics=a,b&days=7|30|90         (or from=YYYY-MM-DD&to=YYYY-MM-DD) metrics.read
 *      { from, to, liveDay, days, series, firstDay } (services/console/metrics.ts readMetrics: gaps are null)
 * GET  /api/console/metrics/registry                           metrics.read: every metric's label, kind, unit, description
 * GET  /api/console/metrics/workspaces/:id?days=7|30|90         workspaces.read: one workspace's mail, AI and daily counters
 * POST /api/console/metrics/backfill  { days: 1..90, reason }   system.manage, audited metrics.backfilled
 * POST /api/console/metrics/roll      { reason }                system.manage, audited metrics.rolled (the daily rollup by hand)
 *
 * There is no metrics specific change permission; the two writes use system.manage (operations admins and owners),
 * the tier that runs maintenance. Both answer 409 writes_paused (and audit nothing) while optional writes are paused.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../context";
import { organizations } from "../../db/schema";
import { HttpError, badRequest, notFound } from "../../lib/errors";
import { parseBody, parseQuery } from "../../middleware";
import { operatorSession, requireOperator } from "../../auth/operator";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import {
  MAX_BACKFILL_DAYS, PLATFORM_METRICS, addDays, backfillFlowMetrics, dayOf, isDay, metricDef, readMetrics, readWorkspaceTrends,
  rollPlatformMetrics, type RollResult,
} from "../../services/console/metrics";

export const TREND_RANGES = [7, 30, 90] as const;

const RangeQuery = z.object({
  days: z.enum(["7", "30", "90"], { error: "Pick 7, 30 or 90 days." }).optional(),
  from: z.string().max(20).optional(),
  to: z.string().max(20).optional(),
}).passthrough();

/** The day range a read asks for: from and to (both), or days (default 30) ending today (UTC). */
function rangeOf(c: Context<AppEnv>): { from: string; to: string } {
  const q = parseQuery(c, RangeQuery);
  if (q.from || q.to) {
    if (q.days) throw badRequest("Ask for days or for from and to, not both.");
    if (!isDay(q.from) || !isDay(q.to)) throw badRequest("Use from and to dates like 2026-11-21.");
    if (q.from > q.to) throw badRequest("The start date is after the end date.");
    return { from: q.from, to: q.to };
  }
  const to = dayOf(c.var.deps.now());
  return { from: addDays(to, -(Number(q.days ?? 30) - 1)), to };
}

/** The service's RangeError (bad metric, range too long) is the caller's mistake: 400 with its message. */
async function asBadRequest<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof RangeError) throw badRequest(e.message.charAt(0).toUpperCase() + e.message.slice(1) + ".");
    throw e;
  }
}

/** What a rollup or backfill did, for the response and the audit row (counts, not the rows themselves). */
function summary(r: RollResult) {
  return { skipped: r.skipped ?? null, days: r.days.length, from: r.days[0] ?? null, to: r.days[r.days.length - 1] ?? null, rows: r.rows.length };
}

function refusePaused(r: RollResult): RollResult {
  if (r.skipped === "writes_paused") throw new HttpError(409, "writes_paused", "Writes are paused to protect the database budget. Try again once the budget resets.");
  return r;
}

export function metricsRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/registry", requireOperator("metrics.read"), (c) => {
      c.header("cache-control", "no-store");
      return c.json({
        metrics: PLATFORM_METRICS.map((m) => ({
          key: m.key, label: m.label, kind: m.kind, unit: m.unit, description: m.description,
          retentionDays: "retentionDays" in m ? m.retentionDays : null,
        })),
        ranges: TREND_RANGES,
        maxBackfillDays: MAX_BACKFILL_DAYS,
      });
    })
    .get("/workspaces/:id", requireOperator("workspaces.read"), async (c) => {
      const id = c.req.param("id");
      const range = rangeOf(c);
      if (id.length > 100) throw notFound("Workspace");
      const org = await c.var.deps.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id)).get();
      if (!org) throw notFound("Workspace");
      const out = await asBadRequest(() => readWorkspaceTrends(c.var.deps, org.id, range));
      const aiDays = metricDef("ai_calls").retentionDays ?? null;
      const aiFrom = aiDays === null ? null : addDays(dayOf(c.var.deps.now()), -aiDays);
      c.header("cache-control", "no-store");
      // aiFrom: the first day AI history is kept for; days before it read as null (no data), not zero.
      return c.json({ ...out, ai: { historyDays: aiDays, from: aiFrom, partial: aiFrom !== null && aiFrom > out.from } });
    })
    .get("/", requireOperator("metrics.read"), async (c) => {
      const raw = c.req.query("metrics") ?? "";
      if (raw.length > 1000) throw badRequest("Too many metrics.");
      const metrics = raw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!metrics.length) throw badRequest("Name at least one metric, for example metrics=signups.");
      const range = rangeOf(c);
      const out = await asBadRequest(() => readMetrics(c.var.deps, { metrics, ...range }));
      c.header("cache-control", "no-store");
      return c.json(out);
    })
    .post("/backfill", requireOperator("system.manage"), async (c) => {
      const body = await parseBody(c, z.object({
        days: z.number({ error: `Pick how many days to fill in (1 to ${MAX_BACKFILL_DAYS}).` }).int("Use a whole number of days.").min(1, "Fill in at least 1 day.").max(MAX_BACKFILL_DAYS, `At most ${MAX_BACKFILL_DAYS} days.`),
        reason: reasonSchema,
      }));
      const r = await operatorAction(c, {
        action: "metrics.backfilled", targetType: "platform_metrics", targetId: (x: RollResult) => summary(x).from ?? "none", reason: body.reason,
        before: null, after: (x: RollResult) => summary(x), metadata: { days: body.days },
      }, async () => refusePaused(await asBadRequest(() => backfillFlowMetrics(c.var.deps, body.days))));
      return c.json({ ok: true, ...summary(r) });
    })
    .post("/roll", requireOperator("system.manage"), async (c) => {
      const body = await parseBody(c, z.object({ reason: reasonSchema }));
      const r = await operatorAction(c, {
        action: "metrics.rolled", targetType: "platform_metrics", targetId: (x: RollResult) => summary(x).to ?? "none", reason: body.reason,
        before: null, after: (x: RollResult) => summary(x),
      }, async () => refusePaused(await rollPlatformMetrics(c.var.deps)));
      return c.json({ ok: true, ...summary(r) });
    });
}

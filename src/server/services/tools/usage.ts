/**
 * Tools usage, metered per workspace in tool_usage (migration 0091): one row per month ("2026-10")
 * and one per day ("2026-10-30"). A run costs one read (plan, switch and both counts in one
 * statement) and one write (both rows in one upsert); the audit row is the second write.
 */
import { sql } from "drizzle-orm";
import type { DB } from "../../db";
import { PLANS, isPlanId, type PlanId } from "@/shared/plans";

export const monthOf = (now: Date) => now.toISOString().slice(0, 7);
export const dayOf = (now: Date) => now.toISOString().slice(0, 10);

export type ToolsMode = "on" | "off" | null;
export interface ToolState { plan: PlanId; mode: ToolsMode; month: number; day: number }

/** Plan, the workspace switch and this month's and today's runs, in one statement. Null when the workspace is gone. */
export async function readToolState(db: DB, orgId: string, now: Date): Promise<ToolState | null> {
  const r = await db.get<{ plan: string; mode: string | null; m: number | null; d: number | null }>(sql`
    select o.plan as plan, o.tools_mode as mode,
      (select runs from tool_usage where org_id = o.id and period = ${monthOf(now)}) as m,
      (select runs from tool_usage where org_id = o.id and period = ${dayOf(now)}) as d
    from organizations o where o.id = ${orgId}`);
  if (!r) return null;
  return {
    plan: isPlanId(r.plan) ? r.plan : "starter",
    mode: r.mode === "on" || r.mode === "off" ? r.mode : null,
    month: Number(r.m ?? 0), day: Number(r.d ?? 0),
  };
}

/** Counts one run against the month and the day, in one statement. */
export async function recordRun(db: DB, orgId: string, now: Date, bytesIn: number): Promise<void> {
  const b = Math.max(0, Math.floor(bytesIn));
  await db.run(sql`insert into tool_usage (org_id, period, runs, bytes_in)
    values (${orgId}, ${monthOf(now)}, 1, ${b}), (${orgId}, ${dayOf(now)}, 1, ${b})
    on conflict (org_id, period) do update set runs = runs + 1, bytes_in = bytes_in + excluded.bytes_in`);
}

/** Housekeeping: day rows older than 2 days and month rows older than 13 months. */
export async function pruneToolUsage(db: DB, now: Date): Promise<void> {
  const day = dayOf(new Date(now.getTime() - 2 * 86_400_000));
  const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1));
  await db.run(sql`delete from tool_usage where (length(period) = 10 and period < ${day}) or (length(period) = 7 and period < ${monthOf(m)})`);
}

export function toolLimits(plan: PlanId) {
  const l = PLANS[plan].limits;
  return { runsMonthly: l.toolRunsMonthly, runsDaily: l.toolRunsDaily, maxBytes: l.toolMaxBytes, maxMergeFiles: l.toolMaxMergeFiles };
}

/** Tools are on for a workspace unless its admins switched them off. */
export const toolsOnFor = (s: Pick<ToolState, "mode">) => s.mode !== "off";

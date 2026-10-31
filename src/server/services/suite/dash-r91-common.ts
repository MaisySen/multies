/**
 * R91 Dashboards plus: shared helpers. The flag (DASHBOARDS_PLUS), the creator actor used when a link,
 * report or alert computes numbers without a session, time zone maths, and the plain summary of a widget
 * that the emails, the PDF and the alerts read.
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { members, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { dateFormat } from "../../lib/intl-cache";
import type { SuiteActor } from "./common";

export const DAY = 86_400_000;

export function plusEnabled(deps: Deps): boolean {
  return !!deps.config.dashboardsPlus;
}
export function assertPlus(deps: Deps) {
  if (!plusEnabled(deps)) throw new HttpError(404, "not_found", "Not found.");
}

/** The person who made a link, report or alert, as an actor with their current role. Null when they left. */
export async function creatorActor(deps: Deps, orgId: string, userId: string): Promise<SuiteActor | null> {
  const r = await deps.db.select({ role: members.role, email: users.email, name: users.name }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), eq(members.userId, userId))).get();
  return r ? { orgId, userId, email: r.email, name: r.name, role: r.role } : null;
}

export function validZone(tz: string): boolean {
  try { dateFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Milliseconds the zone is ahead of UTC at t. */
export function offsetMs(t: number, tz: string): number {
  const p = Object.fromEntries(dateFormat("en-US", { timeZone: validZone(tz) ? tz : "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - Math.floor(t / 60_000) * 60_000;
}

/** Local calendar parts at t: year, month (1 to 12), day, hour, weekday (0 Monday to 6 Sunday). */
export function localParts(t: number, tz: string) {
  const d = new Date(t + offsetMs(t, tz));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), weekday: (d.getUTCDay() + 6) % 7 };
}

/** The UTC moment of a local wall time in the zone (DST aware, checked twice). */
export function zonedTime(year: number, month: number, day: number, hour: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  let t = wall - offsetMs(wall, tz);
  t = wall - offsetMs(t, tz);
  return t;
}

export interface WidgetSummary { title: string; value: string | null; rows: { label: string; value: string }[] }

const fmt = (n: number, format?: string | null) => format === "money" ? `$${n.toLocaleString("en-AU", { maximumFractionDigits: 2 })}` : format === "hours" ? `${Math.round(n * 10) / 10} h` : n.toLocaleString("en-AU", { maximumFractionDigits: 2 });

/** A plain number for alerts: the card's single value, or null when it is not a number card. */
export function numberOf(data: unknown): number | null {
  if (typeof data === "number") return data;
  if (data && typeof data === "object") {
    const v = (data as { value?: unknown }).value;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** The value or the top groups of any widget's data, for email, PDF and alerts. Unknown shapes say so. */
export function summarise(title: string, data: unknown, error?: string | null): WidgetSummary {
  if (error) return { title, value: error, rows: [] };
  const format = data && typeof data === "object" ? ((data as { format?: string | null }).format ?? null) : null;
  const n = numberOf(data);
  if (n !== null) return { title, value: fmt(n, format), rows: [] };
  if (data && typeof data === "object") {
    for (const v of Object.values(data as Record<string, unknown>)) {
      if (!Array.isArray(v) || !v.length || typeof v[0] !== "object" || v[0] === null) continue;
      const rows = (v as Record<string, unknown>[]).map((r) => {
        const label = [r.label, r.name, r.title, r.key, r.week, r.day].find((x) => typeof x === "string") as string | undefined;
        const num = [r.value, r.count, r.n, r.total, r.done].find((x) => typeof x === "number") as number | undefined;
        return label !== undefined && num !== undefined ? { label, value: fmt(num, format) } : null;
      }).filter(Boolean) as { label: string; value: string }[];
      if (rows.length) return { title, value: null, rows: rows.slice(0, 8) };
    }
  }
  return { title, value: "Open the dashboard to see this card.", rows: [] };
}

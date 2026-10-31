/**
 * R91 threshold alerts on a number card. When the card's number goes above (or below) the threshold the
 * creator hears once, in the app and by mail when chosen. It fires once per crossing: it stays quiet while
 * the number stays past the line and rearms when it comes back. A crossing during quiet hours waits and is
 * sent when quiet hours end, if the number is still past the line. Checked in the maintenance pass, every
 * 15 minutes, at most 20 alerts a pass; dashboards are computed once per pass however many alerts they hold.
 */
import { and, asc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../../context";
import { dashboardAlerts } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import type { SuiteActor } from "./common";
import { dashboardData, getDashboard, personOf, rowFor } from "./dashboards";
import { creatorActor, localParts, numberOf, validZone } from "./dash-r91-common";

export const ALERT_EVERY_MS = 15 * 60_000;
export const ALERTS_PER_PASS = 20;
export const MAX_ALERTS_PER_DASHBOARD = 20;
export const NUMBER_TYPES = ["count", "calculation", "question"];

export const AlertInput = z.object({
  widgetId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  direction: z.enum(["above", "below"]),
  threshold: z.number().finite(),
  byMail: z.boolean().default(true),
  quietStart: z.number().int().min(0).max(23).nullable().default(22),
  quietEnd: z.number().int().min(0).max(23).nullable().default(7),
  timeZone: z.string().max(64).default("UTC"),
  enabled: z.boolean().default(true),
}).strict();
export type AlertInput = z.infer<typeof AlertInput>;

/** Whether a local hour sits in quiet hours (start inclusive, end exclusive; wraps past midnight). */
export function inQuiet(hour: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export interface AlertState { state: "ok" | "crossed" | null; pending: boolean }
/** The crossing rule. Pure, so every case is unit tested. */
export function evaluate(prev: AlertState, value: number, threshold: number, direction: "above" | "below", quiet: boolean): AlertState & { fire: boolean } {
  const crossed = direction === "above" ? value > threshold : value < threshold;
  if (!crossed) return { state: "ok", pending: false, fire: false };
  if (prev.state !== "crossed") return quiet ? { state: "crossed", pending: true, fire: false } : { state: "crossed", pending: false, fire: true };
  if (prev.pending && !quiet) return { state: "crossed", pending: false, fire: true };
  return { state: "crossed", pending: prev.pending, fire: false };
}

type Row = typeof dashboardAlerts.$inferSelect;
const present = (r: Row) => ({ id: r.id, widgetId: r.widgetId, direction: r.direction, threshold: r.threshold, byMail: r.byMail, quietStart: r.quietStart, quietEnd: r.quietEnd,
  timeZone: r.timeZone, enabled: r.enabled, state: r.state, lastValue: r.lastValue, lastFiredAt: r.lastFiredAt?.toISOString() ?? null, mine: true });

export async function listAlerts(deps: Deps, actor: SuiteActor, dashboardId: string) {
  const d = await rowFor(deps, actor, dashboardId);
  const me = personOf(actor);
  if (!me) return { alerts: [] };
  const rows = await deps.db.select().from(dashboardAlerts).where(and(eq(dashboardAlerts.orgId, actor.orgId), eq(dashboardAlerts.dashboardId, d.id), eq(dashboardAlerts.createdBy, me))).orderBy(asc(dashboardAlerts.createdAt)).limit(MAX_ALERTS_PER_DASHBOARD);
  return { alerts: rows.map(present) };
}

/** Anyone who can open the dashboard can watch one of its number cards for themselves. */
export async function createAlert(deps: Deps, actor: SuiteActor, dashboardId: string, input: AlertInput) {
  const me = personOf(actor);
  if (!me) throw new HttpError(403, "forbidden", "Only a signed in member can set an alert.");
  const d = await getDashboard(deps, actor, dashboardId);
  const w = d.widgets.find((x) => x.id === input.widgetId);
  if (!w) throw notFound("Card");
  if (!NUMBER_TYPES.includes(w.type) || (w.type === "question" && w.question?.groupBy)) throw new HttpError(422, "validation_failed", "Alerts work on cards that show one number.");
  if (!validZone(input.timeZone)) throw new HttpError(422, "validation_failed", "Pick a time zone from the list.");
  const mine = await deps.db.select({ id: dashboardAlerts.id }).from(dashboardAlerts).where(and(eq(dashboardAlerts.dashboardId, d.id), eq(dashboardAlerts.createdBy, me)));
  if (mine.length >= MAX_ALERTS_PER_DASHBOARD) throw new HttpError(422, "too_many_alerts", `You can have up to ${MAX_ALERTS_PER_DASHBOARD} alerts on one dashboard.`);
  const row: typeof dashboardAlerts.$inferInsert = { id: newId("dal"), orgId: actor.orgId, dashboardId: d.id, widgetId: w.id, createdBy: me, direction: input.direction, threshold: input.threshold,
    byMail: input.byMail, quietStart: input.quietStart, quietEnd: input.quietEnd, timeZone: input.timeZone, state: null, pending: false, enabled: input.enabled, nextCheckAt: deps.now(), createdAt: deps.now() };
  await deps.db.insert(dashboardAlerts).values(row);
  return { alert: present(row as Row) };
}

async function alertRow(deps: Deps, actor: SuiteActor, id: string) {
  const r = await deps.db.select().from(dashboardAlerts).where(and(eq(dashboardAlerts.orgId, actor.orgId), eq(dashboardAlerts.id, id), eq(dashboardAlerts.createdBy, personOf(actor) || "-"))).get();
  if (!r) throw notFound("Alert");
  return r;
}
export async function updateAlert(deps: Deps, actor: SuiteActor, id: string, input: Partial<AlertInput>) {
  const r = await alertRow(deps, actor, id);
  if (input.timeZone && !validZone(input.timeZone)) throw new HttpError(422, "validation_failed", "Pick a time zone from the list.");
  const rule = input.direction !== undefined || input.threshold !== undefined;
  const patch = { ...("direction" in input ? { direction: input.direction } : {}), ...("threshold" in input ? { threshold: input.threshold } : {}), ...("byMail" in input ? { byMail: input.byMail } : {}),
    ...("quietStart" in input ? { quietStart: input.quietStart } : {}), ...("quietEnd" in input ? { quietEnd: input.quietEnd } : {}), ...("timeZone" in input ? { timeZone: input.timeZone } : {}),
    ...("enabled" in input ? { enabled: input.enabled } : {}), ...(rule ? { state: null, pending: false } : {}), nextCheckAt: deps.now() } as Partial<Row>;
  await deps.db.update(dashboardAlerts).set(patch).where(eq(dashboardAlerts.id, r.id));
  return { alert: present({ ...r, ...patch }) };
}
export async function deleteAlert(deps: Deps, actor: SuiteActor, id: string) {
  const r = await alertRow(deps, actor, id);
  await deps.db.delete(dashboardAlerts).where(eq(dashboardAlerts.id, r.id));
  return { ok: true };
}

const fmt = (n: number) => n.toLocaleString("en-AU", { maximumFractionDigits: 2 });

/** The maintenance step. */
export async function runDueAlerts(deps: Deps) {
  const now = deps.now().getTime();
  const due = await deps.db.select().from(dashboardAlerts).where(and(eq(dashboardAlerts.enabled, true), lte(dashboardAlerts.nextCheckAt, new Date(now)))).orderBy(asc(dashboardAlerts.nextCheckAt)).limit(ALERTS_PER_PASS);
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof dashboardData>> | null>>();
  let fired = 0;
  for (const a of due) {
    const next = new Date(now + ALERT_EVERY_MS);
    try {
      const actor = await creatorActor(deps, a.orgId, a.createdBy);
      if (!actor) { await deps.db.update(dashboardAlerts).set({ enabled: false, nextCheckAt: next }).where(eq(dashboardAlerts.id, a.id)); continue; }
      const key = `${a.dashboardId}:${a.createdBy}`;
      if (!cache.has(key)) cache.set(key, dashboardData(deps, actor, a.dashboardId).catch((e) => { if (e instanceof HttpError && e.status < 500) return null; throw e; }));
      const data = await cache.get(key)!;
      const w = data?.widgets.find((x) => x.id === a.widgetId);
      const value = w && !w.error ? numberOf(w.data) : null;
      if (value === null) { await deps.db.update(dashboardAlerts).set({ nextCheckAt: next }).where(eq(dashboardAlerts.id, a.id)); continue; }
      const quiet = inQuiet(localParts(now, a.timeZone).hour, a.quietStart, a.quietEnd);
      const r = evaluate({ state: a.state, pending: a.pending }, value, a.threshold, a.direction, quiet);
      await deps.db.update(dashboardAlerts).set({ state: r.state, pending: r.pending, lastValue: value, nextCheckAt: next, ...(r.fire ? { lastFiredAt: new Date(now) } : {}) }).where(eq(dashboardAlerts.id, a.id));
      if (!r.fire) continue;
      fired++;
      const title = data!.dashboard.widgets.find((x) => x.id === a.widgetId)?.title ?? "A card";
      const text = `${title} is ${a.direction} ${fmt(a.threshold)}: it is ${fmt(value)} now (${data!.dashboard.name}).`;
      const { notify } = await import("./notify");
      await notify(deps, a.orgId, a.createdBy, { type: "dashboard_alert", entityType: "dashboard", entityId: a.dashboardId, title: text });
      if (a.byMail && actor.email) {
        const { sendSystemEmail } = await import("../system-mail");
        const url = `${deps.config.appUrl.replace(/\/$/, "")}/app/dashboards/${encodeURIComponent(a.dashboardId)}`;
        await sendSystemEmail(deps, { to: actor.email, subject: `Alert: ${title} is ${a.direction} ${fmt(a.threshold)}`, text: `${text}\n\nYou will hear again only after it comes back and crosses the line again.\n\nOpen the dashboard: ${url}`, action: { label: "Open dashboard", url }, orgId: a.orgId });
      }
    } catch (e) {
      await deps.db.update(dashboardAlerts).set({ nextCheckAt: next }).where(eq(dashboardAlerts.id, a.id));
      deps.reportError?.(e, { where: "dash_alerts" });
    }
  }
  return { due: due.length, fired };
}

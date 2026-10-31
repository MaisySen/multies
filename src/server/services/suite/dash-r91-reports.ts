/**
 * R91 scheduled report emails. A report mails one dashboard daily, weekly (on a weekday) or monthly (on a
 * day, the last day when the month is shorter) at an hour in a time zone, to workspace members and outside
 * emails (up to 20). Each mail carries every card's number or top groups in the body, a link to open the
 * dashboard (members: the app; outside people: the report's own read only link) and, when chosen, a PDF
 * snapshot to download. Every recipient has a one click unsubscribe. Due reports run in the maintenance
 * pass, at most 10 a pass, picked by (enabled, next_run_at).
 */
import { and, asc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../../context";
import { dashboardReports, dashboardShares, members, users } from "../../db/schema";
import { hmacSha256Hex, newId, safeEqual } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import type { SuiteActor } from "./common";
import { assertCanChange, personOf, rowFor } from "./dashboards";
import { DAY, localParts, summarise, validZone, zonedTime, type WidgetSummary } from "./dash-r91-common";
import { buildPublic, ensureReportShare, shareUrl, type PublicDashboard } from "./dash-r91-share";

export const MAX_RECIPIENTS = 20;
export const MAX_REPORTS_PER_DASHBOARD = 10;
export const REPORTS_PER_PASS = 10;

export const ReportInput = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  hour: z.number().int().min(0).max(23).default(8),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  monthDay: z.number().int().min(1).max(31).nullable().optional(),
  timeZone: z.string().max(64).default("UTC"),
  withPdf: z.boolean().default(true),
  recipients: z.array(z.object({ email: z.string().trim().toLowerCase().email("Check the email addresses."), userId: z.string().max(64).optional() }).strict()).min(1, "Add at least one person to send it to.").max(MAX_RECIPIENTS, `A report goes to up to ${MAX_RECIPIENTS} people.`),
  enabled: z.boolean().default(true),
}).strict();
export type ReportInput = z.infer<typeof ReportInput>;
type Schedule = Pick<ReportInput, "frequency" | "hour" | "weekday" | "monthDay" | "timeZone">;

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The first run strictly after `after`, in the report's zone. Monthly on the 31st runs on the last day of short months. */
export function nextRunAt(s: Schedule, after: number): number {
  const tz = validZone(s.timeZone) ? s.timeZone : "UTC";
  for (let d = 0; d <= 62; d++) {
    const p = localParts(after + d * DAY, tz);
    if (s.frequency === "weekly" && p.weekday !== (s.weekday ?? 0)) continue;
    if (s.frequency === "monthly" && p.day !== Math.min(s.monthDay ?? 1, daysIn(p.year, p.month))) continue;
    const t = zonedTime(p.year, p.month, p.day, s.hour, tz);
    if (t > after) return t;
  }
  return after + DAY;
}

type Row = typeof dashboardReports.$inferSelect;
const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
function present(r: Row) {
  return { id: r.id, frequency: r.frequency, hour: r.hour, weekday: r.weekday, monthDay: r.monthDay, timeZone: r.timeZone, withPdf: r.withPdf, enabled: r.enabled,
    recipients: parse<{ email: string; userId?: string }[]>(r.recipients, []), unsubscribed: parse<string[]>(r.unsubscribed, []),
    nextRunAt: r.nextRunAt.toISOString(), lastRunAt: r.lastRunAt?.toISOString() ?? null, lastError: r.lastError };
}

async function checkRecipients(deps: Deps, orgId: string, list: ReportInput["recipients"]) {
  const ids = [...new Set(list.map((r) => r.userId).filter(Boolean))] as string[];
  if (!ids.length) return list.map((r) => ({ email: r.email }));
  const found = await deps.db.select({ id: users.id, email: users.email }).from(members).innerJoin(users, eq(users.id, members.userId)).where(and(eq(members.organizationId, orgId), inIds(members.userId, ids)));
  const byId = new Map(found.map((f) => [f.id, f.email.toLowerCase()]));
  return list.map((r) => {
    if (!r.userId) return { email: r.email };
    const e = byId.get(r.userId);
    if (!e) throw new HttpError(422, "validation_failed", "One of the people is no longer in this workspace.");
    return { email: e, userId: r.userId };
  }).filter((r, i, a) => a.findIndex((x) => x.email === r.email) === i);
}

async function manageable(deps: Deps, actor: SuiteActor, dashboardId: string) {
  const d = await rowFor(deps, actor, dashboardId);
  let canManage = true;
  try { assertCanChange(d, actor, "share"); } catch { canManage = false; }
  return { d, canManage };
}

export async function listReports(deps: Deps, actor: SuiteActor, dashboardId: string) {
  const { d, canManage } = await manageable(deps, actor, dashboardId);
  if (!canManage) return { canManage, reports: [] };
  const rows = await deps.db.select().from(dashboardReports).where(and(eq(dashboardReports.orgId, actor.orgId), eq(dashboardReports.dashboardId, d.id))).orderBy(asc(dashboardReports.createdAt)).limit(MAX_REPORTS_PER_DASHBOARD);
  return { canManage, reports: rows.map(present) };
}

export async function createReport(deps: Deps, actor: SuiteActor, dashboardId: string, input: ReportInput) {
  const { d, canManage } = await manageable(deps, actor, dashboardId);
  if (!canManage) assertCanChange(d, actor, "share");
  const me = personOf(actor);
  if (!me) throw new HttpError(403, "forbidden", "Only a signed in member can schedule a report.");
  if (!validZone(input.timeZone)) throw new HttpError(422, "validation_failed", "Pick a time zone from the list.");
  const count = await deps.db.select({ id: dashboardReports.id }).from(dashboardReports).where(eq(dashboardReports.dashboardId, d.id));
  if (count.length >= MAX_REPORTS_PER_DASHBOARD) throw new HttpError(422, "too_many_reports", `A dashboard can have up to ${MAX_REPORTS_PER_DASHBOARD} reports.`);
  const id = newId("drp");
  const share = await ensureReportShare(deps, actor.orgId, d.id, id, me);
  const now = deps.now().getTime();
  const row: typeof dashboardReports.$inferInsert = {
    id, orgId: actor.orgId, dashboardId: d.id, createdBy: me, frequency: input.frequency, hour: input.hour,
    weekday: input.frequency === "weekly" ? (input.weekday ?? 0) : null, monthDay: input.frequency === "monthly" ? (input.monthDay ?? 1) : null,
    timeZone: input.timeZone, withPdf: input.withPdf, recipients: JSON.stringify(await checkRecipients(deps, actor.orgId, input.recipients)), unsubscribed: "[]",
    shareId: share.id, enabled: input.enabled, nextRunAt: new Date(0), createdAt: new Date(now),
  };
  row.nextRunAt = new Date(nextRunAt({ frequency: input.frequency, hour: input.hour, weekday: row.weekday, monthDay: row.monthDay, timeZone: input.timeZone }, now));
  await deps.db.insert(dashboardReports).values(row);
  return { report: present(row as Row) };
}

async function reportRow(deps: Deps, actor: SuiteActor, id: string) {
  const r = await deps.db.select().from(dashboardReports).where(and(eq(dashboardReports.orgId, actor.orgId), eq(dashboardReports.id, id))).get();
  if (!r) throw notFound("Report");
  assertCanChange(await rowFor(deps, actor, r.dashboardId), actor, "share");
  return r;
}

export async function updateReport(deps: Deps, actor: SuiteActor, id: string, input: ReportInput) {
  const r = await reportRow(deps, actor, id);
  if (!validZone(input.timeZone)) throw new HttpError(422, "validation_failed", "Pick a time zone from the list.");
  const weekday = input.frequency === "weekly" ? (input.weekday ?? 0) : null, monthDay = input.frequency === "monthly" ? (input.monthDay ?? 1) : null;
  const recipients = await checkRecipients(deps, actor.orgId, input.recipients);
  const unsub = parse<string[]>(r.unsubscribed, []).filter((e) => recipients.some((x) => x.email === e));
  const patch = { frequency: input.frequency, hour: input.hour, weekday, monthDay, timeZone: input.timeZone, withPdf: input.withPdf, enabled: input.enabled,
    recipients: JSON.stringify(recipients), unsubscribed: JSON.stringify(unsub), lastError: null,
    nextRunAt: new Date(nextRunAt({ frequency: input.frequency, hour: input.hour, weekday, monthDay, timeZone: input.timeZone }, deps.now().getTime())) };
  await deps.db.update(dashboardReports).set(patch).where(eq(dashboardReports.id, r.id));
  return { report: present({ ...r, ...patch }) };
}

export async function deleteReport(deps: Deps, actor: SuiteActor, id: string) {
  const r = await reportRow(deps, actor, id);
  await deps.db.delete(dashboardReports).where(eq(dashboardReports.id, r.id));
  if (r.shareId) await deps.db.update(dashboardShares).set({ revokedAt: deps.now(), snapshot: null }).where(eq(dashboardShares.id, r.shareId));
  return { ok: true };
}

export async function unsubscribeToken(deps: Deps, reportId: string, email: string) {
  return (await hmacSha256Hex(deps.config.appSecret, `dash-report-unsub:${reportId}:${email.toLowerCase()}`)).slice(0, 32);
}

/** One click unsubscribe from the link in each mail. Idempotent; a bad token changes nothing. */
export async function unsubscribe(deps: Deps, reportId: string, email: string, token: string): Promise<boolean> {
  if (!safeEqual(token, await unsubscribeToken(deps, reportId, email))) return false;
  const r = await deps.db.select().from(dashboardReports).where(eq(dashboardReports.id, reportId)).get();
  if (!r) return true;
  const list = new Set(parse<string[]>(r.unsubscribed, []));
  list.add(email.toLowerCase());
  await deps.db.update(dashboardReports).set({ unsubscribed: JSON.stringify([...list]) }).where(eq(dashboardReports.id, r.id));
  return true;
}

// ---------------------------------------------------------------- PDF and mail

const latin = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

/** A one or more page A4 PDF: name, time, then each card's number or top groups. */
export async function reportPdf(d: PublicDashboard, when: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595, 842]);
  let y = 790;
  const line = (text: string, size: number, f = font, x = 48, color = rgb(0.1, 0.1, 0.12)) => {
    if (y < 60) { page = doc.addPage([595, 842]); y = 790; }
    page.drawText(latin(text).slice(0, 90), { x, y, size, font: f, color });
    y -= size + 8;
  };
  line(d.name, 20, bold);
  line(`${d.brand ? `${d.brand}  ·  ` : ""}Updated ${when}`, 10, font, 48, rgb(0.4, 0.4, 0.45));
  y -= 10;
  for (const w of d.widgets) {
    const s = summarise(w.title, d.data.find((x) => x.id === w.id)?.data, d.data.find((x) => x.id === w.id)?.error);
    line(s.title, 13, bold);
    if (s.value) line(s.value, s.rows.length ? 11 : 16, s.rows.length ? font : bold);
    for (const r of s.rows) {
      if (y < 60) { page = doc.addPage([595, 842]); y = 790; }
      page.drawText(latin(r.label).slice(0, 60), { x: 60, y, size: 11, font, color: rgb(0.2, 0.2, 0.24) });
      page.drawText(latin(r.value), { x: 460, y, size: 11, font: bold, color: rgb(0.1, 0.1, 0.12) });
      y -= 18;
    }
    y -= 12;
  }
  return doc.save();
}

export function reportText(name: string, summaries: WidgetSummary[]): string {
  const parts = summaries.map((s) => [s.title, ...(s.value ? [`  ${s.value}`] : []), ...s.rows.map((r) => `  ${r.label}: ${r.value}`)].join("\n"));
  return `${name}\n\n${parts.join("\n\n")}`;
}

const when = (t: number, tz: string) => new Date(t).toLocaleString("en-AU", { timeZone: validZone(tz) ? tz : "UTC", dateStyle: "medium", timeStyle: "short" });

/** Sends one report now. Returns how many mails went out. */
export async function sendReport(deps: Deps, r: Row): Promise<{ sent: number; error: string | null }> {
  const dash = await buildPublic(deps, { orgId: r.orgId, dashboardId: r.dashboardId, createdBy: r.createdBy, showBrand: true });
  if (!dash) return { sent: 0, error: "The dashboard or the person who scheduled it is no longer here." };
  const share = await ensureReportShare(deps, r.orgId, r.dashboardId, r.id, r.createdBy);
  const base = deps.config.appUrl.replace(/\/$/, "");
  const shared = shareUrl(deps, share.token);
  const summaries = dash.widgets.map((w) => summarise(w.title, dash.data.find((x) => x.id === w.id)?.data, dash.data.find((x) => x.id === w.id)?.error));
  const body = reportText(dash.name, summaries);
  const unsub = new Set(parse<string[]>(r.unsubscribed, []));
  const { sendSystemEmail } = await import("../system-mail");
  let sent = 0;
  for (const to of parse<{ email: string; userId?: string }[]>(r.recipients, [])) {
    if (unsub.has(to.email)) continue;
    const off = `${base}/api/dash-public/reports/unsubscribe?r=${encodeURIComponent(r.id)}&e=${encodeURIComponent(to.email)}&t=${await unsubscribeToken(deps, r.id, to.email)}`;
    const open = to.userId ? `${base}/app/dashboards/${encodeURIComponent(r.dashboardId)}` : shared;
    const text = `${body}\n\nUpdated ${when(Date.parse(dash.updatedAt), r.timeZone)}.\n${r.withPdf ? `PDF: ${base}/api/dash-public/${share.token}/pdf\n` : ""}Open the dashboard: ${open}\n\nStop these emails: ${off}`;
    const res = await sendSystemEmail(deps, { to: to.email, subject: `${dash.name}: your ${r.frequency} report`, text, action: { label: "Open dashboard", url: open }, orgId: r.orgId });
    if (res.delivered || res.via !== "none") sent++;
  }
  return { sent, error: null };
}

/** The maintenance step: due reports, at most REPORTS_PER_PASS. A failure is kept on the row and retried next run. */
export async function runDueReports(deps: Deps) {
  const now = deps.now().getTime();
  const due = await deps.db.select().from(dashboardReports).where(and(eq(dashboardReports.enabled, true), lte(dashboardReports.nextRunAt, new Date(now)))).orderBy(asc(dashboardReports.nextRunAt)).limit(REPORTS_PER_PASS);
  let ran = 0;
  for (const r of due) {
    // Claim first (next run moves on), so a crash or an overlapping pass never mails twice.
    const next = new Date(nextRunAt(r, now));
    const claimed = await deps.db.update(dashboardReports).set({ nextRunAt: next, lastRunAt: new Date(now) }).where(and(eq(dashboardReports.id, r.id), eq(dashboardReports.nextRunAt, r.nextRunAt))).returning({ id: dashboardReports.id });
    if (!claimed.length) continue;
    try {
      const res = await sendReport(deps, r);
      await deps.db.update(dashboardReports).set({ lastError: res.error, ...(res.error ? { enabled: false } : {}) }).where(eq(dashboardReports.id, r.id));
      ran++;
    } catch (e) {
      await deps.db.update(dashboardReports).set({ lastError: "The last send failed. It will try again at the next time." }).where(eq(dashboardReports.id, r.id));
      deps.reportError?.(e, { where: "dash_reports" });
    }
  }
  return { due: due.length, ran };
}

export async function sendReportNow(deps: Deps, actor: SuiteActor, id: string) {
  const r = await reportRow(deps, actor, id);
  const res = await sendReport(deps, r);
  await deps.db.update(dashboardReports).set({ lastRunAt: deps.now(), lastError: res.error }).where(eq(dashboardReports.id, r.id));
  if (res.error) throw new HttpError(422, "report_failed", res.error);
  return { sent: res.sent };
}

/** For the report PDF route: the dashboard behind a link, as a PDF. */
export async function pdfForDashboard(d: PublicDashboard) {
  return reportPdf(d, when(Date.parse(d.updatedAt), d.timeZone));
}

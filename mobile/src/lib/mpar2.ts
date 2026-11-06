/**
 * MPAR2: pure helpers for the settings screens added in this round (account, plan and billing read only, Get started,
 * language). No React and no native modules here, so every piece is unit tested on its own.
 */
import { nativeRoute } from "./nav-menu";
import { LANG_LOCALE, tr, type UiLang } from "@/i18n";

/* ------------------------------------------------------------------ account */

/** GET /api/account/me as the account screen reads it (fields the server added after the first app release). */
export interface MeExtras { hasPassword?: boolean; user: { timezone?: string | null; locale?: string | null } }

/** A password sign in can change its password here; a Multies sign in (identity provider) has none. */
export const canChangePassword = (me: Partial<MeExtras> | null | undefined) => me?.hasPassword !== false;

export const MIN_PASSWORD = 10;
/** The reason a password form cannot be sent yet, or null when it can. */
export function passwordProblem(current: string, next: string): string | null {
  if (!current) return tr("m.account.enter_current_password");
  if (next.length < MIN_PASSWORD) return tr("settings.at_least_10_characters");
  if (next === current) return tr("m.account.pick_a_different_password");
  return null;
}
/** A name the server takes: trimmed, 1 to 100 characters. */
export function cleanName(raw: string): string | null {
  const v = raw.replace(/\s+/g, " ").trim();
  return v.length >= 1 && v.length <= 100 ? v : null;
}
/** The locale tag saved on the web account for an app language (PATCH /api/account/preferences). */
export const accountLocale = (l: UiLang) => LANG_LOCALE[l];

/** The phone's own time zone, when the phone can tell. */
export function phoneTimeZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

/* ------------------------------------------------------------------ plan and billing (read only) */

export interface BillingView {
  enabled: boolean;
  plan: { id: string; name: string; legacy?: boolean };
  interval: "month" | "year" | null;
  subscription: { status: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  dunning: { pastDueSince: string; graceEndsAt: string | null; sendingPaused: boolean } | null;
  usage: { domains: number; mailboxes: number; seats: number; sendsToday: number; storageMb: number };
  limits: { domains: number; mailboxes: number; seats: number; dailySends: number; storageMb: number };
}
export interface UsageRow { id: string; label: string; used: number; max: number; text: string; ratio: number }

const gb = (mb: number) => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${Math.round(mb)} MB`);
const num = (n: number) => (Number.isFinite(n) && n >= 1e9 ? "\u221e" : String(n));

/** The usage meters the web's Plan and billing page shows, in its order. Unlimited reads as the infinity sign. */
export function usageRows(b: Pick<BillingView, "usage" | "limits">): UsageRow[] {
  const rows: { id: string; label: string; used: number; max: number; show?: (n: number) => string }[] = [
    { id: "domains", label: tr("m.billing.domains"), used: b.usage.domains, max: b.limits.domains },
    { id: "mailboxes", label: tr("m.billing.mailboxes"), used: b.usage.mailboxes, max: b.limits.mailboxes },
    { id: "seats", label: tr("m.billing.people"), used: b.usage.seats, max: b.limits.seats },
    { id: "storage", label: tr("m.billing.storage"), used: b.usage.storageMb, max: b.limits.storageMb, show: gb },
    { id: "sends", label: tr("m.billing.sent_today"), used: b.usage.sendsToday, max: b.limits.dailySends },
  ];
  return rows.filter((r) => Number.isFinite(r.used) && Number.isFinite(r.max) && r.max > 0).map((r) => {
    const show = r.show ?? num;
    return { id: r.id, label: r.label, used: r.used, max: r.max, ratio: Math.max(0, Math.min(1, r.used / r.max)), text: tr("m.billing.used_of_max", { used: show(r.used), max: show(r.max) }) };
  });
}

/** One plain line about the subscription: renews, ends, payment problem, or free. */
export function planStatusLine(b: Pick<BillingView, "plan" | "subscription" | "dunning" | "interval">, locale: string): { text: string; tone: "ok" | "warn" | "bad" | "neutral" } {
  const date = (iso: string | null | undefined) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" }); } catch { return iso.slice(0, 10); }
  };
  if (b.dunning) return { text: b.dunning.sendingPaused ? tr("m.billing.payment_failed_sending_paused") : tr("m.billing.payment_failed"), tone: "bad" };
  const s = b.subscription;
  if (!s || !s.status || s.status === "canceled") return { text: b.plan.id === "free" ? tr("m.billing.free_plan_no_card") : tr("m.billing.no_active_subscription"), tone: "neutral" };
  if (s.cancelAtPeriodEnd) return { text: tr("m.billing.ends_on", { date: date(s.currentPeriodEnd) }), tone: "warn" };
  if (s.status === "past_due" || s.status === "unpaid") return { text: tr("m.billing.payment_failed"), tone: "bad" };
  if (s.status === "trialing") return { text: tr("m.billing.trial_until", { date: date(s.currentPeriodEnd) }), tone: "ok" };
  return { text: s.currentPeriodEnd ? tr(b.interval === "year" ? "m.billing.renews_yearly_on" : "m.billing.renews_monthly_on", { date: date(s.currentPeriodEnd) }) : tr("m.billing.active"), tone: "ok" };
}

/* ------------------------------------------------------------------ Get started */

export type StepId = "mail" | "invite" | "task" | "site" | "palette" | "tour" | "open_mail" | "doc";
export interface ChecklistStep { id: StepId | string; kind: "data" | "mark"; title: string; body: string; to?: string; action?: "palette" | "tour"; done: boolean }
export interface Checklist { steps: ChecklistStep[]; doneCount: number; total: number; complete: boolean; dismissed: boolean; celebrated: boolean }
export interface ToursMe { enabled: boolean; checklist: Checklist | null }

/** Shown on Today and in Settings while it is on, not hidden and not finished and celebrated (the web's rule). */
export const checklistVisible = (c: Checklist | null | undefined) => !!c && !c.dismissed && (!c.complete || !c.celebrated);

/** A step's title and line in the language on screen (the server sends English; unknown steps keep its words). */
export function stepText(s: Pick<ChecklistStep, "id" | "title" | "body">): { title: string; body: string } {
  const known = ["mail", "invite", "task", "site", "palette", "tour", "open_mail", "doc"];
  if (!known.includes(String(s.id))) return { title: s.title, body: s.body };
  return { title: tr(`m.started.${s.id}_title`), body: tr(`m.started.${s.id}_body`) };
}

/** Where a step goes on the phone: an app screen when there is one, the command sheet for Ctrl K, else the web page. */
export type StepTarget = { kind: "screen"; href: string } | { kind: "command" } | { kind: "web"; path: string };
export function stepTarget(s: Pick<ChecklistStep, "to" | "action">, opts: { tasks: boolean } = { tasks: true }): StepTarget {
  if (s.action === "palette") return { kind: "command" };
  if (s.action === "tour") return { kind: "web", path: "/app" };
  const to = s.to || "/app";
  const native = nativeRoute(to, opts);
  return native ? { kind: "screen", href: native } : { kind: "web", path: to };
}
/** Steps the person ticks by doing them on the phone (the server ticks data steps itself). */
export const markOnOpen = (s: Pick<ChecklistStep, "id" | "kind">) => s.kind === "mark" && (s.id === "palette" || s.id === "open_mail" || s.id === "tour");

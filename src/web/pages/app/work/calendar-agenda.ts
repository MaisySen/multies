/**
 * R48 mobile web: the phone agenda for the task calendar. A month grid at 360 px leaves each day about 46 px wide and
 * every title cut to a few letters, so phones get a list by day instead: Overdue first, then Today, Tomorrow and each
 * later day that has something due, up to `days` ahead. Pure, so it is unit tested without a browser.
 */
import { formatDateIn } from "@/web/i18n/intl";
import { tr, uiLocale } from "@/web/i18n"; // POL4 (HQ MB-356)

export type AgendaTask = { id: string; due: string | null; start: string | null; status: string };
export type AgendaDay<T> = { key: string; label: string; overdue?: boolean; items: T[] };

const DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** YYYY-MM-DD of a local date. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "Today", "Tomorrow", or "Wed 29 Oct". */
export function dayLabel(key: string, todayKey: string): string {
  const diff = Math.round((fromKey(key).getTime() - fromKey(todayKey).getTime()) / DAY);
  // POL4 (HQ MB-356): Nepali or Hindi words and dates while the app shows one; English exactly as before otherwise.
  const ui = uiLocale();
  if (diff === 0) return ui ? tr("myday.today") : "Today";
  if (diff === 1) return ui ? tr("calendar.tomorrow") : "Tomorrow";
  const d = fromKey(key);
  if (ui) return formatDateIn(d, ui, { weekday: "short", day: "numeric", month: "short" });
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function agendaDays<T extends AgendaTask>(tasks: T[], today: Date, days = 60): AgendaDay<T>[] {
  const todayKey = dayKey(today);
  const lastKey = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));
  const overdue: T[] = [];
  const byDay = new Map<string, T[]>();
  for (const t of tasks) {
    const when = (t.due ?? t.start)?.slice(0, 10);
    if (!when) continue;
    if (when < todayKey) {
      // Done work in the past is history, not something to chase.
      if (t.status !== "done" && t.status !== "cancelled") overdue.push(t);
      continue;
    }
    if (when > lastKey) continue;
    const list = byDay.get(when);
    if (list) list.push(t); else byDay.set(when, [t]);
  }
  const out: AgendaDay<T>[] = [];
  if (overdue.length) out.push({ key: "overdue", label: uiLocale() ? tr("mywork.overdue") : "Overdue", overdue: true, items: overdue.sort((a, b) => ((a.due ?? a.start)! < (b.due ?? b.start)! ? -1 : 1)) });
  if (!byDay.has(todayKey)) out.push({ key: todayKey, label: uiLocale() ? tr("myday.today") : "Today", items: [] });
  for (const key of [...byDay.keys()].sort()) out.push({ key, label: dayLabel(key, todayKey), items: byDay.get(key)! });
  return out.sort((a, b) => (a.key === "overdue" ? -1 : b.key === "overdue" ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

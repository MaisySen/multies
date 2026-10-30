/**
 * R67 (MB-250): dates are typed and shown in the workspace's order (dd/mm/yyyy in Australia), not the browser's.
 * Values stay ISO (yyyy-mm-dd), exactly what a native date input gives, so callers do not change.
 */
import { LOCALE } from "@/shared/locale";

export type DateOrder = "dmy" | "mdy" | "ymd";
let displayLocale = LOCALE;

/** The locale dates follow: the person's language with the workspace's country ("en" + "AU" is "en-AU"). */
export function setDisplayLocale(language: string | null | undefined, country: string | null | undefined) {
  const lang = (language ?? "").split("-")[0] || "en";
  const region = country && /^[A-Z]{2}$/.test(country) ? country : (language ?? "").split("-").find((p, i) => i > 0 && /^[A-Z]{2}$/.test(p));
  const tag = region ? `${lang}-${region}` : LOCALE;
  try { displayLocale = Intl.getCanonicalLocales(tag)[0] ?? LOCALE; } catch { displayLocale = LOCALE; }
}
export const dateLocale = () => displayLocale;

export function dateOrder(locale = displayLocale): DateOrder {
  try {
    const parts = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).formatToParts(new Date(Date.UTC(2026, 10, 23)));
    const seq = parts.filter((p) => p.type === "day" || p.type === "month" || p.type === "year").map((p) => p.type[0]).join("");
    return seq === "mdy" ? "mdy" : seq === "ymd" ? "ymd" : "dmy";
  } catch { return "dmy"; }
}

/** "dd/mm/yyyy" style hint for the placeholder. */
export function datePattern(order: DateOrder = dateOrder()): string {
  return order === "mdy" ? "mm/dd/yyyy" : order === "ymd" ? "yyyy/mm/dd" : "dd/mm/yyyy";
}

const pad = (n: number) => String(n).padStart(2, "0");
const valid = (y: number, m: number, d: number) => {
  if (!(y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/** ISO yyyy-mm-dd to what the field shows ("23/11/2026"); "" stays "". */
export function formatDateValue(iso: string | null | undefined, order: DateOrder = dateOrder()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return "";
  const [, y, mo, d] = m;
  return order === "mdy" ? `${mo}/${d}/${y}` : order === "ymd" ? `${y}/${mo}/${d}` : `${d}/${mo}/${y}`;
}

/** What a person typed to ISO, or null while it is not a whole date. Takes / . - or spaces; an ISO date always works. */
export function parseDateValue(text: string, order: DateOrder = dateOrder()): string | null {
  const s = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y: number, m: number, d: number;
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else {
    const parts = s.split(/[/.\-\s]+/).filter(Boolean);
    if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
    const [a, b, c] = parts.map(Number);
    if (order === "ymd") { y = a; m = b; d = c; } else if (order === "mdy") { m = a; d = b; y = c; } else { d = a; m = b; y = c; }
    const yearText = order === "ymd" ? parts[0] : parts[2];
    if (yearText.length === 2) y += 2000; else if (yearText.length !== 4) return null;
  }
  return valid(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

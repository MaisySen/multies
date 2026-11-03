/**
 * DESF1: counts read the way the person's locale writes numbers ("15,536" in English, "15.536" in German), and nav
 * badges stop at "99+" so a pill never grows wider than its slot.
 */
import { uiLocale } from "@/web/i18n"; // R104
const cache = new Map<string, Intl.NumberFormat>();

function userLocale(): string | undefined {
  const ui = uiLocale(); // R104: Nepali or Hindi while the app shows one (their own digits and grouping)
  if (ui) return ui;
  try { return typeof navigator !== "undefined" ? (navigator.languages?.[0] ?? navigator.language) || undefined : undefined; } catch { return undefined; }
}

function formatter(locale?: string): Intl.NumberFormat {
  const key = locale ?? "";
  let f = cache.get(key);
  if (!f) {
    try { f = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }); } catch { f = new Intl.NumberFormat("en", { maximumFractionDigits: 0 }); }
    cache.set(key, f);
  }
  return f;
}

/** A whole count with locale grouping: 15536 reads "15,536" (en). Non finite values read "0". */
export function formatCount(n: number, locale: string | undefined = userLocale()): string {
  return formatter(locale).format(Number.isFinite(n) ? Math.round(n) : 0);
}

/** A nav badge: the count with grouping up to the cap, then "99+". */
export function badgeCount(n: number, cap = 99, locale: string | undefined = userLocale()): string {
  return n > cap ? `${formatCount(cap, locale)}+` : formatCount(n, locale);
}

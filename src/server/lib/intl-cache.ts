/**
 * R25 API speed: one Intl.DateTimeFormat per (locale, options) for the life of the isolate.
 * Building a formatter costs tens of microseconds; My Work, sprint burndowns and dashboard widgets
 * used to build one per task or per day, which was most of their time on a big workspace.
 * Formatters are immutable, so sharing them is safe. Bounded so odd zones from query strings
 * can't grow it forever.
 */
const cache = new Map<string, Intl.DateTimeFormat>();
const MAX = 500;

export function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options); // throws RangeError for an unknown zone, like before
    if (cache.size >= MAX) cache.clear();
    cache.set(key, f);
  }
  return f;
}

/** The calendar day (YYYY-MM-DD) of a moment in a time zone. */
export function dayInZone(d: Date, timeZone: string) {
  return dateFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Test hook: how many formatters are held. */
export function intlCacheSize() { return cache.size; }

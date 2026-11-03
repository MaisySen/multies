/**
 * R104 (LANG_R104): dates and numbers for Nepali where the browser has no Nepali locale data. Some browsers (Chrome
 * among them) ship Intl without "ne"; asking for ne-NP there quietly gives English. This keeps Nepali correct anyway:
 * numbers use Devanagari digits with the lakh grouping Nepal uses, and dates take the browser's own parts with Nepali
 * month and weekday names and digits put in. Where the browser has Nepali, its own formats are used unchanged.
 */
const NE_MONTHS = ["जनवरी", "फेब्रुअरी", "मार्च", "अप्रिल", "मे", "जुन", "जुलाई", "अगस्ट", "सेप्टेम्बर", "अक्टोबर", "नोभेम्बर", "डिसेम्बर"];
const NE_DAYS = ["आइतबार", "सोमबार", "मङ्गलबार", "बुधबार", "बिहिबार", "शुक्रबार", "शनिबार"];
const NE_DAYS_SHORT = ["आइत", "सोम", "मङ्गल", "बुध", "बिहि", "शुक्र", "शनि"];
const EN_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEVA = "०१२३४५६७८९";

const known = new Map<string, boolean>();
/** Whether this browser has its own date data for a locale. */
export function hasLocale(tag: string, force?: boolean): boolean {
  if (force !== undefined) return force;
  let v = known.get(tag);
  if (v === undefined) {
    try { v = Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0 && new Intl.DateTimeFormat(tag).resolvedOptions().locale.split("-")[0] === tag.split("-")[0]; } catch { v = false; }
    known.set(tag, v);
  }
  return v;
}

export const devaDigits = (s: string) => s.replace(/[0-9]/g, (d) => DEVA[Number(d)]);

/** The locale numbers use: Nepali with its own data, else Devanagari digits with lakh grouping (the same digits Nepal writes). */
export function numberLocale(locale: string, native?: boolean): string {
  return locale.startsWith("ne") && !hasLocale(locale, native) ? "hi-IN-u-nu-deva" : locale;
}

/** A date, a time or both, in a locale; Nepali gets Nepali names and digits even without the browser's Nepali data. */
export function formatDateIn(d: Date, locale: string, opts: Intl.DateTimeFormatOptions, native?: boolean): string {
  if (!locale.startsWith("ne") || hasLocale(locale, native)) return new Intl.DateTimeFormat(locale, opts).format(d);
  const o: Intl.DateTimeFormatOptions = { ...opts, hourCycle: opts.hour ? "h23" : undefined, hour12: undefined };
  const parts = new Intl.DateTimeFormat("en-GB", o).formatToParts(d);
  const month = Number(new Intl.DateTimeFormat("en-US", { month: "numeric", timeZone: opts.timeZone }).format(d)) - 1;
  const day = EN_DAYS.indexOf(new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: opts.timeZone }).format(d));
  return parts.map((p) => {
    if (p.type === "month" && !/^\d+$/.test(p.value)) return NE_MONTHS[month] ?? p.value;
    if (p.type === "weekday") return (opts.weekday === "long" ? NE_DAYS : NE_DAYS_SHORT)[day] ?? p.value;
    if (p.type === "literal") return p.value.replace(/,/g, "");
    if (p.type === "timeZoneName") return p.value;
    return devaDigits(p.value);
  }).join("").replace(/\s+/g, " ").trim();
}

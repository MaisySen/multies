/**
 * VTIMEZONE (RFC 5545 section 3.6.5) for an IANA zone, written by hand from the runtime's own
 * time zone data (Intl). Older Outlook versions refuse an event whose TZID has no VTIMEZONE.
 * A zone with daylight saving gets a STANDARD and a DAYLIGHT part with a yearly rule ("first
 * Sunday of October"); a zone without one gets a single STANDARD part.
 */

const MIN = 60_000;
const DAY = 86_400_000;
const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");

/** Minutes the zone is ahead of UTC at an instant. */
const formats = new Map<string, Intl.DateTimeFormat>();
function formatFor(tz: string) {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (formats.size > 50) formats.clear();
    formats.set(tz, f);
  }
  return f;
}

export function zoneOffsetMin(at: Date, tz: string) {
  const p = Object.fromEntries(formatFor(tz).formatToParts(at).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / MIN);
}

export interface Transition { at: Date; from: number; to: number }

/**
 * Offset changes in a calendar year (UTC), found by a weekly scan and a binary search to the
 * minute (about 80 lookups, cheap enough for the Workers CPU limit). Zones change at most twice
 * a year and never twice in one week.
 */
export function transitionsInYear(year: number, tz: string): Transition[] {
  const out: Transition[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  let t = Date.UTC(year, 0, 1);
  let off = zoneOffsetMin(new Date(t), tz);
  for (; t < end; t += 7 * DAY) {
    const next = Math.min(t + 7 * DAY, end);
    const o = zoneOffsetMin(new Date(next), tz);
    if (o === off) continue;
    let lo = t, hi = next;
    while (hi - lo > MIN) {
      const mid = lo + Math.floor((hi - lo) / 2 / MIN) * MIN;
      if (mid === lo) break;
      if (zoneOffsetMin(new Date(mid), tz) === off) lo = mid; else hi = mid;
    }
    out.push({ at: new Date(hi), from: off, to: o });
    off = o;
  }
  return out;
}

const offsetText = (min: number) => `${min < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(min) / 60))}${pad(Math.abs(min) % 60)}`;
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function observance(tr: Transition) {
  // DTSTART is the wall clock time just before the change, in the old offset.
  const local = new Date(tr.at.getTime() + tr.from * MIN);
  const y = local.getUTCFullYear(), m = local.getUTCMonth() + 1, d = local.getUTCDate();
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const nth = d + 7 > dim ? -1 : Math.ceil(d / 7);
  const kind = tr.to > tr.from ? "DAYLIGHT" : "STANDARD";
  return [
    `BEGIN:${kind}`,
    `DTSTART:${y}${pad(m)}${pad(d)}T${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}00`,
    `TZOFFSETFROM:${offsetText(tr.from)}`, `TZOFFSETTO:${offsetText(tr.to)}`,
    `RRULE:FREQ=YEARLY;BYMONTH=${m};BYDAY=${nth}${BYDAY[local.getUTCDay()]}`,
    `END:${kind}`,
  ];
}

/**
 * The VTIMEZONE lines for `tz`, with rules taken from the year before `around` so every part
 * starts before the event. Returns no lines when the zone is unknown to the runtime.
 */
export function vtimezone(tz: string, around: Date): string[] {
  let trs: Transition[];
  try {
    trs = transitionsInYear(around.getUTCFullYear() - 1, tz);
  } catch {
    return [];
  }
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
  const daylight = trs.find((t) => t.to > t.from), standard = trs.find((t) => t.to < t.from);
  if (daylight && standard) {
    lines.push(...observance(standard), ...observance(daylight));
  } else {
    const off = zoneOffsetMin(around, tz);
    lines.push("BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${offsetText(off)}`, `TZOFFSETTO:${offsetText(off)}`, "END:STANDARD");
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

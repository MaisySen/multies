/**
 * R97 notification centre: the pure rules shared by the server, the web app and tests. Quiet hours, pause and the
 * digest clock all run in the person's own IANA time zone. No reads, no clock: callers pass `now`.
 */
import { z } from "zod";

export const DIGEST_FREQUENCIES = ["off", "daily", "weekly"] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];
export const PAUSE_PRESETS = ["1h", "3h", "tomorrow"] as const;
export type PausePreset = (typeof PAUSE_PRESETS)[number];
/** Categories that may break through quiet hours when the person allows it. */
export const URGENT_CATEGORIES: readonly string[] = ["mention", "approval"];
/** A digest lists at most this many items; the rest are counted. */
export const DIGEST_MAX_ITEMS = 30;
/** Morning a "tomorrow" pause ends at, local time. */
export const PAUSE_MORNING = "08:00";
export const DEFAULT_ZONE = "Australia/Sydney";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 22:00.");

export function isValidZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
const Zone = z.string().min(1).max(64).refine(isValidZone, "Unknown time zone.");

export const QuietHours = z.object({
  enabled: z.boolean(),
  start: HHMM,
  end: HHMM,
  /** Days (0 Sunday to 6 Saturday) on which a quiet period STARTS. */
  days: z.array(z.number().int().min(0).max(6)).max(7),
  /** Mentions and approvals still alert. */
  allowUrgent: z.boolean(),
});
export type QuietHours = z.infer<typeof QuietHours>;

export const Digest = z.object({
  frequency: z.enum(DIGEST_FREQUENCIES),
  time: HHMM,
  /** Weekly digests: 0 Sunday to 6 Saturday. */
  weekday: z.number().int().min(0).max(6),
});
export type Digest = z.infer<typeof Digest>;

export const Delivery = z.object({
  timezone: Zone,
  quiet: QuietHours,
  digest: Digest,
  /** ISO time; alerts wait until then. Null when not paused. */
  pausedUntil: z.string().datetime().nullable(),
  /** Phone and browser alerts for each new mail in mailboxes the person can open (on by default, as before R97). */
  newMail: z.boolean(),
});
export type Delivery = z.infer<typeof Delivery>;

export const DeliveryPatch = z.object({
  timezone: Zone.optional(),
  quiet: QuietHours.partial().optional(),
  digest: Digest.partial().optional(),
  pause: z.enum([...PAUSE_PRESETS, "resume"]).optional(),
  newMail: z.boolean().optional(),
}).strict();
export type DeliveryPatch = z.infer<typeof DeliveryPatch>;

export function defaultDelivery(timezone?: string | null): Delivery {
  return {
    timezone: timezone && isValidZone(timezone) ? timezone : DEFAULT_ZONE,
    quiet: { enabled: false, start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6], allowUrgent: true },
    digest: { frequency: "off", time: "08:00", weekday: 1 },
    pausedUntil: null,
    newMail: true,
  };
}

/** Reads a stored delivery JSON, keeping every valid field and filling the rest with defaults. Never throws. */
export function readDelivery(raw: string | null | undefined, profileZone?: string | null): Delivery {
  const d = defaultDelivery(profileZone);
  if (!raw) return d;
  let v: Record<string, unknown>;
  try { v = JSON.parse(raw) as Record<string, unknown>; } catch { return d; }
  if (!v || typeof v !== "object") return d;
  const tz = Zone.safeParse(v.timezone);
  const quiet = QuietHours.partial().safeParse(v.quiet ?? {});
  const digest = Digest.partial().safeParse(v.digest ?? {});
  const paused = typeof v.pausedUntil === "string" && !Number.isNaN(Date.parse(v.pausedUntil)) ? v.pausedUntil : null;
  return {
    timezone: tz.success ? tz.data : d.timezone,
    quiet: { ...d.quiet, ...(quiet.success ? quiet.data : {}) },
    digest: { ...d.digest, ...(digest.success ? digest.data : {}) },
    pausedUntil: paused,
    newMail: typeof v.newMail === "boolean" ? v.newMail : d.newMail,
  };
}

/** Local wall clock parts of an instant in a zone. */
export function localParts(now: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: WD.indexOf(p.weekday) };
}

const toMin = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

/** The UTC instant at which the local wall clock in `tz` reads y-m-d hh:mm (DST safe to the minute). */
export function zonedInstant(tz: string, y: number, m: number, d: number, hh: number, mm: number): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wall - seen;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/** True when quiet hours are on and `now` falls inside a quiet period (periods may cross midnight). */
export function inQuietHours(now: Date, d: Pick<Delivery, "timezone" | "quiet">): boolean {
  const q = d.quiet;
  if (!q.enabled || !q.days.length) return false;
  const s = toMin(q.start), e = toMin(q.end);
  if (s === e) return false;
  const p = localParts(now, d.timezone);
  const t = p.hour * 60 + p.minute;
  if (s < e) return q.days.includes(p.weekday) && t >= s && t < e;
  // Crosses midnight: the evening part belongs to today, the morning part to the period that began yesterday.
  if (t >= s) return q.days.includes(p.weekday);
  if (t < e) return q.days.includes((p.weekday + 6) % 7);
  return false;
}

export function isPaused(now: Date, d: Pick<Delivery, "pausedUntil">): boolean {
  return !!d.pausedUntil && Date.parse(d.pausedUntil) > now.getTime();
}

/** Whether a phone or browser alert (and an instant mail) for this category goes out now. */
export function alertAllowed(now: Date, d: Delivery, category: string): boolean {
  if (isPaused(now, d)) return false;
  if (inQuietHours(now, d)) return d.quiet.allowUrgent && URGENT_CATEGORIES.includes(category);
  return true;
}

/** When a pause preset ends. "tomorrow" ends at 08:00 local the next day. */
export function pauseUntil(now: Date, preset: PausePreset, tz: string): Date {
  if (preset === "1h") return new Date(now.getTime() + 3600_000);
  if (preset === "3h") return new Date(now.getTime() + 3 * 3600_000);
  const p = localParts(now, tz);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedInstant(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), toMin(PAUSE_MORNING) / 60, 0);
}

/** The next digest moment strictly after `now`, or null when digests are off. */
export function nextDigestAt(now: Date, d: Pick<Delivery, "timezone" | "digest">): Date | null {
  const g = d.digest;
  if (g.frequency === "off") return null;
  const p = localParts(now, d.timezone);
  const hh = toMin(g.time) / 60 | 0, mm = toMin(g.time) % 60;
  for (let add = 0; add <= 8; add++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + add));
    if (g.frequency === "weekly" && day.getUTCDay() !== g.weekday) continue;
    const at = zonedInstant(d.timezone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm);
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

/** Applies a patch to stored delivery settings. Pure: `now` is passed in. */
export function applyDeliveryPatch(cur: Delivery, patch: DeliveryPatch, now: Date): Delivery {
  const out: Delivery = { ...cur, quiet: { ...cur.quiet, ...(patch.quiet ?? {}) }, digest: { ...cur.digest, ...(patch.digest ?? {}) } };
  if (patch.timezone) out.timezone = patch.timezone;
  if (patch.newMail !== undefined) out.newMail = patch.newMail;
  if (patch.quiet?.days) out.quiet.days = [...new Set(patch.quiet.days)].sort();
  if (patch.pause === "resume") out.pausedUntil = null;
  else if (patch.pause) out.pausedUntil = pauseUntil(now, patch.pause, out.timezone).toISOString();
  if (out.pausedUntil && Date.parse(out.pausedUntil) <= now.getTime()) out.pausedUntil = null;
  return out;
}

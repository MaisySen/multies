/**
 * Pure decisions for over the air updates (docs/OTA.md, "How phones take an update"). No React, no
 * native calls, so every rule here is unit tested. src/lib/ota/use-ota.ts does the calls.
 */

export type OsName = "ios" | "android";

export type MinSupported = { build: number | null; version: string | null };

/** What the server says at GET /api/v1/app-config (camel cased by parseAppConfig). */
export type MobileConfig = {
  minSupported: Record<OsName, MinSupported>;
  storeUrl: Record<OsName, string | null>;
  ota: {
    /** Update ids (either platform) that phones apply at once instead of on the next cold start. */
    criticalUpdateIds: string[];
    /** Update ids that were rolled back: a phone still running one applies the next update at once. */
    blockedUpdateIds: string[];
    /** Least minutes between two background checks when the app comes back to the front. */
    checkIntervalMinutes: number;
    /** A downloaded update is applied on resume when the app was away at least this long; null never. */
    applyOnResumeAfterMinutes: number | null;
  };
  telemetry: { sentryDsn: string | null; sampleRate: number };
  /** Optional short line shown on the blocking update screen. */
  message: string | null;
};

export const DEFAULT_CONFIG: MobileConfig = {
  minSupported: { ios: { build: null, version: null }, android: { build: null, version: null } },
  storeUrl: { ios: null, android: null },
  ota: { criticalUpdateIds: [], blockedUpdateIds: [], checkIntervalMinutes: 30, applyOnResumeAfterMinutes: 240 },
  telemetry: { sentryDsn: null, sampleRate: 1 },
  message: null,
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 200) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Read the server's JSON defensively: anything missing or malformed falls back to the safe default (never blocks). */
export function parseAppConfig(json: unknown): MobileConfig {
  const root = obj(json);
  const m = obj(root.mobile ?? root);
  const min = obj(m.min_supported);
  const store = obj(m.store_url);
  const ota = obj(m.ota);
  const tel = obj(m.telemetry);
  const minFor = (os: OsName): MinSupported => {
    const o = obj(min[os]);
    return { build: num(o.build), version: str(o.version) };
  };
  const interval = num(ota.check_interval_minutes);
  const resume = ota.apply_on_resume_after_minutes === null ? null : num(ota.apply_on_resume_after_minutes);
  const rate = typeof tel.sample_rate === "number" && tel.sample_rate >= 0 && tel.sample_rate <= 1 ? tel.sample_rate : 1;
  return {
    minSupported: { ios: minFor("ios"), android: minFor("android") },
    storeUrl: { ios: safeStoreUrl(store.ios), android: safeStoreUrl(store.android) },
    ota: {
      criticalUpdateIds: ids(ota.critical_update_ids),
      blockedUpdateIds: ids(ota.blocked_update_ids),
      checkIntervalMinutes: interval !== null ? Math.min(Math.max(interval, 5), 24 * 60) : DEFAULT_CONFIG.ota.checkIntervalMinutes,
      applyOnResumeAfterMinutes: resume === null ? (ota.apply_on_resume_after_minutes === null ? null : DEFAULT_CONFIG.ota.applyOnResumeAfterMinutes) : Math.max(resume, 15),
    },
    telemetry: { sentryDsn: safeDsn(tel.sentry_dsn), sampleRate: rate },
    message: str(m.message)?.slice(0, 200) ?? null,
  };
}

/** Only the two stores' own https pages may be opened from the blocking screen. */
export function safeStoreUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return /^https:\/\/(apps\.apple\.com|itunes\.apple\.com|play\.google\.com)\//.test(s) ? s : null;
}

export function safeDsn(v: unknown): string | null {
  const s = str(v);
  return s && /^https:\/\/[0-9a-f]+@[a-z0-9.-]+\/\d+$/.test(s) ? s : null;
}

/** Compare dotted versions numerically: 1.9.10 > 1.9.9. Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Is this store build too old to keep running? The build number decides when both sides have one
 * (iOS build, Android versionCode); otherwise the store version. Unknown facts never block.
 */
export function needsStoreUpdate(native: { version: string | null; build: string | null }, min: MinSupported): boolean {
  const build = native.build && /^\d+$/.test(native.build) ? Number(native.build) : null;
  if (min.build !== null && build !== null) return build < min.build;
  if (min.version && native.version) return compareVersions(native.version, min.version) < 0;
  return false;
}

export type CheckReason = "launch" | "resume" | "manual";

/**
 * Throttle for update checks. A manual check always runs. A launch check runs unless one ran in the
 * last minute. A resume check runs only after the app was away 30 s or more and the last check is
 * older than the configured interval, so flipping between apps never floods the update server.
 */
export function shouldCheck(o: { reason: CheckReason; now: number; lastCheckAt: number | null; awayMs?: number; intervalMinutes: number }): boolean {
  if (o.reason === "manual") return true;
  const since = o.lastCheckAt === null ? Infinity : o.now - o.lastCheckAt;
  if (o.reason === "launch") return since >= 60_000;
  if ((o.awayMs ?? 0) < 30_000) return false;
  return since >= o.intervalMinutes * 60_000;
}

export type ApplyDecision = "none" | "now" | "next_launch";

/**
 * What to do with what the update server answered. Critical updates (listed by id in app-config)
 * and any update for a phone still running a rolled back update are applied at once; everything
 * else waits for the next cold start, the way expo-updates applies a downloaded update by default.
 */
export function decideApply(o: { available: boolean; newUpdateId: string | null; rollBackToEmbedded?: boolean; runningUpdateId: string | null; config: MobileConfig }): ApplyDecision {
  if (!o.available) return "none";
  if (o.newUpdateId && o.config.ota.criticalUpdateIds.includes(o.newUpdateId)) return "now";
  if (o.runningUpdateId && o.config.ota.blockedUpdateIds.includes(o.runningUpdateId)) return "now";
  return "next_launch";
}

/** A downloaded update waiting for the next start is applied on resume only after a long time away. */
export function applyPendingOnResume(o: { pending: boolean; awayMs: number; config: MobileConfig }): boolean {
  const after = o.config.ota.applyOnResumeAfterMinutes;
  return o.pending && after !== null && o.awayMs >= after * 60_000;
}

/** Show "What's new" once, the first time a newer JavaScript version runs; never on a fresh install. */
export function shouldShowWhatsNew(o: { jsVersion: string; lastSeenVersion: string | null; hasNotes: boolean }): boolean {
  if (!o.lastSeenVersion) return false;
  return o.hasNotes && compareVersions(o.jsVersion, o.lastSeenVersion) > 0;
}

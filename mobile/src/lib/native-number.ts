/**
 * Native modules built on the new Expo JSI layer hand 64 bit integers (Swift Int64 / UInt64) to JavaScript as
 * BigInt: expo-file-system's File.size and its upload progress (bytesSent, totalBytes) on iPhone. Math that mixes
 * a BigInt with a plain number throws ("Cannot convert 100 to BigInt", Sentry 30 Oct 2026, OTA 1.10.1), so every
 * size or byte count that comes from native code goes through here first.
 */
export function toNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
  return fallback;
}

/** A 0 to 1 fraction from two native byte counts, or null when the total is unknown. */
export function byteFraction(sent: unknown, total: unknown): number | null {
  const t = toNumber(total);
  if (!(t > 0)) return null;
  return Math.max(0, Math.min(1, toNumber(sent) / t));
}

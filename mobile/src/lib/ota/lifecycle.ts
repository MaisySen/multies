/**
 * What happened to updates since the last launch, worked out at startup from small markers in the
 * on-device store and expo-updates' own log (docs/OTA.md, "Health gating"):
 *   - applied: the first launch of a new update on this phone (once per update);
 *   - launch_crash: the last launch never reached "stable" (10 s up), so it died early, natively or in JS;
 *   - failed: expo-updates fell back to an older bundle (emergency launch) or logged a load error.
 */
import type { KV } from "@/lib/kv";
import type { Report } from "./telemetry";

export const STABLE_AFTER_MS = 10_000;
const MARKER = "ota:launch-marker";
const LAST_APPLIED = "ota:last-applied";
const LAST_LOG = "ota:last-log-at";

/** The parts of an expo-updates log entry we read (UpdatesLogEntry). */
export type LogEntry = { timestamp: number; message: string; code: string; level: string; updateId?: string | null };

/** Log codes that mean an update could not be used on this phone. */
export const FAILURE_CODES = ["UpdateFailedToLoad", "AssetsFailedToLoad", "JSRuntimeError", "UpdateCodeSigningError", "UpdateAssetsNotAvailable", "InitializationError"];

type Facts = { updateId: string | null; embedded: boolean; emergency: boolean; emergencyReason: string | null };

export async function launchReports(store: KV, f: Facts, logs: LogEntry[], now: number): Promise<Omit<Report, "at">[]> {
  const out: Omit<Report, "at">[] = [];
  const running = f.embedded ? null : f.updateId;
  try {
    const raw = await store.get(MARKER);
    const m = raw ? (JSON.parse(raw) as { updateId: string | null; at: number; stable: boolean }) : null;
    if (m && !m.stable) {
      out.push({ event: "launch_crash", updateId: m.updateId, message: `The app closed within ${STABLE_AFTER_MS / 1000} s of starting`, extra: { started_at: new Date(m.at).toISOString() } });
    }
    await store.set(MARKER, JSON.stringify({ updateId: running, at: now, stable: false }));

    if (running) {
      const last = await store.get(LAST_APPLIED);
      if (last !== running) {
        out.push({ event: "applied", updateId: running, message: "Update applied", extra: { previous_update_id: last ?? "embedded" } });
        await store.set(LAST_APPLIED, running);
      }
    } else {
      await store.set(LAST_APPLIED, "embedded");
    }

    if (f.emergency) {
      out.push({ event: "failed", updateId: null, message: "Update could not start; the app fell back to an earlier bundle", extra: { reason: f.emergencyReason ?? "unknown" } });
    }

    const lastLog = Number((await store.get(LAST_LOG)) ?? 0);
    let newest = lastLog;
    for (const e of logs) {
      if (e.timestamp <= lastLog) continue;
      newest = Math.max(newest, e.timestamp);
      if ((e.level === "error" || e.level === "fatal") && FAILURE_CODES.includes(e.code)) {
        out.push({ event: "failed", updateId: e.updateId ?? null, message: `Update error: ${e.code}`, extra: { detail: e.message.slice(0, 300) } });
      }
    }
    if (newest > lastLog) await store.set(LAST_LOG, String(newest));
  } catch {
    // The store is best effort; never block the launch on it.
  }
  // At most a few failures per launch so a noisy log cannot flood the queue.
  return out.slice(0, 6);
}

/** The app was started in the background and is now opened: watch the next 10 s as a launch. */
export async function armLaunch(store: KV, now: number): Promise<void> {
  try {
    const raw = await store.get(MARKER);
    if (!raw) return;
    const m = JSON.parse(raw);
    await store.set(MARKER, JSON.stringify({ ...m, at: now, stable: false }));
  } catch { /* best effort */ }
}

/** Called once the app has been up STABLE_AFTER_MS: this launch did not crash early. */
export async function markStable(store: KV): Promise<void> {
  try {
    const raw = await store.get(MARKER);
    if (!raw) return;
    const m = JSON.parse(raw);
    await store.set(MARKER, JSON.stringify({ ...m, stable: true }));
  } catch { /* best effort */ }
}

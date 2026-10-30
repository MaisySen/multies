/**
 * R32: web update prompt. The app reads /version.json when it starts (its own release), then again on
 * window focus and every 10 minutes while the tab is visible. A different release shows a quiet pill;
 * a critical one reloads on the next route change.
 */
import { noteOwnRelease } from "./page-load";

export interface VersionInfo { release: string; critical: boolean }
export const POLL_MS = 10 * 60_000;

/** What to do with a fresh reading: nothing, offer a reload, or reload on the next route change. */
export function compareRelease(own: string | null, latest: VersionInfo | null, dismissed: string | null): "none" | "prompt" | "critical" {
  if (!own || !latest?.release || latest.release === own) return "none";
  if (latest.critical) return "critical";
  return dismissed === latest.release ? "none" : "prompt";
}

export interface WatchDeps {
  fetchVersion: () => Promise<VersionInfo | null>;
  onChange: (state: "none" | "prompt" | "critical", latest: VersionInfo | null) => void;
  isHidden: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  onFocus: (fn: () => void) => () => void;
  dismissed: () => string | null;
}

/** Starts watching. Returns a stop function. Readings are skipped while the tab is hidden. */
export function watchRelease(d: WatchDeps) {
  let own: string | null = null;
  let stopped = false;
  const check = async () => {
    if (stopped || d.isHidden()) return;
    const v = await d.fetchVersion().catch(() => null);
    if (!v || stopped) return;
    if (!own) { own = v.release; noteOwnRelease(own); return; }
    d.onChange(compareRelease(own, v, d.dismissed()), v);
  };
  void check();
  const id = d.setInterval(() => void check(), POLL_MS);
  const offFocus = d.onFocus(() => void check());
  return () => { stopped = true; d.clearInterval(id); offFocus(); };
}

export const DISMISS_KEY = "multies.update.dismissed";

export async function fetchVersion(): Promise<VersionInfo | null> {
  const r = await fetch("/version.json", { cache: "no-store", credentials: "omit" });
  if (!r.ok) return null;
  const j = (await r.json()) as Partial<VersionInfo>;
  return typeof j.release === "string" ? { release: j.release, critical: !!j.critical } : null;
}

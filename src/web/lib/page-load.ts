/**
 * R73: page files that fail to load. Every lazily loaded page (components/lazy-page.tsx) goes through
 * loadPageModule: the file is tried twice (one quiet retry), a module that arrives without the page's export is a
 * load failure (never an undefined component), and only then does the app decide:
 *  - online and /version.json names a newer release than this build: one hard reload into it (loop guarded);
 *  - otherwise (offline, a flaky network, a reload already tried): a PageLoadError, which the page boundary shows as
 *    "Could not load this page" with Retry inside the app frame, and reports to Sentry as a warning.
 * A page whose own code throws while it runs is a real bug and is passed on untouched.
 */
import { isStaleChunkError } from "./stale-chunk";

declare const __WEB_RELEASE__: string | undefined;

/** This build's release, written in by the build (vite.config.ts); empty in tests and the dev server. */
export const BUILD_RELEASE: string = typeof __WEB_RELEASE__ === "string" ? __WEB_RELEASE__ : "";

export type PageLoadReason = "offline" | "network" | "missing";

export class PageLoadError extends Error {
  readonly reason: PageLoadReason;
  readonly page: string;
  constructor(page: string, reason: PageLoadReason, cause?: unknown) {
    super(reason === "missing" ? `Page code for ${page} loaded without its export` : `Could not load the page code for ${page} (${reason})`);
    this.name = "PageLoadError";
    this.page = page;
    this.reason = reason;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** By name as well as by class, so a copy of the class from another file still counts. */
export function isPageLoadError(err: unknown): err is PageLoadError {
  return err instanceof PageLoadError || (err instanceof Error && err.name === "PageLoadError");
}

/** A failure to fetch page code (or a page export that never arrived), as opposed to a bug in the page itself. */
export function isPageLoadFailure(err: unknown): boolean {
  return isPageLoadError(err) || isStaleChunkError(err);
}

export const RETRY_DELAY_MS = 700;
/** No second automatic reload within this long of the last one, whatever the reason. */
export const RELOAD_GAP_MS = 30_000;
/** No second automatic reload for the same release within this long (a stale cache that keeps the old files). */
export const SAME_RELEASE_GAP_MS = 10 * 60_000;
export const RELOAD_KEY = "multies:page-reload";

type Store = Pick<Storage, "getItem" | "setItem">;

export interface PageLoadDeps {
  wait: (ms: number) => Promise<void>;
  online: () => boolean;
  ownRelease: () => string | null;
  latestRelease: () => Promise<string | null>;
  storage: () => Store | null;
  now: () => number;
  reload: () => void;
}

/**
 * One automatic reload into `release`, unless one ran in the last 30 s or one already ran for this same release in the
 * last 10 minutes. Returns whether it reloaded.
 */
export function reloadIntoRelease(release: string, deps: Pick<PageLoadDeps, "storage" | "now" | "reload">): boolean {
  const now = deps.now();
  try {
    const s = deps.storage();
    const prev = JSON.parse(s?.getItem(RELOAD_KEY) ?? "null") as { release?: string; at?: number } | null;
    if (prev && typeof prev.at === "number") {
      if (now - prev.at < RELOAD_GAP_MS) return false;
      if (prev.release === release && now - prev.at < SAME_RELEASE_GAP_MS) return false;
    }
    s?.setItem(RELOAD_KEY, JSON.stringify({ release, at: now }));
  } catch {
    // Storage blocked: no guard is possible, so do not reload automatically at all.
    return false;
  }
  deps.reload();
  return true;
}

/** Whether a newer release than this build is live (false when offline, unknown, or the same). */
export async function newerRelease(deps: Pick<PageLoadDeps, "online" | "ownRelease" | "latestRelease">): Promise<string | null> {
  if (!deps.online()) return null;
  const own = deps.ownRelease();
  if (!own) return null;
  const latest = await deps.latestRelease().catch(() => null);
  return latest && latest !== own ? latest : null;
}

/**
 * Loads a page module and returns its named export. Retries once; never resolves to undefined. When a newer release
 * is live it reloads once and stays pending (the page keeps its loading state until the new build takes over).
 */
export async function loadPageModule<T>(load: () => Promise<unknown>, name: string, deps: PageLoadDeps = browserDeps): Promise<T> {
  let err: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await deps.wait(RETRY_DELAY_MS);
    try {
      const mod = (await load()) as Record<string, unknown> | null | undefined;
      const part = mod?.[name];
      if (part != null) return part as T;
      err = new PageLoadError(name, "missing");
    } catch (e) {
      err = e;
    }
  }
  if (!isPageLoadFailure(err)) throw err;
  const latest = await newerRelease(deps);
  if (latest && reloadIntoRelease(latest, deps)) return new Promise<T>(() => undefined);
  throw isPageLoadError(err) && err.reason === "missing" ? err : new PageLoadError(name, deps.online() ? "network" : "offline", err);
}

let ownSeen: string | null = null;
/** update-check.ts records the first release it reads, for builds without BUILD_RELEASE. */
export function noteOwnRelease(release: string | null): void { if (release && !ownSeen) ownSeen = release; }

async function fetchLatestRelease(): Promise<string | null> {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const t = setTimeout(() => ctl?.abort(), 4000);
  try {
    const r = await fetch("/version.json", { cache: "no-store", credentials: "omit", signal: ctl?.signal });
    if (!r.ok) return null;
    const j = (await r.json()) as { release?: unknown };
    return typeof j.release === "string" && j.release ? j.release : null;
  } finally {
    clearTimeout(t);
  }
}

export const browserDeps: PageLoadDeps = {
  wait: (ms) => new Promise((res) => setTimeout(res, ms)),
  online: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
  ownRelease: () => BUILD_RELEASE || ownSeen,
  latestRelease: fetchLatestRelease,
  storage: () => { try { return window.sessionStorage; } catch { return null; } },
  now: () => Date.now(),
  reload: () => window.location.reload(),
};

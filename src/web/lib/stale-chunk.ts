// After a release the previous build's hashed page files are gone, so a tab that was open across the
// release fails its next lazy page with "Failed to fetch dynamically imported module". Reload once to
// pick up the new build; a timestamp in sessionStorage stops a reload loop.
const KEY = "multies:stale-chunk-reload";
const WINDOW_MS = 30_000;

export function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk [\w-]+ failed|Unable to preload CSS/i.test(msg);
}

/** Reload once per 30 s window. Returns false when a reload was already tried (show the screen instead). */
export function reloadForNewVersion(storage: Pick<Storage, "getItem" | "setItem"> | null = safeSession(), now = Date.now(), reload = () => window.location.reload()): boolean {
  try {
    const last = Number(storage?.getItem(KEY) ?? 0);
    if (last && now - last < WINDOW_MS) return false;
    storage?.setItem(KEY, String(now));
  } catch { /* storage blocked: still reload once */ }
  reload();
  return true;
}

function safeSession(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

export function installStaleChunkRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewVersion()) event.preventDefault();
  });
}

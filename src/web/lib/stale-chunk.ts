// After a release the previous build's hashed page files are gone, and offline no page file loads at all; either way a
// lazy page fails with one of the browsers' messages below. R73: what happens next lives in lib/page-load.ts (one
// retry, a reload only when /version.json names a newer release, else the in frame "Could not load this page" note).
// R56b reloaded on every such failure, which offline landed on "Multies was updated" or the browser's offline page.

export function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk [\w-]+ failed|Unable to preload CSS/i.test(msg);
}

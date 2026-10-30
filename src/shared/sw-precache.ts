/**
 * R32: the files the service worker precaches, read from Vite's build manifest: the entry chunk, the
 * chunks it imports statically, their CSS and the fonts that CSS names. Lazy page chunks are cached on
 * first use instead, so the install stays small.
 */
export interface ManifestChunk { file: string; isEntry?: boolean; imports?: string[]; css?: string[]; assets?: string[] }

/**
 * R40 (MB-203): only the Latin subset of the interface font is precached. The other subsets and the code font
 * load on their own when a page uses those letters (unicode-range), and precaching all twelve made the worker's
 * install download about 300 KB on a slow phone right after the first page.
 */
export const isCoreFont = (file: string): boolean => /\.woff2$/.test(file) && /(^|\/)inter-latin-wght-normal/.test(file);

export function precacheList(manifest: Record<string, ManifestChunk>): string[] {
  const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry && (k === "index.html" || k.endsWith("main.tsx"))) ?? Object.keys(manifest).find((k) => manifest[k].isEntry);
  if (!entryKey) throw new Error("no entry in the build manifest");
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const c = manifest[key];
    if (!c) return;
    out.add(`/${c.file}`);
    for (const css of c.css ?? []) out.add(`/${css}`);
    for (const a of c.assets ?? []) if (/\.(svg|png)$/.test(a) || isCoreFont(a)) out.add(`/${a}`);
    for (const i of c.imports ?? []) walk(i);
  };
  walk(entryKey);
  return [...out].filter((f) => !f.endsWith(".map")).sort();
}

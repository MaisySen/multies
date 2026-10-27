/**
 * R32: the files the service worker precaches, read from Vite's build manifest: the entry chunk, the
 * chunks it imports statically, their CSS and the fonts that CSS names. Lazy page chunks are cached on
 * first use instead, so the install stays small.
 */
export interface ManifestChunk { file: string; isEntry?: boolean; imports?: string[]; css?: string[]; assets?: string[] }

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
    for (const a of c.assets ?? []) if (/\.(woff2|svg|png)$/.test(a)) out.add(`/${a}`);
    for (const i of c.imports ?? []) walk(i);
  };
  walk(entryKey);
  return [...out].filter((f) => !f.endsWith(".map")).sort();
}

/**
 * R74: the icon glyphs the first screens draw, found from the source at build time.
 *
 * R40 put every glyph in one "icons" file so a page never waits on dozens of tiny files. That file grew to about
 * 240 glyphs (39 KB gzip) and every first load paid for all of them. This walks the static imports (not the lazy
 * ones) from the entry, the app frame, My Work and the public home page, and returns the glyph files those use. The
 * build keeps those in "icons" and puts the rest in "icons-more", which only the pages that use them load.
 * Plain text scan: an import it cannot resolve is skipped, so at worst a glyph lands in "icons-more" (a little later,
 * never missing).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const EXTS = [".tsx", ".ts", "/index.tsx", "/index.ts"];
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\b)([^'";]*?)\s*from\s*["']([^"']+)["']/gms;
const ICON_NAME_RE = /\bIcon[A-Z][A-Za-z0-9]*\b/g;

function resolve(spec: string, fromFile: string, srcDir: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(srcDir, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  if (/\.(tsx?|mjs|js)$/.test(base) && existsSync(base)) return base;
  for (const e of EXTS) if (existsSync(base + e)) return base + e;
  return null;
}

/** Glyph names (IconInbox, ...) imported anywhere in the static graph of these roots. */
export function criticalIconNames(roots: string[], srcDir: string): Set<string> {
  const names = new Set<string>();
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const m of text.matchAll(IMPORT_RE)) {
      const [, what, spec] = m;
      if (/components\/ui\/icons?(\/|$)|\.\/icons?(\/|$)/.test(spec)) for (const n of what.match(ICON_NAME_RE) ?? []) names.add(n);
      const next = resolve(spec, file, srcDir);
      if (next && !/[\\/]components[\\/]ui[\\/]icons[\\/]/.test(next)) stack.push(next);
    }
  }
  return names;
}

/** The glyph files (absolute paths) that export any of these names. */
export function iconFilesFor(names: Set<string>, iconDir: string): Set<string> {
  const files = new Set<string>();
  for (const f of readdirSync(iconDir)) {
    if (!f.endsWith(".ts") || f === "index.ts") continue;
    const p = path.join(iconDir, f);
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/export const (Icon[A-Za-z0-9]+)/g)) if (names.has(m[1])) { files.add(p); break; }
  }
  return files;
}

/** The first screens' glyph files for this checkout. */
export function criticalIconFiles(root: string): Set<string> {
  const src = path.join(root, "src");
  const roots = ["web/main.tsx", "web/layouts/app.tsx", "web/pages/app/my-work.tsx", "web/pages/landing.tsx"].map((r) => path.join(src, r));
  return iconFilesFor(criticalIconNames(roots, src), path.join(src, "web/components/ui/icons"));
}

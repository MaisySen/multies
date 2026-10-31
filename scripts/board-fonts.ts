/**
 * R89: the whiteboard's hand drawn fonts, served from our own origin at /board-assets/fonts/ (the library would
 * otherwise fetch them from a public CDN). All families are copied, the CJK one included (it is split into small
 * files and a browser only fetches the parts a board's text needs). Copied after the build; in dev the files are
 * served from node_modules.
 *
 * The library also lists a public CDN copy after our own address for every font. The browser checks each listed
 * address against our Content Security Policy as soon as the font is added, so those CDN entries log a policy error
 * on every board even when our copy loads. The build removes that CDN entry from the library code (dropCdnFallback),
 * and fails loudly if the library changes so the entry can no longer be found.
 */
import { cpSync, existsSync, readdirSync, statSync, createReadStream } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const SKIP = new Set<string>();

/** The one place the library appends its CDN copy to a font's address list (0.18.x, built output). */
const CDN_PUSH = /return (\w+)\.push\(new URL\((\w+),(\w+)\.ASSETS_FALLBACK_URL\)\),\1\}/;

/** Returns the library code without the CDN entry, or null when the code that adds it is not where we expect. */
export function dropCdnFallback(code: string): string | null {
  if (!CDN_PUSH.test(code)) return null;
  return code.replace(CDN_PUSH, "return $1}");
}

export function fontsDir(root: string) {
  return path.join(root, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
}

export function boardFonts(): Plugin {
  let root = process.cwd();
  let outDir = "dist/web";
  return {
    name: "board-fonts",
    configResolved(c) { root = c.root; outDir = path.resolve(c.root, c.build.outDir); },
    transform(code, id) {
      if (!id.includes("@excalidraw/excalidraw") || !code.includes("ASSETS_FALLBACK_URL")) return null;
      const out = dropCdnFallback(code);
      if (out === null) this.error("board-fonts: the whiteboard library changed; its CDN font fallback could not be removed (see scripts/board-fonts.ts)");
      return { code: out, map: null };
    },
    configureServer(server) {
      server.middlewares.use("/board-assets/fonts/", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const file = path.join(fontsDir(root), rel);
        if (!file.startsWith(fontsDir(root)) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("content-type", "font/woff2");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const src = fontsDir(root);
      if (!existsSync(src)) { console.warn("board-fonts: drawing fonts not found, boards will use system fonts"); return; }
      for (const family of readdirSync(src)) {
        if (SKIP.has(family)) continue;
        cpSync(path.join(src, family), path.join(outDir, "board-assets", "fonts", family), { recursive: true });
      }
    },
  };
}

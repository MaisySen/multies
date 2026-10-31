/**
 * R89: the whiteboard's hand drawn fonts, served from our own origin at /board-assets/fonts/ (the library would
 * otherwise fetch them from a public CDN). The large CJK font is left out: those characters fall back to the
 * system font. Copied after the build; in dev the files are served from node_modules.
 */
import { cpSync, existsSync, readdirSync, statSync, createReadStream } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const SKIP = new Set(["Xiaolai"]);

export function fontsDir(root: string) {
  return path.join(root, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
}

export function boardFonts(): Plugin {
  let root = process.cwd();
  let outDir = "dist/web";
  return {
    name: "board-fonts",
    configResolved(c) { root = c.root; outDir = path.resolve(c.root, c.build.outDir); },
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

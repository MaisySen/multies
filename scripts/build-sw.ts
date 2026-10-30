/**
 * R32: writes dist/web/sw.js after `vite build` (runs before prerender-landing.ts deletes the manifest).
 * The worker precaches the app's entry files (JS, CSS, fonts) named in the build manifest; the cache
 * name is keyed by RELEASE when set, else by a hash of those file names, so each release gets fresh caches.
 * A failure leaves no sw.js: the app then simply runs without offline support.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { precacheList } from "../src/shared/sw-precache";

const out = path.resolve("dist/web");
const manifestFile = path.join(out, ".vite/manifest.json");
try {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const files = precacheList(manifest);
  const version = (process.env.RELEASE?.trim() || createHash("sha256").update(files.join("\n")).digest("hex")).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 24);
  await build({
    entryPoints: [path.resolve("src/web/sw/sw.ts")],
    outfile: path.join(out, "sw.js"),
    bundle: true, minify: true, format: "iife", target: "es2020", legalComments: "none",
    define: { __SW_VERSION__: JSON.stringify(version), __SW_PRECACHE__: JSON.stringify(files) },
  });
  console.log(`service worker → dist/web/sw.js (version ${version}, ${files.length} files precached)`);
} catch (err) {
  if (existsSync(path.join(out, "sw.js"))) rmSync(path.join(out, "sw.js"), { force: true });
  console.warn("[sw] service worker skipped:", (err as Error).message);
}

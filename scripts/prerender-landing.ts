/**
 * R30: build-time HTML, written beside the shell after `vite build` (npm run build:web).
 *  - dist/web/landing.html: the shell with the landing page already rendered inside #root, sent for "/".
 *  - dist/web/auth.html: the shell plus modulepreload links for the sign in page's code, sent for /login,
 *    /signup and the other auth pages, so that code downloads beside the app frame instead of after it.
 * The Node server and the Worker send each for its paths only; every other route keeps the plain shell.
 * A failure here leaves the plain shell in use, never a broken build: pages still render as before.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { chunkFiles, injectLanding, lowPriorityScripts, routeChunkMap, ROUTE_MODULES, withPreloads, withProvidersPreload } from "../src/shared/prerender-shell";

const out = path.resolve("dist/web");
const shell = readFileSync(path.join(out, "index.html"), "utf8");
try {
  const { renderLanding } = await import("../src/web/prerender");
  const html = lowPriorityScripts(injectLanding(shell, renderLanding()));
  writeFileSync(path.join(out, "landing.html"), html);
  console.log(`prerendered landing → dist/web/landing.html (${Math.round(html.length / 1024)} KB)`);
} catch (err) {
  rmSync(path.join(out, "landing.html"), { force: true });
  console.warn("[prerender] landing skipped, the plain shell serves /:", (err as Error).message);
}

const manifestFile = path.join(out, ".vite/manifest.json");
try {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const files = chunkFiles(manifest, "src/web/pages/auth.tsx");
  if (!files.length) throw new Error("no auth chunk in the manifest");
  writeFileSync(path.join(out, "auth.html"), withProvidersPreload(withPreloads(shell, files)));
  console.log(`sign in shell → dist/web/auth.html (${files.length} chunks preloaded)`);
  // R31: the files behind the likely next pages, for download only prefetch (lib/prefetch.ts reads it when idle).
  const routes = routeChunkMap(manifest, ROUTE_MODULES);
  writeFileSync(path.join(out, "route-chunks.json"), JSON.stringify(routes));
  console.log(`route chunks → dist/web/route-chunks.json (${Object.keys(routes).length} pages)`);
} catch (err) {
  rmSync(path.join(out, "auth.html"), { force: true });
  console.warn("[prerender] auth shell skipped, the plain shell serves sign in:", (err as Error).message);
} finally {
  // The manifest is a build input only; it is never served.
  if (existsSync(manifestFile)) rmSync(path.join(out, ".vite"), { recursive: true, force: true });
}

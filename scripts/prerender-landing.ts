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
import { chunkFiles, injectLanding, LOGIN_VARIANTS, loginVariantKey, lowPriorityScripts, routeChunkMap, ROUTE_MODULES, startCodeAfterPaint, withCriticalCss, withPreloads, withProvidersPreload, type LoginPrerender } from "../src/shared/prerender-shell";
import { criticalCss } from "./critical-css";

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
  // R34 (perf2): the sign in card for each deployment setup, with the CSS it needs inline (see prerender-shell.ts).
  try {
    const authShell = withProvidersPreload(withPreloads(shell, files));
    const { renderLoginCard } = await import("../src/web/prerender");
    const cards = Object.fromEntries(LOGIN_VARIANTS.map((v) => [loginVariantKey(v), renderLoginCard(v)]));
    const cssHref = shell.match(/<link rel="stylesheet" crossorigin href="\/([^"]+)">/)?.[1];
    if (!cssHref) throw new Error("no stylesheet in the shell");
    const css = criticalCss(readFileSync(path.join(out, cssHref), "utf8"), [authShell, ...Object.values(cards)]);
    // The card is the HTML, so its code starts once the card has painted: the card's CSS and the font go first.
    const login: LoginPrerender = { shell: withCriticalCss(startCodeAfterPaint(authShell), css), cards };
    writeFileSync(path.join(out, "auth-login.json"), JSON.stringify(login));
    console.log(`sign in card → dist/web/auth-login.json (${Object.keys(cards).length} variants, critical CSS ${Math.round(css.length / 1024)} KB)`);
  } catch (err) {
    rmSync(path.join(out, "auth-login.json"), { force: true });
    console.warn("[prerender] sign in card skipped, the sign in shell serves /login:", (err as Error).message);
  }
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

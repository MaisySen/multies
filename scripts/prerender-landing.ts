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
import { AUTH_CARD_ROUTES, chunkFiles, injectLanding, LOGIN_VARIANTS, loginVariantKey, lowPriorityScripts, routeChunkMap, ROUTE_MODULES, startCodeAfterPaint, withCriticalCss, withPreloads, withProvidersPreload, type LoginPrerender } from "../src/shared/prerender-shell";
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
    const { renderLoginCard, renderAuthCard, prerendersAuthCard } = await import("../src/web/prerender");
    const cards = Object.fromEntries(LOGIN_VARIANTS.map((v) => [loginVariantKey(v), renderLoginCard(v)]));
    // R35: sign up and forgot password the same way, per variant where the page needs nothing the build cannot know.
    const pages: NonNullable<LoginPrerender["pages"]> = {};
    for (const page of ["signup", "forgot"] as const) {
      try {
        pages[page] = Object.fromEntries(LOGIN_VARIANTS.filter((v) => prerendersAuthCard(page, v)).map((v) => [loginVariantKey(v), renderAuthCard(page, v)]));
      } catch (err) {
        console.warn(`[prerender] ${AUTH_CARD_ROUTES[page]} card skipped, the sign in shell serves it:`, (err as Error).message);
      }
    }
    const cssHref = shell.match(/<link rel="stylesheet" crossorigin href="\/([^"]+)">/)?.[1];
    if (!cssHref) throw new Error("no stylesheet in the shell");
    const allCards = [...Object.values(cards), ...Object.values(pages).flatMap((c) => Object.values(c ?? {}))];
    const css = criticalCss(readFileSync(path.join(out, cssHref), "utf8"), [authShell, ...allCards]);
    // The card is the HTML, so its code starts once the card has painted: the card's CSS and the font go first.
    const login: LoginPrerender = { shell: withCriticalCss(startCodeAfterPaint(authShell), css), cards, pages };
    writeFileSync(path.join(out, "auth-login.json"), JSON.stringify(login));
    console.log(`sign in cards → dist/web/auth-login.json (${Object.keys(cards).length} sign in, ${Object.keys(pages.signup ?? {}).length} sign up, ${Object.keys(pages.forgot ?? {}).length} forgot password variants, critical CSS ${Math.round(css.length / 1024)} KB)`);
  } catch (err) {
    rmSync(path.join(out, "auth-login.json"), { force: true });
    console.warn("[prerender] sign in card skipped, the sign in shell serves /login:", (err as Error).message);
  }
  // R31: the files behind the likely next pages, for download only prefetch (lib/prefetch.ts reads it when idle).
  const routes = routeChunkMap(manifest, ROUTE_MODULES);
  writeFileSync(path.join(out, "route-chunks.json"), JSON.stringify(routes));
  console.log(`route chunks → dist/web/route-chunks.json (${Object.keys(routes).length} pages)`);
  // R45 (MB-203): public/boot.js starts the app frame's code and My Work's code from the page itself, beside the entry,
  // instead of after the entry and React have downloaded and run (one whole step less in a row on a slow link).
  const frame = routeChunkMap(manifest, { frame: "src/web/layouts/app.tsx" }).frame ?? [];
  const bootPath = path.join(out, "boot.js");
  if (existsSync(bootPath)) {
    const boot = readFileSync(bootPath, "utf8");
    const map = { frame, "/app/my-work": routes["/app/my-work"] ?? [] };
    writeFileSync(bootPath, boot.replace("/*R45_CHUNKS*/null", JSON.stringify(map)));
    console.log(`boot preloads → dist/web/boot.js (frame ${frame.length} files, My Work ${map["/app/my-work"].length})`);
  }
} catch (err) {
  rmSync(path.join(out, "auth.html"), { force: true });
  console.warn("[prerender] auth shell skipped, the plain shell serves sign in:", (err as Error).message);
} finally {
  // The manifest is a build input only; it is never served.
  if (existsSync(manifestFile)) rmSync(path.join(out, ".vite"), { recursive: true, force: true });
}

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AUTH_SHELL_PATHS, EMPTY_ROOT, chunkFiles, injectLanding, lowPriorityScripts, shellFor, withPreloads } from "@/shared/prerender-shell";
import { authProvidersQuery, isAuthLayoutPath } from "@/web/lib/auth-providers";
import { renderLanding } from "@/web/prerender";
// @ts-expect-error a plain script with no type declarations
import { summarize } from "../scripts/lighthouse-r30.mjs";

/**
 * R30 web performance guards (Lighthouse mobile, median of 3: landing 89 to 92-93, sign in 73 to 89). Each test pins one win
 * so a later change cannot quietly undo it.
 */
const shell = `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-a.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-react-b.js"></head><body>${EMPTY_ROOT}</body></html>`;

describe("prerendered landing", () => {
  it("renders the real landing headline and footer legal line to HTML, with no data loaded", () => {
    const html = renderLanding();
    expect(html.length).toBeGreaterThan(5000);
    expect(html).toContain('id="main"');
    expect(html).toMatch(/Fintex Australia/);
    expect(html).not.toMatch(/undefined|NaN/);
  });

  it("puts the markup inside the empty root and refuses a shell without one", () => {
    const out = injectLanding(shell, "<p>Hello</p>");
    expect(out).toContain('<div id="root" data-prerendered="landing"><p>Hello</p></div>');
    expect(() => injectLanding("<body><div id=app></div></body>", "<p>x</p>")).toThrow(/empty #root/);
    expect(() => injectLanding(shell, "  ")).toThrow(/empty landing/);
  });

  it("fetches the app code at low priority on the prerendered page only", () => {
    const low = lowPriorityScripts(shell);
    expect(low).toContain('<script type="module" crossorigin fetchpriority="low" src="/assets/index-a.js">');
    expect(low).toContain('<link rel="modulepreload" crossorigin fetchpriority="low" href="/assets/vendor-react-b.js">');
    expect(shell).not.toContain("fetchpriority");
  });

  it("serves the prerendered page for / only, and the shell everywhere else or when none was built", () => {
    expect(shellFor("/", "SHELL", "LANDING")).toBe("LANDING");
    for (const p of ["/login", "/pricing", "/app", "/app/inbox", "//"]) expect(shellFor(p, "SHELL", "LANDING")).toBe("SHELL");
    expect(shellFor("/", "SHELL", "")).toBe("SHELL");
    expect(shellFor("/", "SHELL", null)).toBe("SHELL");
  });

  it("serves the sign in shell (its code preloaded) for the auth pages only", () => {
    for (const p of ["/login", "/signup", "/forgot-password", "/reset-password", "/email-verified", "/login/"]) {
      expect(AUTH_SHELL_PATHS.test(p)).toBe(true);
      expect(shellFor(p, "SHELL", "LANDING", "AUTH")).toBe("AUTH");
    }
    for (const p of ["/", "/loginx", "/app", "/pricing", "/login/extra"]) expect(shellFor(p, "SHELL", "LANDING", "AUTH")).not.toBe("AUTH");
    expect(shellFor("/login", "SHELL", "LANDING", "")).toBe("SHELL");
    expect(shellFor("/login", "SHELL", "LANDING")).toBe("SHELL");
  });

  it("collects a manifest entry's chunks with their static imports once, and adds only new preload links", () => {
    const manifest = {
      "src/web/pages/auth.tsx": { file: "assets/auth-1.js", imports: ["_input.js", "_auth-client.js", "src/web/main.tsx"] },
      "_input.js": { file: "assets/input-2.js", imports: ["_cn.js"] },
      "_auth-client.js": { file: "assets/auth-client-3.js", imports: ["_cn.js"] },
      "_cn.js": { file: "assets/cn-4.js" },
      "src/web/main.tsx": { file: "assets/index-a.js", imports: ["src/web/pages/auth.tsx"] },
    };
    const files = chunkFiles(manifest, "src/web/pages/auth.tsx");
    expect(files).toEqual(["assets/auth-1.js", "assets/input-2.js", "assets/cn-4.js", "assets/auth-client-3.js", "assets/index-a.js"]);
    expect(chunkFiles(manifest, "missing")).toEqual([]);
    const out = withPreloads(shell, files);
    expect(out).toContain('<link rel="modulepreload" crossorigin href="/assets/auth-1.js">');
    expect(out).toContain('<link rel="modulepreload" crossorigin href="/assets/cn-4.js">');
    // Already loaded by the shell: not preloaded twice.
    expect(out.match(/index-a\.js/g)).toHaveLength(1);
    expect(out.indexOf("auth-1.js")).toBeLessThan(out.indexOf("</head>"));
    expect(withPreloads(shell, ["assets/index-a.js"])).toBe(shell);
  });

  it("is wired into the web build, the Node server and the Worker", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    // R32: the service worker is built from the same manifest, between the bundle and the prerender.
    expect(pkg.scripts["build:web"]).toMatch(/vite build && (tsx scripts\/build-sw\.ts && )?tsx scripts\/prerender-landing\.ts/);
    expect(pkg.scripts["build:web"]).toContain("tsx scripts/build-sw.ts");
    expect(pkg.scripts["perf:lh"]).toBe("node scripts/lighthouse-r30.mjs");
    expect(readFileSync("src/entry/node.ts", "utf8")).toMatch(/landing\.html/);
    expect(readFileSync("src/entry/node.ts", "utf8")).toMatch(/auth\.html/);
    expect(readFileSync("src/entry/worker.ts", "utf8")).toMatch(/shellFor\(url\.pathname, __MYMAIL_SHELL_HTML__/);
    expect(readFileSync("src/entry/worker.ts", "utf8")).toMatch(/__MYMAIL_AUTH_HTML__/);
    expect(readFileSync("scripts/build-worker.ts", "utf8")).toMatch(/__MYMAIL_LANDING_HTML__: JSON\.stringify\(landingHtml\), __MYMAIL_AUTH_HTML__/);
    expect(readFileSync("vite.config.ts", "utf8")).toMatch(/manifest: true/);
  });
});

describe("sign in paints once (no layout shift)", () => {
  it("knows which pages sit under the auth layout", () => {
    for (const p of ["/login", "/signup", "/forgot-password", "/reset-password", "/email-verified", "/oauth/authorize", "/invite/abc"]) expect(isAuthLayoutPath(p)).toBe(true);
    for (const p of ["/", "/pricing", "/app", "/app/inbox", "/loginx", "/invite"]) expect(isAuthLayoutPath(p)).toBe(false);
    expect(authProvidersQuery.queryKey).toEqual(["auth-providers"]);
    expect(authProvidersQuery.staleTime).toBe(Infinity);
  });

  it("holds the logo and card together and starts the providers read at boot", () => {
    const layout = readFileSync("src/web/layouts/auth.tsx", "utf8");
    expect(layout).toMatch(/<Suspense fallback=\{hold\}>/);
    expect(layout).toMatch(/providers\.isPending \? hold/);
    expect(readFileSync("src/web/main.tsx", "utf8")).toMatch(/isAuthLayoutPath\(window\.location\.pathname\)\)\s*\{?\s*void queryClient\.prefetchQuery\(authProvidersQuery\)/);
    // The auth routes carry no Suspense of their own: an inner fallback would paint the logo early again.
    const router = readFileSync("src/web/router.tsx", "utf8");
    const auth = router.slice(router.indexOf("element: <AuthLayout />"), router.indexOf('path: "/app"'));
    expect(auth).not.toMatch(/publicPage\(|page\(/);
  });
});

describe("fonts never shift text or hold the first paint", () => {
  const css = readFileSync("src/web/fonts.css", "utf8");
  it("uses font-display optional on every face, and index.css loads it instead of the swap faces", () => {
    const faces = css.match(/@font-face/g) ?? [];
    expect(faces.length).toBeGreaterThanOrEqual(10);
    expect((css.match(/font-display: optional;/g) ?? []).length).toBe(faces.length);
    expect(css).not.toMatch(/font-display: swap/);
    const index = readFileSync("src/web/index.css", "utf8");
    expect(index).toContain('@import "./fonts.css"');
    expect(index).not.toMatch(/@import "@fontsource/);
  });
  it("names only font files that exist", () => {
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThanOrEqual(10);
    for (const u of urls) expect(existsSync(path.resolve("src/web", u)), u).toBe(true);
  });
});

it("loads the .at() polyfill deferred, still before the app module", () => {
  const html = readFileSync("index.html", "utf8");
  expect(html).toContain('<script src="/legacy.js" defer></script>');
  expect(html.indexOf("/legacy.js")).toBeLessThan(html.indexOf('type="module"'));
});

it("summarizes a Lighthouse report into the numbers the R30 table records", () => {
  const audit = (numericValue: number, score = 1) => ({ numericValue, score });
  const lhr = {
    categories: { performance: { id: "performance", score: 0.93, auditRefs: [{ id: "largest-contentful-paint", weight: 25 }] }, accessibility: { id: "accessibility", score: 1, auditRefs: [] }, "best-practices": { id: "best-practices", score: 1, auditRefs: [] }, seo: { id: "seo", score: 1, auditRefs: [] } },
    audits: {
      "first-contentful-paint": audit(900), "largest-contentful-paint": audit(1800, 0.8), "total-blocking-time": audit(120), "cumulative-layout-shift": audit(0.0123), "speed-index": audit(1100),
      "resource-summary": { details: { items: [{ resourceType: "script", transferSize: 166000 }, { resourceType: "total", transferSize: 300000 }] } },
    },
  };
  expect(summarize(lhr)).toEqual({ perf: 93, a11y: 100, bp: 100, seo: 100, fcp: 900, lcp: 1800, tbt: 120, cls: 0.012, si: 1100, jsKB: 162, totalKB: 293, failing: ["performance:largest-contentful-paint"] });
});

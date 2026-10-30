import { test, expect, type Page } from "@playwright/test";
import { PUBLIC_META, SITE_URL } from "../src/web/components/seo-meta";

/**
 * The website launch checklist, items 1 to 9, 11 and 20. Public pages only (no demo workspaces), so it
 * runs against production with E2E_BASE_URL as well as against the local server.
 */
const PAGES = ["/", "/pricing", "/agents", "/status", "/support", "/privacy", "/terms", "/acceptable-use", "/dpa", "/delete-account", "/login", "/signup"];

async function open(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: "networkidle" });
  expect(res?.status(), `${path} status`).toBe(200);
  await expect(page.locator("h1").first()).toBeVisible();
}
const metaContent = (page: Page, sel: string) => page.locator(sel).first().getAttribute("content");

test("1. unknown pages answer a real 404 with the styled not-found page", async ({ page }) => {
  const res = await page.goto("/no-such-page-launch-check");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This page bounced." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go home" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Multies" }).first()).toBeVisible();
});

test("2 and 3. every public page has its own title and a meta description", async ({ page }) => {
  const titles = new Map<string, string>();
  for (const p of PAGES) {
    await open(page, p);
    await expect.poll(() => page.title()).toContain("Multies");
    const title = await page.title();
    const description = (await metaContent(page, 'meta[name="description"]')) ?? "";
    expect(description.length, `${p} description`).toBeGreaterThan(40);
    expect(description, `${p} description`).toBe(PUBLIC_META[p].description);
    expect(titles.has(title), `${p} title "${title}" is also used by ${titles.get(title)}`).toBe(false);
    titles.set(title, p);
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(SITE_URL + (p === "/" ? "/" : p));
  }
  // The HTML shell carries a description and a title before any script runs.
  const html = await (await page.request.get("/")).text();
  expect(html).toMatch(/<title>[^<]{10,}<\/title>/);
  expect(html).toMatch(/<meta name="description" content="[^"]{40,}"/);
});

test("4. the call to action is above the fold on desktop and phone", async ({ browser }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 667 }]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await open(page, "/");
    const cta = page.getByTestId("hero-cta");
    await expect(cta).toBeVisible();
    const box = await cta.boundingBox();
    expect(box && box.y + box.height, `CTA bottom at ${viewport.width}px`).toBeLessThanOrEqual(viewport.height);
    await ctx.close();
  }
});

test("5. favicon set, touch icon and web manifest from the logo", async ({ page, request }) => {
  await open(page, "/");
  const hrefs = await page.locator('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")!));
  for (const want of ["/favicon.svg", "/favicon.ico", "/favicon-32.png", "/favicon-16.png", "/apple-touch-icon.png", "/site.webmanifest"]) expect(hrefs).toContain(want);
  for (const href of hrefs) {
    const r = await request.get(href);
    expect(r.status(), href).toBe(200);
    expect((await r.body()).length, href).toBeGreaterThan(100);
  }
  const svg = await (await request.get("/favicon.svg")).text();
  expect(svg).toContain("<svg");
  const manifest = await (await request.get("/site.webmanifest")).json();
  expect(manifest.name).toBe("Multies");
  const sizes = manifest.icons.map((i: { sizes: string; purpose?: string }) => `${i.sizes}${i.purpose ? ` ${i.purpose}` : ""}`);
  expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512", "512x512 maskable"]));
  for (const i of manifest.icons) expect((await request.get(i.src)).status(), i.src).toBe(200);
});

test("6. robots.txt keeps crawlers out of the app and the API", async ({ request }) => {
  const r = await request.get("/robots.txt");
  expect(r.status()).toBe(200);
  const body = await r.text();
  // Staging is a preview: it keeps every crawler out, so the read-only staging pass checks that instead.
  if (/staging/.test(process.env.E2E_BASE_URL ?? "")) {
    expect(body).toMatch(/^User-agent: \*$/m);
    expect(body).toMatch(/^Disallow: \/$/m);
    expect(body).not.toMatch(/^Allow: \/$/m);
    return;
  }
  expect(body).toMatch(/^Disallow: \/app$/m);
  expect(body).toMatch(/^Disallow: \/api$/m);
  expect(body).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
});

test("7. sitemap.xml lists the public pages and each one loads", async ({ request }) => {
  const r = await request.get("/sitemap.xml");
  expect(r.status()).toBe(200);
  const xml = await r.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(locs.length).toBeGreaterThanOrEqual(8);
  for (const p of ["/", "/pricing", "/privacy", "/terms", "/support"]) expect(locs).toContain(SITE_URL + p);
  for (const loc of locs) {
    expect(loc.startsWith(SITE_URL), loc).toBe(true);
    expect((await request.get(loc.slice(SITE_URL.length) || "/")).status(), loc).toBe(200);
  }
});

test("8. Open Graph image and social tags", async ({ page, request }) => {
  await open(page, "/pricing");
  expect(await metaContent(page, 'meta[property="og:title"]')).toBe(PUBLIC_META["/pricing"].title);
  expect(await metaContent(page, 'meta[property="og:description"]')).toBe(PUBLIC_META["/pricing"].description);
  expect(await metaContent(page, 'meta[property="og:url"]')).toBe(`${SITE_URL}/pricing`);
  expect(await metaContent(page, 'meta[name="twitter:card"]')).toBe("summary_large_image");
  const image = await metaContent(page, 'meta[property="og:image"]');
  expect(image).toBe(`${SITE_URL}/og-image.png`);
  const r = await request.get("/og-image.png");
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toContain("image/png");
  const png = await r.body();
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
});

test("9 and 20. images have alt text, modern formats, sizes and lazy loading below the fold", async ({ page }) => {
  for (const p of PAGES) {
    await open(page, p);
    const imgs = await page.locator("img").evaluateAll((els, fold) => els.map((el) => {
      const img = el as HTMLImageElement;
      return { src: img.currentSrc || img.src, alt: img.getAttribute("alt"), w: img.getAttribute("width"), h: img.getAttribute("height"), loading: img.getAttribute("loading"), below: img.getBoundingClientRect().top > fold };
    }), await page.evaluate(() => window.innerHeight));
    for (const i of imgs) {
      expect(i.alt, `${p}: alt on ${i.src}`).not.toBeNull();
      expect(i.src, `${p}: format of ${i.src}`).toMatch(/(\.svg|\.webp|\.avif)(\?|$)|^data:image\/(svg|webp|avif)/);
      expect(i.w && i.h, `${p}: width and height on ${i.src}`).toBeTruthy();
      if (i.below) expect(i.loading, `${p}: lazy ${i.src}`).toBe("lazy");
    }
    // Inline SVG that carries meaning is named; decorative SVG is hidden from assistive tech.
    const unnamed = await page.locator("svg:not([aria-hidden='true']):not([role='img'][aria-label])").evaluateAll((els) => els.filter((e) => !e.closest("[aria-hidden='true']") && !e.closest("button[aria-label], a[aria-label]")).length);
    expect(unnamed, `${p}: unnamed meaningful svg`).toBe(0);
  }
});

test("11. phones get a sticky call to action once the hero scrolls away", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await ctx.newPage();
  await open(page, "/");
  const sticky = page.getByTestId("sticky-cta");
  await expect(sticky).toHaveAttribute("aria-hidden", "true");
  await page.mouse.wheel(0, 1600);
  await expect(sticky).toHaveAttribute("aria-hidden", "false");
  await expect(sticky.getByRole("link", { name: "Start free" })).toBeInViewport();
  await ctx.close();
});

import { test, expect } from "@playwright/test";
import { SITE_URL } from "../src/web/components/seo-meta";

/**
 * R76: walks every page in sitemap.xml plus the footer's links, and fails on any page that does not answer 200, shows
 * the not-found page, carries a "not found" title, scrolls sideways at phone width, has a broken image or logs a
 * console error. /developers/mcp read "Page not found" in its title for five days (R36 to R76) with no test noticing.
 * Public pages only, so it also runs against staging and production with E2E_BASE_URL.
 */
const EXTRA = ["/developers", "/security", "/startups", "/delete-account"];

async function sitemapPaths(request: import("@playwright/test").APIRequestContext) {
  const xml = await (await request.get("/sitemap.xml")).text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].slice(SITE_URL.length) || "/");
  return [...new Set([...locs, ...EXTRA])];
}

test("every sitemap page loads with its own title and no errors, at 1280 and 390", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const paths = await sitemapPaths(request);
  expect(paths.length).toBeGreaterThan(20);
  expect(paths).toContain("/developers/mcp");
  const problems: string[] = [];
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem("multies.cookie-notice", "ok"); } catch { /* ignore */ } });
    for (const p of paths) {
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
      const res = await page.goto(p, { waitUntil: "networkidle" });
      if (res?.status() !== 200) problems.push(`${p} @${width}: status ${res?.status()}`);
      await expect(page.locator("h1").first()).toBeVisible();
      const title = await page.title();
      if (/not found/i.test(title)) problems.push(`${p} @${width}: title "${title}"`);
      if (await page.getByRole("heading", { name: "This page bounced." }).count()) problems.push(`${p} @${width}: not-found page`);
      const robots = await page.locator('meta[name="robots"]').getAttribute("content").catch(() => null);
      if (robots?.includes("noindex")) problems.push(`${p} @${width}: noindex`);
      const facts = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        broken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src),
      }));
      if (facts.overflow > 0) problems.push(`${p} @${width}: ${facts.overflow}px sideways scroll`);
      if (facts.broken.length) problems.push(`${p} @${width}: broken images ${facts.broken.join(", ")}`);
      if (errors.length) problems.push(`${p} @${width}: console ${errors.join(" | ")}`);
      await page.close();
    }
    await ctx.close();
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("every internal link on the public pages answers 200, and unknown pages a real 404", async ({ page, request }) => {
  test.setTimeout(120_000);
  const links = new Set<string>();
  for (const p of ["/", "/pricing", "/developers", "/developers/mcp", "/agents", "/trust"]) {
    await page.goto(p, { waitUntil: "networkidle" });
    for (const href of await page.locator("a[href^='/']").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""))) links.add(href.split("#")[0] || "/");
  }
  expect(links).toContain("/developers");
  const bad: string[] = [];
  for (const l of links) {
    if (l.startsWith("/app") || l.startsWith("/api/v1/mcp")) continue; // signed in pages and the MCP endpoint itself
    const r = await request.get(l, { maxRedirects: 0 });
    if (r.status() !== 200) bad.push(`${l}: ${r.status()}`);
  }
  expect(bad, bad.join("\n")).toEqual([]);
  for (const p of ["/developers/nope", "/blog", "/help"]) expect((await request.get(p)).status(), p).toBe(404);
});

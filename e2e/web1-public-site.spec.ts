import { readFileSync, mkdirSync } from "node:fs";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * WEB1: every public page is complete and current. Each sitemap page loads with one h1, its own meta and social tags
 * and the same page security policy; every internal link on it answers; external links are only the ones we expect;
 * the key pages pass axe at 390 and 1280 in light and dark; Get the app shows no dead store link and the beta stays
 * hidden; one public support address; the privacy policy has its new sections.
 */
const sitemap = readFileSync("public/sitemap.xml", "utf8");
const PAGES = [...sitemap.matchAll(/<loc>https:\/\/multies\.si([^<]*)<\/loc>/g)].map((m) => m[1] || "/").filter((p) => p !== "/signup" && p !== "/login");
const KEY = ["/", "/support", "/privacy", "/contact", "/delete-account", "/whats-new", "/pricing", "/switch/trello"];
const EXTERNAL_OK = /^(mailto:contact@fintex\.au|https:\/\/fintex\.au\/?|https:\/\/[a-z0-9]+\.ingest\.us\.sentry\.io\/?|https:\/\/testflight\.apple\.com\/join\/RncpPJ1t)$/; // PAR1: the iPhone beta
const SHOTS = process.env.WEB1_SHOTS;

test("WEB1 every sitemap page: one h1, meta, social tags, same policy, links answer", async ({ page, request }) => {
  test.setTimeout(300_000);
  let policy: string | null = null;
  const internal = new Set<string>();
  for (const path of PAGES) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    const csp = res?.headers()["content-security-policy"] ?? "";
    expect(csp, path).not.toMatch(/'unsafe-eval'/);
    policy ??= csp;
    expect(csp, `${path} policy differs from /`).toBe(policy);
    await expect(page.locator("h1"), path).toHaveCount(1);
    for (const sel of ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:image"]', 'link[rel="canonical"]']) {
      await expect(page.locator(sel), `${path} ${sel}`).toHaveCount(1);
    }
    await expect(page.locator("img:not([alt])"), path).toHaveCount(0);
    const hrefs = await page.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    for (const h of hrefs) {
      if (h.startsWith("#")) continue;
      if (h.startsWith("/")) internal.add(h.split("#")[0]);
      else if (!h.startsWith("http://localhost") && !h.startsWith("http://127.0.0.1")) expect(h, `${path} links out to ${h}`).toMatch(EXTERNAL_OK);
    }
  }
  for (const h of internal) {
    if (h === "/app" || h.startsWith("/app/") || h.startsWith("/api/v1/reference")) continue;
    const r = await request.get(h, { maxRedirects: 0 });
    expect([200, 301, 302, 307, 308], h).toContain(r.status());
  }
});

for (const width of [390, 1280]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`WEB1 key pages pass axe at ${width} ${scheme}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: scheme });
      for (const path of KEY) {
        await page.goto(path);
        await expect(page.locator("h1")).toBeVisible();
        const axe = await new AxeBuilder({ page }).analyze();
        const bad = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(" | ")}`);
        expect(bad, `${path}: ${bad.join(", ")}`).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(width);
        if (SHOTS && ["/", "/support", "/privacy"].includes(path)) {
          mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: `${SHOTS}/${path === "/" ? "home" : path.slice(1)}-${width}-${scheme}.png`, fullPage: path !== "/privacy" });
        }
      }
    });
  }
}

test("WEB1 Get the app shows no dead store link; PAR1 the iPhone Join the beta button opens TestFlight in a new tab", async ({ page }) => {
  for (const path of ["/", "/support"]) {
    await page.goto(path);
    const box = page.getByTestId("get-the-app");
    await expect(box).toBeVisible();
    await expect(box).toContainText("not in the stores yet");
    const beta = page.getByTestId("public-beta-link");
    await expect(beta).toHaveCount(1);
    await expect(beta).toHaveText("Join the beta");
    await expect(beta).toHaveAttribute("href", "https://testflight.apple.com/join/RncpPJ1t");
    await expect(beta).toHaveAttribute("target", "_blank");
    await expect(beta).toHaveAttribute("rel", /noopener/);
    expect((await beta.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('a[href*="apps.apple.com"], a[href*="play.google.com"]')).toHaveCount(0);
  }
});

test("WEB1 one public support address, and the privacy policy has its new sections", async ({ page }) => {
  for (const path of ["/support", "/contact", "/delete-account"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const text = await page.locator("main, article, body").first().innerText();
    expect(text, path).not.toContain("support@multies.si");
    expect(text, path).toContain("contact@fintex.au");
  }
  await page.goto("/privacy");
  for (const h of ["The Multies phone apps", "AI in Multies", "Social networks and chat channels you connect", "Demo and review accounts", "Where your data lives"]) {
    await expect(page.getByRole("heading", { name: h })).toBeVisible();
  }
  await expect(page.getByText(/Last updated/)).toBeVisible();
});

test("WEB1 /changelog points search engines at /whats-new", async ({ page }) => {
  await page.goto("/changelog");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/whats-new$/);
  await page.goto("/whats-new");
  await expect(page.getByText("Forms with uploads, signatures and pages")).toBeVisible();
  await expect(page.getByText("Ask shows its sources, and AI has an off switch")).toBeVisible();
});

test("PAR1 Join the beta at 375 and 1280 in light and dark: visible, 44 px, inside the page, readable", async ({ page }) => {
  const shots = process.env.PAR1_SHOTS;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const w of [375, 1280]) {
      await page.setViewportSize({ width: w, height: w === 375 ? 812 : 900 });
      await page.goto("/support");
      const beta = page.getByTestId("public-beta-link");
      await beta.scrollIntoViewIfNeeded();
      await expect(beta).toBeVisible();
      const b = (await beta.boundingBox())!;
      expect(b.height, `${w} ${scheme}`).toBeGreaterThanOrEqual(44);
      expect(b.x + b.width, `${w} ${scheme}`).toBeLessThanOrEqual(w);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${w} ${scheme} no sideways scroll`).toBe(true);
      const { violations } = await new AxeBuilder({ page }).include('[data-testid="get-the-app"]').analyze();
      expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id), `${w} ${scheme}`).toEqual([]);
      if (shots) { mkdirSync(shots, { recursive: true }); await page.getByTestId("get-the-app").screenshot({ path: `${shots}/par1-beta-${w}-${scheme}.png` }); }
    }
  }
});

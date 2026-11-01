import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { AREAS } from "../src/shared/marketing-areas";

/** W1: the public site refresh. Every new page loads with one h1, no console errors and no serious axe issue. */
const PAGES = ["/", "/features", ...AREAS.map((a) => `/features/${a.slug}`), "/pricing", "/whats-new", "/changelog"];

for (const path of PAGES) {
  test(`W1 ${path} loads clean`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text()); });
    await page.goto(path);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toBeVisible();
    const axe = await new AxeBuilder({ page }).analyze();
    const bad = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.length}`);
    expect(bad, bad.join(", ")).toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("W1 nav and footer reach the area pages", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Features" }).click();
  await expect(page).toHaveURL(/\/features$/);
  await page.getByTestId("area-grid").getByRole("link", { name: /Booking/ }).click();
  await expect(page).toHaveURL(/\/features\/booking$/);
  await expect(page.locator("h1")).toHaveText("Let people book you, a room or a seat.");
  await page.locator("footer").getByRole("link", { name: "Invoices and quotes" }).click();
  await expect(page).toHaveURL(/\/features\/invoices$/);
  await page.locator("footer").getByRole("link", { name: "What's new" }).click();
  await expect(page).toHaveURL(/\/whats-new$/);
  await expect(page.getByTestId("changelog-entry").first()).toBeVisible();
});

test("W1 pages fit a 390 wide phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/features", "/features/mail", "/pricing", "/whats-new"]) {
    await page.goto(path);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide, path).toBeLessThanOrEqual(390);
  }
});

test("W1 product shots follow the theme, one download each", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/features/tasks");
  const shot = page.getByTestId("product-shot").first();
  await expect(shot.locator("img.mk-shot-dark")).toBeVisible();
  await expect(shot.locator("img.mk-shot-light")).toBeHidden();
  const ok = await shot.locator("img.mk-shot-dark").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0);
  expect(ok).toBe(true);
});

test("W1 shared links preview with the page's own title and picture", async ({ page, request }) => {
  // The Worker writes the same tags into the HTML for readers that run no scripts (seo-meta.ts, withPageMeta).
  await page.goto("/features/invoices");
  await expect(page).toHaveTitle("Invoices and quotes | Multies");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", "https://multies.si/og/invoices.jpg");
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Invoices and quotes | Multies");
  const img = await request.get("/og/invoices.jpg");
  expect(img.status()).toBe(200);
  const unknown = await request.get("/features/not-a-thing");
  expect(unknown.status()).toBe(404);
  const map = await (await request.get("/sitemap.xml")).text();
  for (const a of AREAS) expect(map).toContain(`https://multies.si/features/${a.slug}`);
});

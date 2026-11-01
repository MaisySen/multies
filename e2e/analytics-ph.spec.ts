import { test, expect } from "@playwright/test";

/**
 * ANALYTICS-PH: with the flag off (the default, as here), the app sends no analytics at all: the config says off,
 * no request reaches /api/analytics, and no analytics host is ever contacted. With it on, the unit tests cover the
 * events (the network is mocked there); this run never talks to the analytics service.
 */
test("flag off: no analytics requests and no third party analytics host", async ({ page }) => {
  const seen: string[] = [];
  await page.route(/posthog\.com/, (route) => { seen.push(route.request().url()); return route.abort(); });
  page.on("request", (r) => { if (r.url().includes("/api/analytics/")) seen.push(r.url()); });
  const email = `ph-${Date.now()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Pat Example");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 15_000 });
  const cfg = await page.evaluate(() => fetch("/api/config").then((r) => r.json()));
  expect(cfg.analyticsPh).toBe(false);
  await page.goto("/app/tasks");
  await page.goto("/app/docs");
  await page.waitForTimeout(6000);
  expect(seen).toEqual([]);
  // The privacy policy carries the product usage analytics line.
  await page.goto("/privacy");
  await expect(page.getByText(/Product usage analytics/).first()).toBeVisible();
});

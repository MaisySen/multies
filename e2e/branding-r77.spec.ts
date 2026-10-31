import { test, expect } from "@playwright/test";

/**
 * R77: Settings, Branding. An admin picks a ready made theme, saves it, the whole app takes the colour, a reload
 * paints it before the app script runs (no flash), and Reset brings back the Multies look. Each person can set
 * their own appearance in Settings, Appearance.
 */
test("an admin brands the workspace, it survives a reload with no flash, and reset brings back the default", async ({ page }) => {
  if (!process.env.E2E_BASE_URL) await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `10.97.${test.info().workerIndex % 200}.1` });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  const brandVar = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim().toLowerCase());

  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await expect(page.getByRole("button", { name: "Forest", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Save brand" }).click();
  await expect.poll(brandVar).toBe("#15803d");

  // A reload paints the saved brand from the boot script, before the app runs.
  await page.goto("/app/settings/branding", { waitUntil: "commit" });
  await page.waitForFunction(() => !!document.head);
  await expect.poll(brandVar).toBe("#15803d");
  await expect(page.locator("style#brand-tokens")).toHaveCount(1);

  // Everyone has their own appearance page.
  await page.goto("/app/settings/appearance");
  await expect(page.getByTestId("appearance-settings")).toBeVisible();

  // Reset asks first, then brings back the Multies look.
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Reset to Multies default" }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect.poll(brandVar).not.toBe("#15803d");
});

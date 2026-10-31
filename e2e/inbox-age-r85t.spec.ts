import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R85T: the Shared inbox age label ("since the customer last wrote") turns orange after a day. It had no dark colour
 * (unreadable on dark rows, axe color-contrast serious). The browser clock is moved three days on so every open thread
 * shows the old age; contrast is checked at 1280 and 390, light and dark, default brand and Forest.
 */
const DIR = process.env.SHOTS_DIR;

async function ageContrast(page: Page, where: string) {
  const age = page.getByTestId("thread-age").first();
  await expect(age).toBeVisible({ timeout: 20_000 });
  const { violations } = await new AxeBuilder({ page }).include("[data-testid=thread-age]").withRules(["color-contrast"]).analyze();
  return violations.map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.failureSummary).join(" | ")}`);
}

test("Shared inbox age label is readable in light and dark, default brand and Forest", async ({ page }) => {
  test.setTimeout(150_000);
  if (!process.env.E2E_BASE_URL) await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `10.85.${test.info().workerIndex % 200}.7` });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.clock.setFixedTime(new Date(Date.now() + 3 * 86_400_000));
  const found: string[] = [];
  for (const brand of ["default", "forest"] as const) {
    if (brand === "forest") {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto("/app/settings/branding");
      await page.getByRole("button", { name: "Forest", exact: true }).click();
      await page.getByRole("button", { name: "Save brand" }).click();
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim().toLowerCase())).toBe("#15803d");
    }
    for (const width of [1280, 390]) {
      for (const scheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto("/app/inbox");
        found.push(...await ageContrast(page, `${brand} ${width} ${scheme}`));
        // The label carries the old age colour, not the muted one.
        const colour = await page.getByTestId("thread-age").first().evaluate((el) => getComputedStyle(el).color);
        expect(colour, `${brand} ${width} ${scheme}`).toBe(scheme === "dark" ? "rgb(255, 179, 64)" : "rgb(178, 80, 0)");
        if (DIR) await page.screenshot({ path: `${DIR}/r85t-inbox-age-${brand}-${width}-${scheme}.png` });
      }
    }
  }
  expect(found).toEqual([]);
});

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R100b: the /trust page passes axe (no serious or critical) at 1280 and 390 in light, dark and Forest: links inside
 * text are underlined (link-in-text-block) and the residency table's sideways scroll box takes keyboard focus
 * (scrollable-region-focusable).
 */
async function serious(page: Page) {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}
async function check(page: Page, label: string, found: string[]) {
  for (const w of [1280, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/trust");
    await expect(page.getByTestId("where-table")).toBeVisible();
    found.push(...(await serious(page)).map((x) => `${label} ${w}: ${x}`));
  }
}

test("R100b /trust passes axe at 1280 and 390 in light, dark and Forest", async ({ page }) => {
  test.setTimeout(120_000);
  const found: string[] = [];
  await page.emulateMedia({ colorScheme: "light" });
  await check(page, "light", found);
  await page.emulateMedia({ colorScheme: "dark" });
  await check(page, "dark", found);
  // The residency table's scroll box is reachable by keyboard and shows a focus ring.
  const box = page.getByTestId("where-table-scroll");
  await expect(box).toHaveAttribute("tabindex", "0");
  await expect(box).toHaveAttribute("role", "region");
  await box.focus();
  await expect(box).toBeFocused();
  // Forest is a workspace brand: set it in a demo workspace, then read the page signed in.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await check(page, "forest", found);
  expect(found).toEqual([]);
});

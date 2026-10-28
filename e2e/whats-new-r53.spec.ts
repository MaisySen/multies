import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";

/**
 * R53 (MB-133): "What's new". The account menu carries a What's new item with a small unread dot when the newest
 * entry is one this browser has not seen (localStorage only); opening it marks it seen and shows /changelog, a
 * public page listing the entries. SHOTS=before|after writes shots to /home/user/tab/files/multies-r53/whats-new/.
 */
const SHOTS = process.env.SHOTS;
const DIR = "/home/user/tab/files/multies-r53/whats-new";
let visitor = 0;
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.153.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(240_000);

const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${SHOTS}-${name}.png` });
};
const setTheme = (page: Page, theme: "light" | "dark") => page.evaluate((t) => {
  localStorage.setItem("mymail-theme", t);
  document.documentElement.dataset.theme = t;
}, theme);
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}

for (const [w, h, tag] of [[1280, 800, "desktop"], [390, 844, "phone"]] as const) {
  test(`${tag}: account menu shows What's new with a dot, opening it clears the dot and shows the changelog`, async ({ page }) => {
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: w, height: h });
    await signIn(page);
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await page.goto("/app");
      const trigger = tag === "phone" ? page.getByTestId("topbar-account") : page.getByTestId("sidebar-account");
      await expect(trigger).toBeVisible();
      await shot(page, `shell-${tag}-${theme}`);
      await trigger.click();
      await shot(page, `menu-${tag}-${theme}`);
      if (SHOTS === "before") { await page.keyboard.press("Escape"); continue; }
      const item = page.getByRole("menuitem", { name: /What's new/ });
      await expect(item).toBeVisible();
      if (theme === "light") {
        // First visit: the newest entry has not been seen, so the dot shows on the item and on the trigger.
        await expect(page.getByTestId("whats-new-dot")).toBeVisible();
        await item.click();
        await expect(page).toHaveURL(/\/changelog$/);
        await expect(page.getByRole("heading", { level: 1, name: "What's new" })).toBeVisible();
        await page.goto("/app");
        await expect(page.getByTestId("whats-new-unread")).toHaveCount(0);
      } else {
        await expect(page.getByTestId("whats-new-dot")).toHaveCount(0);
        await page.keyboard.press("Escape");
      }
    }
  });
}

test("/changelog is public, newest first, readable at 390 and 1280 in light and dark", async ({ page }) => {
  for (const [w, h, tag] of [[1280, 900, "desktop"], [390, 844, "phone"]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ["light", "dark"] as const) {
      await page.goto("/changelog");
      await setTheme(page, theme);
      await expect(page.getByRole("heading", { level: 1, name: "What's new" })).toBeVisible();
      const entries = page.getByTestId("changelog-entry");
      expect(await entries.count()).toBeGreaterThanOrEqual(8);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      const { violations } = await new AxeBuilder({ page }).include("main").analyze();
      expect(violations.filter((v) => v.impact === "moderate" || v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ${v.nodes[0]?.target}`)).toEqual([]);
      await shot(page, `changelog-${tag}-${theme}`);
    }
  }
  await expect(page.getByRole("link", { name: "What's new" }).first()).toBeAttached();
});

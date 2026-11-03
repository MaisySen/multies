import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * SOC1: several Facebook Pages per workspace (flag SOCIAL_MULTI_SOC1, E2E_SOC1=on, MOCK_FB_PAGES=130) against the
 * local stand in. Connect Facebook, the Page picker opens with 130 Pages (paged), search, select all found, pick two
 * more, save; the Pages show under the login; the composer shows each Page as its own account with Select all, posts
 * to them with a result per Page, schedules one, remembers the choice; keyboard path; axe 0 serious at 1280 and 390,
 * light, dark and Forest.
 */
let visitor = 0;
const ip = () => `10.157.${test.info().workerIndex % 200}.${++visitor}`;
const SHOTS = process.env.SHOTS_DIR;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function axe(page: Page, where: string, include = "main") {
  const { violations } = await new AxeBuilder({ page }).include(include).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/soc1-${name}.png` }); };

test("SOC1 several Facebook Pages: picker, accounts, composer per Page, schedule, remembered choice, axe", async ({ page, context }) => {
  test.skip(process.env.E2E_SOC1 !== "on", "needs E2E_SOC1=on");
  test.setTimeout(240_000);
  await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/social/accounts");
  await page.getByTestId("connect-facebook").getByRole("button", { name: /Connect Facebook/ }).click();
  // Back from the sign in: the picker opens for the new login.
  const picker = page.getByTestId("page-picker");
  await expect(picker).toBeVisible({ timeout: 20_000 });
  const rows = picker.getByTestId("pages-row");
  await expect(rows).toHaveCount(129); // 130 Pages, one can only view (not listed)
  await expect(picker.getByTestId("pages-view-only")).toHaveText(/1 Page you can only view is not listed/);
  await expect(page.getByTestId("pages-search")).toBeFocused();
  // A long name is truncated with an ellipsis (no wrap, no overflow).
  const long = rows.filter({ hasText: "Southbank" }).locator("span.truncate").first();
  expect(await long.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
  await shot(page, "picker-1280-light");
  const problems: string[] = [...await axe(page, "picker-1280-light", "dialog")];
  // Search, then select all found.
  await page.getByTestId("pages-search").fill("store 12");
  await expect(rows).toHaveCount(10); // store 120 to 129 (store 012 has a leading zero)
  await page.getByTestId("pages-select-all").check();
  await expect(page.getByTestId("pages-count")).toHaveText("10 chosen");
  await page.getByTestId("pages-search").fill("");
  await rows.filter({ hasText: /^Acme Bakery$/ }).getByRole("checkbox").check();
  await rows.filter({ hasText: "Acme Bakery Melbourne" }).getByRole("checkbox").check();
  await expect(page.getByTestId("pages-count")).toHaveText("12 chosen");
  await page.getByTestId("pages-save").click();
  await expect(page.getByText("12 Pages ready to post")).toBeVisible();
  await expect(picker).toBeHidden();
  const chosen = page.getByTestId("login-pages-facebook").getByTestId("login-page");
  await expect(chosen).toHaveCount(5);
  await page.getByTestId("login-pages-more").click();
  await expect(chosen).toHaveCount(12);

  // Accounts page at every width and theme.
  const views = async (where: string) => {
    await page.waitForTimeout(600);
    problems.push(...await axe(page, `accounts-${where}`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await shot(page, `accounts-${where}`);
  };
  await views("1280-light");
  for (const w of [375, 390, 430]) { await page.setViewportSize({ width: w, height: 844 }); await views(`${w}-light`); }
  await page.emulateMedia({ colorScheme: "dark" });
  await views("390-dark");
  // Picker at 390 dark (keyboard path: Change Pages by keyboard, Esc closes).
  await page.getByTestId("choose-pages").focus();
  await page.keyboard.press("Enter");
  await expect(picker).toBeVisible();
  await expect(page.getByTestId("pages-count")).toHaveText("12 chosen");
  await expect(page.getByTestId("pages-search")).toBeFocused();
  await page.keyboard.type("Melbourne");
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("pages-select-all")).toBeFocused();
  await page.waitForTimeout(400);
  problems.push(...await axe(page, "picker-390-dark", "dialog"));
  await shot(page, "picker-390-dark");
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 860 });
  await views("1280-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // Composer: each Page is its own account; Select all per network; post now with a result per Page.
  await page.goto("/app/social/new");
  const fb = page.getByTestId("group-facebook");
  await expect(fb.getByTestId("pick-facebook")).toHaveCount(12);
  await page.getByTestId("social-text").fill("Fresh bread at every store today");
  await page.getByTestId("select-all-facebook").click();
  await expect(fb.getByRole("checkbox", { checked: true })).toHaveCount(12);
  await page.getByTestId("select-all-facebook").click(); // Clear
  await expect(fb.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await fb.getByTestId("pick-facebook").filter({ hasText: /Acme Bakery$/ }).getByRole("checkbox").check();
  await fb.getByTestId("pick-facebook").filter({ hasText: "Acme Bakery Melbourne" }).getByRole("checkbox").check();
  await page.waitForTimeout(400);
  problems.push(...await axe(page, "composer-1280-light"));
  await shot(page, "composer-1280-light");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  problems.push(...await axe(page, "composer-390-light"));
  await shot(page, "composer-390-light");
  await page.getByRole("button", { name: "Post to 2 accounts" }).click();
  const sheet = page.getByTestId("posted-sheet");
  await expect(sheet).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(sheet.getByTestId("post-target")).toHaveCount(2);
  await expect(sheet).toContainText("Acme Bakery Melbourne");
  await shot(page, "sheet-390-light");
  problems.push(...await axe(page, "sheet-390-light", "body"));
  await page.keyboard.press("Escape");

  // The last choice comes back; schedule it for later.
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/social/new");
  await expect(page.getByTestId("group-facebook").getByRole("checkbox", { checked: true })).toHaveCount(2);
  await page.getByTestId("social-text").fill("Weekend markets are back");
  await page.getByTestId("when-later").click();
  await page.getByRole("button", { name: /Schedule for 2 accounts/ }).click();
  await expect(page).toHaveURL(/\/app\/social\/posts/, { timeout: 15_000 });

  // Forest at 1280.
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await page.goto("/app/social/accounts");
  await expect(chosen).toHaveCount(5);
  await views("1280-forest");
  expect(problems).toEqual([]);
});

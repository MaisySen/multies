import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * SA1: Social, Accounts against the local stand in for the integration platform. Connecting the same LinkedIn
 * account twice leaves one row, named after the account, with the plain company page note; the page is axe clean at
 * 1280 and 390 in light, dark and Forest.
 */
let visitor = 0;
const ip = () => `10.181.${test.info().workerIndex % 200}.${++visitor}`;
const SHOTS = process.env.SHOTS_DIR;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

async function axe(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}

test("SA1 connect the same LinkedIn twice: one row with its name, page note, axe in every theme", async ({ page, context }) => {
  test.setTimeout(120_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/social/accounts");
  await expect(page.getByTestId("connect-linkedin-note")).toContainText("needs LinkedIn's approval for page access");

  await page.getByTestId("connect-linkedin").getByRole("button", { name: /Connect LinkedIn/ }).click();
  await expect(page).toHaveURL(/\/app\/social\/accounts(\?|$)/);
  await expect(page.getByText("LinkedIn connected as Ada")).toBeVisible();
  const rows = page.getByTestId("social-account-linkedin");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByTestId("account-name")).toHaveText("Ada");
  await expect(rows.getByTestId("linkedin-page-note")).toBeVisible();

  // The same account again: still one row, and the toast says its sign in was refreshed.
  await page.getByTestId("connect-linkedin").getByRole("button", { name: /Connect LinkedIn/ }).click();
  await expect(page.getByText(/was already connected\. Its sign in is refreshed\./)).toBeVisible();
  await page.reload();
  await expect(rows).toHaveCount(1);
  await expect(rows.getByTestId("account-name")).toHaveText("Ada");
  await expect(rows.getByRole("button", { name: /Disconnect LinkedIn, Ada/ })).toBeVisible();

  const problems: string[] = [];
  const views = async (where: string) => {
    await expect(rows.getByTestId("account-name")).toBeVisible();
    // Colours ease between themes; let them settle before reading contrast.
    await page.waitForTimeout(700);
    problems.push(...await axe(page, where));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/sa1-accounts-${where}.png`, fullPage: false });
  };
  await views("1280-light");
  await page.setViewportSize({ width: 390, height: 844 });
  await views("390-light");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await page.emulateMedia({ colorScheme: "dark" });
  await views("390-dark");
  await page.setViewportSize({ width: 1280, height: 860 });
  await views("1280-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await page.goto("/app/social/accounts");
  await views("1280-forest");
  await page.setViewportSize({ width: 390, height: 844 });
  await views("390-forest");
  expect(problems).toEqual([]);
});

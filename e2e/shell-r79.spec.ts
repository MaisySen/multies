import { test, expect } from "@playwright/test";

/** R79: the calm shell. Rail, section sidebar, top bar, resizable panes, per person layout, skip link, Tab in Mail. */
const mod = process.platform === "darwin" ? "Meta" : "Control";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});

test("rail, sidebar fold with the shortcut and stays folded after a reload", async ({ page }) => {
  await expect(page.getByTestId("icon-rail")).toBeVisible();
  await expect(page.getByTestId("context-sidebar")).toBeVisible();
  await page.locator("main#main").focus();
  await page.keyboard.press(`${mod}+Backslash`);
  await expect(page.getByTestId("context-sidebar")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("icon-rail")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("context-sidebar")).toHaveCount(0);
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("context-sidebar")).toBeVisible();
});

test("skip link is the first Tab stop and moves focus to the page (MB-278)", async ({ page }) => {
  await page.reload();
  await expect(page.getByTestId("icon-rail")).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Tab");
  if (!(await page.getByTestId("skip-link").evaluate((el) => el === document.activeElement))) console.log("first tab stop:", await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160)));
  const skip = page.getByTestId("skip-link");
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
  expect(await page.locator("#main").count()).toBe(1);
});

test("Create menu lists the five kinds and opens New task", async ({ page }) => {
  await page.getByTestId("create-menu").click();
  for (const name of ["Task", "Doc", "Email", "Meeting", "File"]) await expect(page.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeVisible();
  await page.getByRole("menuitem", { name: /^Task/ }).click();
  await expect(page).toHaveURL(/\/app\/tasks/);
});

test("Mail: Tab moves focus through the list and the reading pane follows the View menu (MB-273)", async ({ page }) => {
  await page.goto("/app/mail");
  const rows = page.getByTestId("mail-select");
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  await rows.first().focus();
  const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
  await page.keyboard.press("Tab");
  const after = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
  expect(after).not.toBe(before);
  await page.getByTestId("view-menu").click();
  await page.getByRole("menuitemradio", { name: /Bottom/ }).click();
  await expect(page.locator('[data-mail-pane="bottom"]')).toBeVisible();
  await page.getByTestId("view-menu").click();
  await page.getByRole("menuitem", { name: "Reset layout" }).click();
  await expect(page.locator('[data-mail-pane="right"]')).toBeVisible();
});

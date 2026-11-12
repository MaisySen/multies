import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R50 (MB-238): mail to task on a phone. The reply bar carries a 44 px task button; the thread's chips show the task
 * title at 44 px; Back from the task returns to the thread; desktop keeps its inline button and ref chips.
 * SHOTS=before|after writes shots to SHOTS_ROOT/multies-r50/ (before runs only the shot steps).
 */
const SHOTS = process.env.SHOTS;
const DIR = `${SHOTS_ROOT}/multies-r50`;
let visitor = 0;
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.150.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(240_000);

async function openThread(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
  await page.goto("/app/mail");
  await page.getByTestId("mail-row").first().click({ timeout: 15_000 });
}
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/mail-${SHOTS}-${name}.png` });
};
const overflowX = (page: Page) => page.evaluate(() => {
  const main = document.querySelector("main") as HTMLElement | null;
  return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0);
});

test("phone 390: reply bar makes the task, title chip, 44 px, Back returns to the thread", async ({ page }) => {
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openThread(page);
  const bar = page.getByTestId("thread-reply-bar");
  await expect(bar).toBeVisible();
  await shot(page, "thread-phone-light");
  if (SHOTS === "before") return;
  const btn = bar.getByRole("button", { name: "Make a task" });
  await expect(btn).toBeVisible();
  const b = (await btn.boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.width).toBeGreaterThanOrEqual(44);
  await btn.click();
  const chip = page.getByTestId("linked-task").first();
  await expect(chip).toBeVisible();
  expect(await chip.innerText()).toMatch(/^Task: /);
  expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("linked-task")).toHaveCount(1);
  // A second tap opens the task instead of making a second one.
  await expect(bar.getByRole("button", { name: /^Open task / })).toBeVisible();
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
  await shot(page, "thread-with-task-phone-light");
  const mailUrl = page.url();
  await chip.click();
  await expect(page).toHaveURL(/\/app\/tasks\?.*task=/);
  await page.goBack();
  await expect(page).toHaveURL(mailUrl);
  await expect(page.getByTestId("thread-reply-bar")).toBeVisible();
  await expect(page.getByTestId("linked-task")).toHaveCount(1);
});

test("phone 390 dark: bar button and title chip", async ({ page }) => {
  page.setDefaultTimeout(15_000);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await openThread(page);
  await expect(page.getByTestId("thread-reply-bar")).toBeVisible();
  await shot(page, "thread-phone-dark");
  if (SHOTS === "before") return;
  await page.getByTestId("reply-bar-task").click();
  await expect(page.getByTestId("linked-task").first()).toContainText("Task:");
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
  await shot(page, "thread-with-task-phone-dark");
});

test("desktop 1280: inline Make task and ref chips unchanged, no reply bar", async ({ page }) => {
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openThread(page);
  await expect(page.getByTestId("thread-reply-bar")).toBeHidden();
  const inline = page.getByRole("button", { name: "Make task from this email" });
  await expect(inline).toBeVisible();
  await expect(inline).toHaveText(/Make task/);
  await shot(page, "thread-desktop-light");
  if (SHOTS === "before") return;
  await inline.click();
  const chip = page.getByTestId("linked-task").first();
  await expect(chip).toBeVisible();
  // innerText skips the phone only title (display none at this width): desktop still reads "TSK-3 To do".
  const shown = await chip.innerText();
  expect(shown).not.toContain("Task:");
  expect(shown).toMatch(/^[A-Z]+-\d+ /);
  await shot(page, "thread-with-task-desktop-light");
});

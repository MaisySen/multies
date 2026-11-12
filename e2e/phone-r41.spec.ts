import { test, expect, type Page } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R41 phone helper: phone Tasks cards and View picker, bottom sheet pickers, stat strips with full labels, rapid add
 * in a board column, the demo's invite message and sample mailbox Reconnect, and Start now on Meetings at 390 px.
 * SHOTS=before or SHOTS=after saves screenshots to SHOTS_ROOT/multies-r41/ (before skips the new checks).
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.141.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(180_000);

const SHOTS = process.env.SHOTS;
const AFTER = SHOTS !== "before";
const DIR = `${SHOTS_ROOT}/multies-r41`;
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 800 };

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}
async function settle(page: Page) { await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); }
async function shot(page: Page, name: string) { if (SHOTS) await page.screenshot({ path: `${DIR}/${name.replace("{p}", SHOTS)}.png`, type: "png" }); }
async function noSideways(page: Page, what: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, `${what} scrolls sideways at 390`).toBeLessThanOrEqual(1);
}

for (const scheme of ["light", "dark"] as const) {
  test(`phone Tasks list, View picker sheet, stats and demo invite (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(PHONE);
    await demo(page);
    await page.goto("/app/tasks?view=list");
    await settle(page);
    if (AFTER) {
      await expect(page.getByTestId("phone-task-list")).toBeVisible({ timeout: 15_000 });
      const row = page.getByTestId("phone-task-row").first();
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await noSideways(page, "Tasks list");
    }
    await shot(page, `tasks-list-{p}-cards-phone-${scheme}`);
    if (AFTER) {
      // The six view buttons are one View picker; it opens the bottom sheet and picking a row changes the view.
      await page.locator('[data-testid="phone-select"][data-name="View"]').click();
      await expect(page.getByTestId("picker-sheet")).toBeVisible();
      await shot(page, `pickers-{p}-view-sheet-phone-${scheme}`);
      await page.getByTestId("picker-sheet").getByRole("radio", { name: "Board" }).click();
      await expect(page).toHaveURL(/view=board/);
    }
    for (const [area, path] of [["stats", "/app/settings/team"], ["stats-domains", "/app/domains"]] as const) {
      await page.goto(path);
      await settle(page);
      if (AFTER) {
        const strip = page.getByTestId(area === "stats" ? "team-headline" : "domain-stats");
        await expect(strip).toBeVisible({ timeout: 15_000 });
        // Every label shows in full: nothing is cut with an ellipsis.
        const cut = await strip.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>("span,div")).filter((n) => n.children.length === 0 && n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent));
        expect(cut, `${path} labels cut`).toEqual([]);
        await noSideways(page, path);
      }
      await shot(page, `${area}-{p}-strip-phone-${scheme}`);
    }
    await page.goto("/app/settings/team");
    await settle(page);
    if (AFTER) {
      await expect(page.getByTestId("team-invite-button")).toBeDisabled();
      await expect(page.getByTestId("demo-invites-off")).toContainText("Invites are off in the demo");
    }
    await shot(page, `demo-invite-{p}-team-phone-${scheme}`);
  });
}

test("desktop keeps native controls; demo invite reason and sample mailbox Reconnect", async ({ page }) => {
  await page.setViewportSize(DESK);
  await demo(page);
  await page.goto("/app/tasks?view=list");
  await settle(page);
  if (AFTER) {
    await expect(page.getByTestId("phone-task-list")).toHaveCount(0);
    await expect(page.getByTestId("phone-select").first()).toBeHidden();
    await expect(page.getByRole("tab", { name: "Board" })).toBeVisible();
  }
  await shot(page, "tasks-list-{p}-table-desktop-light");
  await page.goto("/app/settings/team");
  await settle(page);
  if (AFTER) await expect(page.getByTestId("demo-invites-off")).toBeVisible({ timeout: 15_000 });
  await shot(page, "demo-invite-{p}-team-desktop-light");
  await page.goto("/app/settings/connections");
  await settle(page);
  if (AFTER) {
    await expect(page.getByTestId("sample-reconnect")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("sample-reconnect").click();
    await expect(page.getByText("The sample mailbox is connected again")).toBeVisible();
  }
  await shot(page, "demo-mailbox-{p}-connections-desktop-light");
});

test("board column keeps the add field open for rapid entry", async ({ page }) => {
  test.skip(!AFTER, "new behaviour");
  await page.setViewportSize(DESK);
  await demo(page);
  await page.goto("/app/tasks?view=board");
  await settle(page);
  const col = page.locator("[data-testid^='composer-']").first();
  await expect(col).toBeVisible({ timeout: 15_000 });
  await col.getByRole("button", { name: "Add task" }).click();
  const input = col.getByRole("textbox");
  const names = ["Rapid one", "Rapid two", "Rapid three", "Rapid four", "Rapid five"];
  for (const n of names) { await input.fill(n); await input.press("Enter"); await expect(input).toBeFocused(); }
  for (const n of names) await expect(page.getByText(n, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "tasks-board-after-rapid-add-desktop-light");
  await input.press("Escape");
  await expect(col.getByRole("button", { name: "Add task" })).toBeVisible();
});

test("Meetings Start now fits and works at 390 px", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await demo(page);
  await page.goto("/app/meetings");
  await settle(page);
  const start = page.getByTestId("meeting-start-now");
  await expect(start).toBeVisible({ timeout: 15_000 });
  const box = (await start.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.height).toBeGreaterThanOrEqual(36);
  await noSideways(page, "Meetings");
  await shot(page, "meetings-{p}-start-now-phone-light");
  await start.click();
  await expect(page).toHaveURL(/\/app\/meetings\/[^/?]+/, { timeout: 20_000 });
});

test("phone pickers: a Select in a form opens the sheet and sets the value", async ({ page }) => {
  test.skip(!AFTER, "new behaviour");
  await page.setViewportSize(PHONE);
  await demo(page);
  await page.goto("/app/tasks?view=list");
  await settle(page);
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-testid="phone-select"][data-name="Priority"]').click();
  const sheet = page.getByTestId("picker-sheet").last();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("radio", { name: "High" }).click();
  await expect(dialog.locator('[data-testid="phone-select"][data-name="Priority"]')).toHaveText("High");
  await expect(dialog.getByLabel("Priority")).toHaveValue("high");
  await shot(page, "pickers-after-new-task-phone-light");
});

test("Scheduling weekly hours: times open a sheet of 15 minute slots on phones", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await demo(page);
  await page.goto("/app/scheduling");
  await settle(page);
  await expect(page.getByText("Weekly hours")).toBeVisible({ timeout: 15_000 });
  await shot(page, "pickers-{p}-scheduling-phone-light");
  if (!AFTER) return;
  const from = page.locator('[data-testid="phone-time"]').first();
  await expect(from).toBeVisible();
  const name = await from.getAttribute("data-name");
  await from.click();
  const sheet = page.getByTestId("picker-sheet").last();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("radio")).toHaveCount(96);
  await shot(page, "pickers-after-time-sheet-phone-light");
  await sheet.getByRole("radio", { name: "9:30 AM" }).click();
  await expect(page.getByLabel(name!)).toHaveValue("09:30");
  await noSideways(page, "Scheduling");
});

test("stat strips show full labels at 360 px", async ({ page }) => {
  test.skip(!AFTER, "new behaviour");
  await page.setViewportSize({ width: 360, height: 780 });
  await demo(page);
  for (const [id, path] of [["team-headline", "/app/settings/team"], ["domain-stats", "/app/domains"]] as const) {
    await page.goto(path);
    await settle(page);
    const strip = page.getByTestId(id);
    await expect(strip).toBeVisible({ timeout: 15_000 });
    const cut = await strip.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>("span,div")).filter((n) => n.children.length === 0 && n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent));
    expect(cut, `${path} labels cut at 360`).toEqual([]);
    await noSideways(page, `${path} at 360`);
  }
  await shot(page, "stats-domains-after-strip-phone360-light");
});

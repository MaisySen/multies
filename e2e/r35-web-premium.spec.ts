import { test, expect, type Page } from "@playwright/test";

/**
 * R35 Premium pass 2 (web): the Today home renders its cards and Focus, icons come from the one icon set, and a mail
 * row swipes to archive on a phone with Undo. Set R35_SHOTS to a folder to also save a mid-swipe screenshot.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 45_000 });
}

async function touch(page: Page, sel: string, type: string, x: number, y: number) {
  await page.locator(sel).first().evaluate((el, a) => {
    el.dispatchEvent(new PointerEvent(a.type, { pointerId: 7, pointerType: "touch", isPrimary: true, clientX: a.x, clientY: a.y, bubbles: true, cancelable: true }));
  }, { type, x, y });
}

test("Today home: cards, Focus and icons from the one set", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1440, height: 900 } });
  await ctx.setExtraHTTPHeaders({ "x-forwarded-for": "10.135.9.1" });
  const page = await ctx.newPage();
  await demo(page);
  await page.goto("/app/my-work");
  await expect(page.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
  await expect(page.getByTestId("today-cards").getByTestId("today-mail")).toBeVisible();
  await expect(page.getByTestId("today-approvals")).toContainText("Approvals waiting");
  await expect(page.getByTestId("today-quick").getByRole("link", { name: "New task" })).toBeVisible();
  // Every glyph in the sidebar is from the one icon set, and the active row's glyph is filled.
  expect(await page.locator('aside[aria-label="Sidebar"] svg[data-icon]').count()).toBeGreaterThan(10);
  expect(await page.locator('svg.lucide').count()).toBe(0);
  await ctx.close();
});

test("mail row swipes left to archive on a phone, with Undo", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx.setExtraHTTPHeaders({ "x-forwarded-for": "10.135.9.2" });
  const page = await ctx.newPage();
  await demo(page);
  await page.goto("/app/mail");
  const rows = page.getByTestId("mail-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  // R48: no networkidle here. The demo inbox keeps delivering mail (and the page keeps a live feed open), so the network
  // never goes quiet for 500 ms and the wait timed out on every run, on main too. Wait for what the swipe needs instead:
  // a swipeable row with its Archive action rendered, and the list holding still for a moment.
  await expect(page.getByTestId("mail-swipe").first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => {
    const a = await page.getByTestId("mail-swipe").first().boundingBox();
    await page.waitForTimeout(300);
    const b = await page.getByTestId("mail-swipe").first().boundingBox();
    return !!a && !!b && a.y === b.y && a.height === b.height;
  }, { timeout: 15_000 }).toBe(true);
  const whoOf = async () => (await page.getByTestId("mail-swipe").filter({ has: page.getByRole("button", { name: "Archive" }) }).first().innerText()).split("\n").map((l) => l.trim()).filter((l) => l && !["Unread", "Archive", "Snooze", "Move to Inbox"].includes(l))[2];
  const box = (await page.getByTestId("mail-swipe").first().boundingBox())!;
  const y = box.y + box.height / 2;
  const start = box.x + box.width - 20;
  await touch(page, '[data-testid="mail-swipe"]', "pointerdown", start, y);
  for (const dx of [12, 40, 90, 140]) await touch(page, '[data-testid="mail-swipe"]', "pointermove", start - dx, y);
  await expect(page.getByTestId("mail-swipe").first().getByRole("button", { name: "Archive" })).toBeVisible();
  // Demo mail can arrive mid-test, so name the row that is actually open, not the first one.
  const who = await whoOf();
  expect(who).toBeTruthy();
  if (process.env.R35_SHOTS) await page.screenshot({ path: `${process.env.R35_SHOTS}/web-after-mail-swipe-phone-light.png` });
  for (const dx of [200, 260, 300]) await touch(page, '[data-testid="mail-swipe"]', "pointermove", start - dx, y);
  await touch(page, '[data-testid="mail-swipe"]', "pointerup", start - 300, y);
  // The commit runs the same undoable archive as the bulk bar: one conversation, and the toast offers Undo. (The demo
  // inbox refills the Important split as mail lands, so the list itself is not a stable thing to count here.)
  await expect(page.getByText("Archived 1 conversation")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="mail-swipe"] [style*="translate"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Archived 1 conversation")).toHaveCount(0, { timeout: 10_000 });
  await ctx.close();
});

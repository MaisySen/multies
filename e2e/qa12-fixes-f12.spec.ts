import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { writeXlsx } from "../src/shared/office-r113/xlsx";
import { parseInput } from "../src/shared/office-r113/sheet";

/**
 * F12 (QA12 fixes) in a demo workspace, made up data; server failures are mocked in the browser only.
 * MB-296: the Office editor asks before leaving with unsaved edits (rail, Back), also after a failed Save; not after a
 * good Save. MB-303: a phone shows no Save on a view only sheet. MB-295, MB-297, MB-298: Mail, My Work and Timesheet show
 * the shared Couldn't load this card with Retry on a server failure, and Retry recovers. R125 low: at 390 the Tables
 * View button no longer covers the 4th view tab. SHOTS_DIR writes f12-*.png.
 */
const SHOTS = process.env.SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => { if (SHOTS) { await page.waitForTimeout(250); await page.screenshot({ path: `${SHOTS}/f12-${name}.png` }); } };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function demo(page: Page) {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  return origin;
}
async function noSeriousAxe(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.length}`);
  expect(bad).toEqual([]);
}
async function failReads(page: Page, state: { fail: boolean }, only: RegExp, status = 500) {
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (!state.fail || req.method() !== "GET" || !only.test(path)) return route.continue();
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Something went wrong on our side." } }) });
  });
}
async function xlsxFile(page: Page, origin: string, name: string) {
  const wb = { sheets: [{ name: "Budget", cells: new Map([["A1", parseInput("2")], ["A2", parseInput("3")]]), rowCount: 50, colCount: 12 }] };
  const r = await page.request.put(`/api/drive/upload?space=team&name=${encodeURIComponent(name)}`, { headers: { origin, "x-multies-upload": "1", "content-type": XLSX }, data: Buffer.from(writeXlsx(wb)) });
  expect(r.ok(), await r.text()).toBe(true);
  return ((await r.json()) as { item: { id: string } }).item.id;
}
/** Files > the file > Open in editor, inside the app, so Back is an in app move. */
async function openInEditor(page: Page, name: string) {
  await page.goto("/app/files?view=team");
  const row = page.getByTestId("drive-row").filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole("button", { name: new RegExp(name.replace(".", "\\.")) }).first().click();
  await page.getByTestId("drive-open-editor").click();
  await expect(page).toHaveURL(/\/app\/files\/edit\//);
  const grid = page.getByRole("grid", { name: "Budget sheet" });
  await expect(grid).toBeVisible({ timeout: 20_000 });
  return grid;
}
async function typeInCell(page: Page, grid: ReturnType<Page["getByRole"]>, text: string) {
  await grid.focus();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
  await page.keyboard.type(text); await page.keyboard.press("Enter");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
}
const railTasks = (page: Page) => page.locator('a[href="/app/tasks"]').first();
const leaveDialog = (page: Page) => page.getByRole("dialog", { name: "Leave this page?" });

test("MB-296: unsaved edits ask before leaving by the rail and Back, also after a failed Save", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await demo(page);
  const id = await xlsxFile(page, origin, "Guard test.xlsx");
  const grid = await openInEditor(page, "Guard test.xlsx");
  await typeInCell(page, grid, "7");

  await railTasks(page).click();
  await expect(leaveDialog(page)).toBeVisible();
  await expect(leaveDialog(page)).toContainText("Your changes are not saved yet");
  await page.getByTestId("leave-stay").click();
  await expect(leaveDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/files\/edit\//);
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await page.goBack();
  await expect(leaveDialog(page)).toBeVisible();
  await page.waitForTimeout(400); // the dialog's open animation
  await page.getByTestId("leave-stay").click();
  await expect(page).toHaveURL(/\/app\/files\/edit\//);

  // A Save that fails (the daily limit) keeps the edits unsaved, so the question stays.
  await page.route(`**/api/drive/items/${id}/content**`, (route) => route.request().method() === "PUT"
    ? route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "daily_limit", message: "You have reached today's limit for saving files. Try again tomorrow." } }) })
    : route.continue());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("You have reached today's limit for saving files.")).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await railTasks(page).click();
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByTestId("leave-stay").click();

  // A good Save: no question any more.
  await page.unroute(`**/api/drive/items/${id}/content**`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved as version 2")).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  await railTasks(page).click();
  await expect(page).toHaveURL(/\/app\/tasks/);
  await expect(leaveDialog(page)).toHaveCount(0);

  // Back, then Leave, goes back.
  await openInEditor(page, "Guard test.xlsx");
  await typeInCell(page, page.getByRole("grid", { name: "Budget sheet" }), "8");
  await page.goBack();
  await expect(leaveDialog(page)).toBeVisible();
  await page.waitForTimeout(400);
  await page.getByTestId("leave-go").click();
  await expect(page).toHaveURL(/\/app\/files(\?|$)/);

  // Leave really leaves.
  await openInEditor(page, "Guard test.xlsx");
  await typeInCell(page, page.getByRole("grid", { name: "Budget sheet" }), "9");
  await railTasks(page).click();
  await expect(leaveDialog(page)).toBeVisible();
  await page.waitForTimeout(400);
  await noSeriousAxe(page);
  await shot(page, "leave-1280-light");
  await page.getByTestId("leave-go").click();
  await expect(page).toHaveURL(/\/app\/tasks/);
});

test("MB-303: on a phone the view only sheet has no Save", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const origin = await demo(page);
  const id = await xlsxFile(page, origin, "Phone sheet.xlsx");
  await page.goto(`/app/files/edit/${id}`);
  await expect(page.getByText("Edit sheets on a bigger screen. You can view here.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await shot(page, "office-390-light");
});

const PAGES: [string, string, RegExp][] = [
  ["Mail", "/app/mail", /^\/api\/mail\/overview$/],
  ["My Work", "/app/my-work", /^\/api\/my-work$/],
  ["Timesheet", "/app/time", /^\/api\/time\/timesheet$/],
];
for (const [name, path, only] of PAGES) {
  test(`${name}: a server failure shows Couldn't load this with Retry, and Retry recovers`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await demo(page);
    const state = { fail: true };
    await failReads(page, state, only);
    await page.goto(path);
    const card = page.getByTestId("load-error");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("Couldn't load this");
    await expect(card).toContainText("Something went wrong on our side. Your work is safe.");
    await expect(page.getByText("No mailboxes yet")).toHaveCount(0);
    await expect(page.getByText("Nothing is waiting on you")).toHaveCount(0);
    await expect(page.getByText("Something went wrong on this page")).toHaveCount(0);
    await noSeriousAxe(page);
    await shot(page, `${name.replace(" ", "").toLowerCase()}-error-1280-light`);
    state.fail = false;
    await page.getByTestId("load-error-retry").click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
  });
}

test("Mail at 390 dark: the failure card, not the empty state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await demo(page);
  await failReads(page, { fail: true }, /^\/api\/mail\/overview$/);
  await page.goto("/app/mail");
  await expect(page.getByTestId("load-error")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("No mailboxes yet")).toHaveCount(0);
  await shot(page, "mail-error-390-dark");
});

for (const scheme of ["light", "dark"] as const) {
  test(`Tables at 390 ${scheme}: the View button does not cover the 4th view tab`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: scheme });
    await demo(page);
    const r = await page.request.post("/api/tables", { data: { title: "Clients" } });
    const id = ((await r.json()) as { table: { id: string } }).table.id;
    for (const [n, type] of [["Pipeline board", "kanban"], ["Follow up calendar", "calendar"], ["Intake form", "form"]]) {
      expect((await page.request.post(`/api/tables/${id}/views`, { data: { name: n, type, config: {} } })).status()).toBeLessThan(300);
    }
    await page.goto(`/app/docs/${id}`);
    const tabs = page.getByRole("tablist", { name: "Views" }).getByRole("tab");
    await expect(tabs).toHaveCount(4, { timeout: 15_000 });
    const add = page.getByTestId("add-view");
    const fourth = tabs.nth(3);
    await fourth.scrollIntoViewIfNeeded();
    const a = (await fourth.boundingBox())!; const b = (await add.boundingBox())!;
    const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    expect(overlap).toBe(0);
    await fourth.click();
    await expect(fourth).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await shot(page, `tables-tabs-390-${scheme}`);
  });
}

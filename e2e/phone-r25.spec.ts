import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Round 25 phone layout (DF-10) at 390 x 844 on a touch screen: the main pages have no sideways
 * overflow, Tasks opens as a List (and keeps a Board the person picks, scrolling with snap), goal key
 * results stack instead of squeezing into a narrow column, and the chat composer shows no keyboard
 * hints and no made up task ref.
 */
test.describe.configure({ mode: "serial" });
const SHOTS = "/home/user/tab/files/multies-r25";
let ctx: BrowserContext, page: Page;
const errors: string[] = [];
let visitor = 0;
const ip = () => `10.125.${test.info().workerIndex % 200}.${++visitor}`;

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const base = test.info().project.use.baseURL!;
  ctx = await browser.newContext({ baseURL: base, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
});
test.afterAll(async () => { await ctx?.close(); });

const headers = () => ({ origin: new URL(test.info().project.use.baseURL!).origin });

/**
 * R42: wait for a real ready signal, not network idle. The mail view keeps one live mail heartbeat open (a long poll
 * of up to 25 s, src/web/lib/live-mail.ts), so the network is never idle there and the old wait ran into the test
 * timeout. Ready means the page has loaded, no skeleton is left and layout has had two frames to settle.
 */
async function ready() {
  await page.waitForLoadState("load");
  await expect(page.locator(".skeleton")).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function noSidewaysScroll(label: string) {
  await ready();
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `${label}: page is ${m.sw} px wide on a ${m.iw} px screen`).toBeLessThanOrEqual(m.iw);
  expect(m.bw, `${label}: body is ${m.bw} px wide`).toBeLessThanOrEqual(m.iw);
  expect(m.iw).toBe(390);
}

test("the main pages fit a 390 px phone with no sideways scroll", async () => {
  const pages = ["/app/my-work", "/app/tasks?view=list", "/app/mail", "/app/chat", "/app/docs", "/app/meetings", "/app/dashboards", "/app/goals", "/app/settings"];
  for (const path of pages) {
    await page.goto(path);
    // Each page shows its own heading once its code and data are in.
    await expect(page.locator("main").getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    await noSidewaysScroll(path);
  }

  // A task panel, opened from the list.
  const tasks = (await (await page.request.get("/api/tasks")).json()).tasks as { id: string; title: string }[];
  expect(tasks.length).toBeGreaterThan(0);
  await page.goto(`/app/tasks?view=list&task=${tasks[0].id}`);
  const panel = page.getByRole("dialog", { name: "Task" });
  await expect(panel).toBeVisible();
  await noSidewaysScroll("task panel");
  const close = await panel.getByRole("button", { name: "Close task" }).boundingBox();
  expect(close!.height).toBeGreaterThanOrEqual(40);
  expect(close!.width).toBeGreaterThanOrEqual(40);

  // A mail thread, opened from the list.
  await page.goto("/app/mail");
  // R42: rows carry a select box and a star beside the open button now; the open button is the row's first button.
  const first = page.getByTestId("mail-row").first().getByRole("button").first();
  await expect(first).toBeVisible({ timeout: 15_000 });
  await first.click();
  await page.waitForTimeout(500);
  await noSidewaysScroll("mail thread");

  expect(errors, errors.join("\n")).toEqual([]);
});

test("DF-10: Tasks opens as a List on a phone, keeps a Board the person picks, and the Board snaps sideways", async () => {
  // R41 MB-226 made the phone list card rows and folded the six view tabs into one View picker (a bottom sheet);
  // R42 follows that here (phone-r41 covers the picker sheet itself).
  await page.evaluate(() => localStorage.removeItem("multies:tasks-view"));
  await page.goto("/app/tasks");
  const picker = page.locator('[data-testid="phone-select"][data-name="View"]');
  await expect(page.getByTestId("phone-task-list")).toBeVisible({ timeout: 15_000 });
  const pb = (await picker.boundingBox())!;
  expect(pb.height).toBeGreaterThanOrEqual(40);
  await noSidewaysScroll("tasks list");
  await page.screenshot({ path: `${SHOTS}/phone-tasks.png` });
  await page.screenshot({ path: `${SHOTS}/r25-web.png` });

  // The person picks the Board: it scrolls sideways with snap, each column fits the screen, and it is kept.
  await picker.click();
  await page.getByTestId("picker-sheet").getByRole("radio", { name: "Board" }).click();
  const board = page.getByTestId("board");
  await expect(board).toBeVisible();
  const snap = await board.evaluate((el) => ({ type: getComputedStyle(el).scrollSnapType, overflow: getComputedStyle(el).overflowX, scroll: el.scrollWidth > el.clientWidth }));
  expect(snap.type).toContain("x");
  expect(snap.type).toContain("mandatory");
  expect(snap.overflow).toBe("auto");
  expect(snap.scroll).toBe(true);
  const col = (await board.locator("section").first().boundingBox())!;
  expect(col.width).toBeLessThanOrEqual(390 * 0.86);
  await noSidewaysScroll("tasks board");
  await page.goto("/app/tasks");
  await expect(page.getByTestId("board")).toBeVisible();
  // Back to the List for the next person on this device.
  await page.locator('[data-testid="phone-select"][data-name="View"]').click();
  await page.getByTestId("picker-sheet").getByRole("radio", { name: "List" }).click();
  await page.goto("/app/tasks");
  await expect(page.getByTestId("phone-task-list")).toBeVisible({ timeout: 15_000 });
});

test("DF-10: goal key results stack on a phone instead of wrapping in a narrow column", async () => {
  const name = "Monthly recurring revenue from new paying workspaces in Australia and New Zealand";
  const r = await page.request.post("/api/goals", { data: { name: "Grow paid workspaces this quarter", keyResults: [{ name, kind: "currency", start: 0, target: 20000, current: 6500 }] }, headers: headers() });
  expect(r.status()).toBe(201);
  await page.goto("/app/goals");
  const kr = page.getByTestId("key-result-name").filter({ hasText: name });
  await expect(kr).toBeVisible();
  const box = (await kr.boundingBox())!;
  const lineHeight = await kr.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20);
  // Full width of the card, so the name takes two lines at most (it took four before).
  expect(box.width).toBeGreaterThan(280);
  expect(Math.round(box.height / lineHeight)).toBeLessThanOrEqual(2);
  await noSidewaysScroll("goals");
});

test("DF-10: the chat composer has no keyboard hints on a phone and a real project key as its sample", async () => {
  const projects = (await (await page.request.get("/api/projects")).json()).projects as { key: string; archived: boolean }[];
  const key = projects.find((p) => !p.archived)?.key;
  expect(key).toBeTruthy();
  await page.goto("/app/chat");
  const channel = page.getByRole("link", { name: /general/ }).first();
  if (await channel.isVisible().catch(() => false)) await channel.click();
  const hint = page.getByTestId("composer-hint").first();
  await expect(hint).toBeVisible({ timeout: 15_000 });
  await expect(hint).not.toContainText("Enter");
  await expect(hint).not.toContainText("OPS-12");
  await expect(hint).toContainText(`${key}-1`);
  await noSidewaysScroll("chat");
  await page.screenshot({ path: `${SHOTS}/phone-chat.png` });
});

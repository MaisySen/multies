import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";

/**
 * R43 ui helper (MB-210): long lists render only the rows on screen. The Tasks list gets 5,000 tasks from a mocked
 * API (the demo's own first task, cloned), then the spec counts DOM nodes and times scroll frames, and checks that
 * keyboard moves, the sticky header, the inline Add task row and the phone card list still work.
 * MEASURE=before runs only the numbers against a build of main; numbers land in /home/user/tab/files/multies-r43/.
 * SHOTS=before or SHOTS=after saves screenshots there too.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.143.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(180_000);

const LABEL = process.env.MEASURE === "before" ? "before" : "after";
const AFTER = LABEL === "after";
const DIR = "/home/user/tab/files/multies-r43";
const N = 5000;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}

/** Answers the task list with N clones of the first real task, so every field has the real shape. */
async function manyTasks(page: Page) {
  await page.route(/\/api\/tasks(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const body = await res.json() as { tasks: Record<string, unknown>[] };
    const base = body.tasks[0];
    if (!base) return route.fulfill({ response: res });
    const key = String(base.ref ?? "T-1").split("-")[0];
    const tasks = Array.from({ length: N }, (_, i) => ({ ...base, id: `r43_${i}`, ref: `${key}-${i + 1}`, number: i + 1, title: `Long list task ${i + 1}`, position: i }));
    await route.fulfill({ response: res, json: { ...body, tasks } });
  });
}

async function frameStats(page: Page, target: "grid" | "window") {
  return page.evaluate(async (t) => {
    const el = t === "grid" ? document.querySelector<HTMLElement>("[data-testid=task-table]") : null;
    const max = el ? el.scrollHeight - el.clientHeight : document.documentElement.scrollHeight - innerHeight;
    const deltas: number[] = [];
    let last = performance.now();
    for (let i = 1; i <= 90; i++) {
      const y = Math.round((max * i) / 90);
      if (el) el.scrollTop = y; else window.scrollTo(0, y);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const now = performance.now();
      deltas.push(now - last);
      last = now;
    }
    deltas.sort((a, b) => a - b);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    return { frames: deltas.length, meanMs: +mean.toFixed(1), p95Ms: +deltas[Math.floor(deltas.length * 0.95)].toFixed(1), maxMs: +deltas[deltas.length - 1].toFixed(1) };
  }, target);
}
const nodes = (page: Page) => page.evaluate(() => document.querySelectorAll("*").length);
function save(name: string, data: unknown) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(`${DIR}/mb210-${name}-${LABEL}.json`, JSON.stringify(data, null, 2));
}

test("5,000 task desktop list: DOM size, scroll frames, keyboard and sticky header", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(page);
  await manyTasks(page);
  const t0 = Date.now();
  await page.goto("/app/tasks?view=list");
  const grid = page.getByTestId("task-table");
  await expect(grid).toBeVisible({ timeout: 60_000 });
  await expect(grid.locator("tr[data-task-id]").first()).toBeVisible({ timeout: 60_000 });
  const firstPaintMs = Date.now() - t0;
  const rows = await grid.locator("tr[data-task-id]").count();
  const domNodes = await nodes(page);
  const frames = await frameStats(page, "grid");
  save("desktop-list", { tasks: N, renderedRows: rows, domNodes, listVisibleMs: firstPaintMs, scroll: frames });
  if (process.env.SHOTS) await page.screenshot({ path: `${DIR}/mb210-${LABEL}-tasks-list-5000-desktop-light.png` });
  if (!AFTER) return;

  expect(rows).toBeLessThan(120);
  expect(domNodes).toBeLessThan(6000);
  await expect(grid).toHaveAttribute("aria-rowcount", String(N + 1));
  // Scrolled to the bottom, the last task is rendered and the header is still pinned.
  await expect(grid.locator("tr[data-task-id]").last()).toContainText(`Long list task ${N}`);
  await expect(grid.locator("thead th").nth(1)).toBeInViewport();
  // Back to the top, then 60 ArrowDowns: the focused row is rendered and on screen.
  await grid.evaluate((el) => { el.scrollTop = 0; });
  await grid.focus();
  for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowDown");
  const focused = grid.locator("tr[data-win-row='60']");
  await expect(focused).toBeVisible();
  await expect(focused).toBeInViewport();
  await expect(focused).toHaveAttribute("aria-rowindex", "62");
  // J over the page (R31 task focus) walks past the rendered window: the focused row is brought in with its ring.
  await page.keyboard.press("Escape");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await grid.evaluate((el) => { el.scrollTop = 0; (document.activeElement as HTMLElement | null)?.blur(); });
  for (let i = 0; i < 45; i++) await page.keyboard.press("j");
  const ring = page.locator("[data-kb-focus]");
  await expect(ring).toHaveCount(1);
  await expect(ring).toBeInViewport();
  const at = Number(await ring.getAttribute("data-win-row"));
  expect(at).toBeGreaterThan(30);
  // The R42 inline Add task row still sits at the foot of the list.
  await expect(page.getByRole("button", { name: /add task/i }).last()).toBeVisible();
});

test("5,000 task phone list: card rows are windowed and the end is reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await manyTasks(page);
  await page.goto("/app/tasks?view=list");
  const list = page.getByTestId("phone-task-list");
  await expect(list).toBeVisible({ timeout: 60_000 });
  await expect(list.getByTestId("phone-task-row").first()).toBeVisible({ timeout: 60_000 });
  const rows = await list.getByTestId("phone-task-row").count();
  const domNodes = await nodes(page);
  const frames = await page.evaluate(async () => {
    // The phone list scrolls with its page box; find it the way the hook does.
    let box: HTMLElement | null = document.querySelector("[data-testid=phone-task-list]");
    while (box && box !== document.body) { const o = getComputedStyle(box).overflowY; if ((o === "auto" || o === "scroll") && box.scrollHeight > box.clientHeight + 1) break; box = box.parentElement; }
    const el = box && box !== document.body ? box : null;
    const max = el ? el.scrollHeight - el.clientHeight : document.documentElement.scrollHeight - innerHeight;
    const deltas: number[] = [];
    let last = performance.now();
    for (let i = 1; i <= 90; i++) {
      const y = Math.round((max * i) / 90);
      if (el) el.scrollTop = y; else window.scrollTo(0, y);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const now = performance.now(); deltas.push(now - last); last = now;
    }
    deltas.sort((a, b) => a - b);
    return { frames: 90, meanMs: +(deltas.reduce((a, b) => a + b, 0) / 90).toFixed(1), p95Ms: +deltas[85].toFixed(1), maxMs: +deltas[89].toFixed(1) };
  });
  save("phone-list", { tasks: N, renderedRows: rows, domNodes, scroll: frames });
  if (process.env.SHOTS) await page.screenshot({ path: `${DIR}/mb210-${LABEL}-tasks-list-5000-phone-light.png` });
  if (!AFTER) return;

  expect(rows).toBeLessThan(80);
  await expect(list.getByTestId("phone-task-row").last()).toContainText(`Long list task ${N}`);
  await expect(list.locator("li[data-win-row]").last()).toHaveAttribute("aria-setsize", String(N));
});

test("3,000 message mail list: rows are windowed and the end is reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(page);
  const M = 3000;
  await page.route(/\/api\/mail\/messages\?/, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("cursor") || url.searchParams.get("q")) return route.fallback();
    const res = await route.fetch();
    const body = await res.json() as { messages: Record<string, unknown>[]; nextCursor: string | null };
    const base = body.messages[0];
    if (!base) return route.fulfill({ response: res });
    const messages = Array.from({ length: M }, (_, i) => ({ ...base, id: `r43m_${i}`, threadId: `r43t_${i}`, subject: `Long list mail ${i + 1}` }));
    await route.fulfill({ response: res, json: { ...body, messages, nextCursor: null } });
  });
  await page.goto("/app/mail");
  const rowsL = page.getByTestId("mail-row");
  await expect(rowsL.first()).toBeVisible({ timeout: 60_000 });
  const rows = await rowsL.count();
  const domNodes = await nodes(page);
  const frames = await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>("[data-mail-list]")!;
    const max = el.scrollHeight - el.clientHeight;
    const deltas: number[] = [];
    let last = performance.now();
    for (let i = 1; i <= 90; i++) {
      el.scrollTop = Math.round((max * i) / 90);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const now = performance.now(); deltas.push(now - last); last = now;
    }
    deltas.sort((a, b) => a - b);
    return { frames: 90, meanMs: +(deltas.reduce((a, b) => a + b, 0) / 90).toFixed(1), p95Ms: +deltas[85].toFixed(1), maxMs: +deltas[89].toFixed(1) };
  });
  save("mail-list", { messages: M, renderedRows: rows, domNodes, scroll: frames });
  if (process.env.SHOTS) await page.screenshot({ path: `${DIR}/mb210-${LABEL}-mail-list-3000-desktop-light.png` });
  if (!AFTER) return;

  expect(rows).toBeLessThan(80);
  await expect(rowsL.last()).toContainText(`Long list mail ${M}`);
  await expect(rowsL.last()).toHaveAttribute("aria-setsize", String(M));
});

test("5,000 task board: a column renders 100 cards and Show more adds the next 100", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(page);
  await manyTasks(page);
  const t0 = Date.now();
  await page.goto("/app/tasks?view=board");
  const board = page.getByTestId("board");
  await expect(board).toBeVisible({ timeout: 60_000 });
  await expect(board.getByText("Long list task 1", { exact: true })).toBeVisible({ timeout: 60_000 });
  const boardVisibleMs = Date.now() - t0;
  const cards = await board.getByText(/^Long list task \d+$/).count();
  const domNodes = await nodes(page);
  save("board", { tasks: N, renderedCards: cards, domNodes, boardVisibleMs });
  if (process.env.SHOTS) await page.screenshot({ path: `${DIR}/mb210-${LABEL}-board-5000-desktop-light.png` });
  if (!AFTER) return;

  expect(cards).toBe(100);
  expect(domNodes).toBeLessThan(12000);
  const more = board.getByTestId("board-show-more");
  await expect(more).toContainText("Show 100 more");
  await expect(more).toContainText("4,900 left");
  await more.click();
  await expect(board.getByText(/^Long list task \d+$/)).toHaveCount(200);
  await expect(board.getByText("Long list task 200", { exact: true })).toBeAttached();
});

for (const scheme of ["light", "dark"] as const) {
  test(`shots: 5,000 tasks list and board, desktop and phone (${scheme})`, async ({ page }) => {
    test.skip(!process.env.SHOTS, "screenshots only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await demo(page);
    await manyTasks(page);
    await page.goto("/app/tasks?view=board");
    await expect(page.getByTestId("board").getByText("Long list task 1", { exact: true })).toBeVisible({ timeout: 60_000 });
    const more = page.getByTestId("board-show-more");
    if (await more.count()) await more.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${DIR}/board-${LABEL}-5000-desktop-${scheme}.png` });
    await page.goto("/app/tasks?view=list");
    await expect(page.getByTestId("task-table").locator("tr[data-task-id]").first()).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("task-table").evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${DIR}/tasks-${LABEL}-list-5000-desktop-${scheme}.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/app/tasks?view=list");
    await expect(page.getByTestId("phone-task-row").first()).toBeVisible({ timeout: 60_000 });
    await page.mouse.wheel(0, 20000);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${DIR}/tasks-${LABEL}-list-5000-phone-${scheme}.png` });
    await page.goto("/app/tasks?view=board");
    await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
    if (await more.count()) await more.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${DIR}/board-${LABEL}-5000-phone-${scheme}.png` });
  });
}

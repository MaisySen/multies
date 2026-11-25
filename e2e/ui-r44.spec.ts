import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R44 ui helper (MB-210 follow ups): a board column with 5,000 cards and a backlog with 5,000 rows render only what
 * is on screen. Mocked API like ui-r43: the demo's first task cloned 5,000 times (one status, so one column), and a
 * mocked sprint list with one planned sprint plus a 5,000 row backlog with 1 to 3 points each.
 * MEASURE=before only takes the numbers (run against a build of main); SHOTS=before|after saves screenshots.
 * Numbers land in SHOTS_ROOT/multies-r44/.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.144.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(240_000);

const LABEL = process.env.MEASURE === "before" ? "before" : "after";
const AFTER = LABEL === "after";
const DIR = `${SHOTS_ROOT}/multies-r44`;
const N = 5000;
const pts = (i: number) => (i % 3) + 1;
const FULL_POINTS = Array.from({ length: N }, (_, i) => pts(i)).reduce((a, b) => a + b, 0);

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}

async function manyTasks(page: Page) {
  await page.route(/\/api\/tasks(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const body = await res.json().catch(() => null) as { tasks: Record<string, unknown>[] } | null;
    if (!body) return route.fallback().catch(() => {}); // the page moved on and the response went with it
    const base = body.tasks[0];
    if (!base) return route.fulfill({ response: res });
    const key = String(base.ref ?? "T-1").split("-")[0];
    const tasks = Array.from({ length: N }, (_, i) => ({ ...base, id: `r44_${i}`, ref: `${key}-${i + 1}`, number: i + 1, title: `Long list task ${i + 1}`, position: i }));
    await route.fulfill({ response: res, json: { ...body, tasks } });
  });
}

const SPRINT = { id: "r44_sprint", name: "Sprint 44", status: "planned", goal: null, startAt: "2026-10-26T00:00:00.000Z", endAt: "2026-11-08T23:59:59.000Z", carriedOver: 0 };
async function bigBacklog(page: Page) {
  const moved: string[][] = [];
  let base: Record<string, unknown> | null = null;
  await page.route(/\/api\/tasks(\?[^/]*)?$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json().catch(() => null) as { tasks: Record<string, unknown>[] } | null;
    if (!body) return route.fallback().catch(() => {}); // the page moved on and the response went with it
    base = body.tasks[0] ?? null;
    await route.fulfill({ response: res });
  });
  await page.route(/\/api\/sprints\?/, (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { sprints: [SPRINT], unit: "points" } }) : route.fallback());
  await page.route(/\/api\/sprints\/r44_sprint(\?.*)?$/, (route) => route.fulfill({ json: { sprint: SPRINT, unit: "points", tasks: [],
    burndown: { unit: "points", timeZone: "UTC", start: 0, days: [], scope: 0, done: 0, remaining: 0 } } }));
  await page.route(/\/api\/sprints\/r44_sprint\/tasks$/, async (route) => {
    moved.push((route.request().postDataJSON() as { taskIds: string[] }).taskIds);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/sprints\/backlog\?/, async (route) => {
    const res = await route.fetch();
    const body = await res.json().catch(() => null) as { tasks: Record<string, unknown>[] } | null;
    if (!body) return route.fallback().catch(() => {}); // the page moved on and the response went with it
    const b = body.tasks[0] ?? base ?? { status: "todo", statusName: "To do", type: "task" };
    const tasks = Array.from({ length: N }, (_, i) => ({ ...b, id: `r44b_${i}`, ref: `B-${i + 1}`, number: i + 1, title: `Backlog task ${i + 1}`, points: pts(i), status: "todo", position: i }));
    await route.fulfill({ response: res, json: { ...body, tasks } });
  });
  return moved;
}

async function frames(page: Page, el: Locator | null) {
  const run = async (boxEl: Element | null) => {
    const box = boxEl as HTMLElement | null;
    const max = box ? box.scrollHeight - box.clientHeight : document.documentElement.scrollHeight - innerHeight;
    const d: number[] = [];
    let last = performance.now();
    for (let i = 1; i <= 90; i++) {
      const y = Math.round((max * i) / 90);
      if (box) box.scrollTop = y; else window.scrollTo(0, y);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const now = performance.now(); d.push(now - last); last = now;
    }
    d.sort((a, b) => a - b);
    return { frames: 90, meanMs: +(d.reduce((a, b) => a + b, 0) / 90).toFixed(1), p95Ms: +d[85].toFixed(1), maxMs: +d[89].toFixed(1), scrollMax: max };
  };
  if (el) return el.evaluate(run);
  return page.evaluate(run, null);
}
/** A person scrolling: 120 frames of 100 px each from the top (a trackpad flick), frame times. */
async function stepFrames(page: Page, el: Locator | null) {
  const run = async (boxEl: Element | null) => {
    const box = boxEl as HTMLElement | null;
    if (box) box.scrollTop = 0; else window.scrollTo(0, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    const d: number[] = [];
    let last = performance.now();
    for (let i = 1; i <= 120; i++) {
      if (box) box.scrollTop = i * 100; else window.scrollTo(0, i * 100);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const now = performance.now(); d.push(now - last); last = now;
    }
    d.sort((a, b) => a - b);
    return { frames: 120, stepPx: 100, meanMs: +(d.reduce((a, b) => a + b, 0) / 120).toFixed(1), p95Ms: +d[113].toFixed(1), maxMs: +d[119].toFixed(1) };
  };
  if (el) return el.evaluate(run);
  return page.evaluate(run, null);
}
/** The nearest box that scrolls vertically, the way the windowing hook finds it. */
async function scroller(page: Page, sel: string) {
  await page.evaluate((s) => {
    for (const e of document.querySelectorAll("[data-r44-scroller]")) e.removeAttribute("data-r44-scroller");
    let b: HTMLElement | null = document.querySelector(s);
    while (b && b !== document.body) { const o = getComputedStyle(b).overflowY; if ((o === "auto" || o === "scroll") && b.scrollHeight > b.clientHeight + 1) break; b = b.parentElement; }
    if (b && b !== document.body) b.setAttribute("data-r44-scroller", "");
  }, sel);
  const l = page.locator("[data-r44-scroller]");
  return (await l.count()) ? l : null;
}
const nodes = (page: Page) => page.evaluate(() => document.querySelectorAll("*").length);
function save(name: string, data: unknown) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(`${DIR}/windowing-${name}-${LABEL}.json`, JSON.stringify(data, null, 2));
}

test("5,000 card board column: small DOM, the last card, keyboard, drag between columns", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(page);
  await manyTasks(page);
  const t0 = Date.now();
  await page.goto("/app/tasks?view=board");
  const board = page.getByTestId("board");
  await expect(board.getByText("Long list task 1", { exact: true })).toBeVisible({ timeout: 60_000 });
  const boardVisibleMs = Date.now() - t0;
  const cards = await board.getByText(/^Long list task \d+$/).count();
  const domNodes = await nodes(page);
  const box = await scroller(page, "[data-testid=board-card]");
  const scroll = await frames(page, box);
  const steps = await stepFrames(page, box);
  save("board", { tasks: N, renderedCards: cards, domNodes, boardVisibleMs, scrollJumps: scroll, scrollSteps: steps });
  if (process.env.SHOTS) await page.screenshot({ path: `${DIR}/board-${LABEL}-5000-desktop-light.png` });
  if (!AFTER) return;

  expect(cards).toBeLessThan(80);
  expect(domNodes).toBeLessThan(4000);
  const col = board.locator("section").filter({ has: page.getByTestId("board-card") }).first();
  await expect(col.getByTestId("column-count")).toHaveText(/^5,?000/);
  await expect(board.getByTestId("board-show-more")).toHaveCount(0);
  // Scrolled to the end: the last card is there, and so is the composer at the foot of the column.
  // Measured card heights can grow the column while it scrolls, so keep going to the end the way a person would.
  await expect.poll(async () => {
    if (box) await box.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    return col.locator(`[aria-posinset="${N}"]`).first().isVisible();
  }, { timeout: 15_000 }).toBe(true);
  await expect(col.getByRole("button", { name: /add task/i }).last()).toBeVisible();
  // J walks the full list: past the rendered window the focused card is brought in with its ring.
  if (box) await box.evaluate((el) => { el.scrollTop = 0; });
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 60; i++) await page.keyboard.press("j");
  const ring = page.locator("[data-kb-focus]");
  await expect(ring).toHaveCount(1);
  await expect(ring).toBeInViewport();
  expect(Number(await ring.getAttribute("data-win-row"))).toBeGreaterThan(40);
  await page.keyboard.press("Escape");
  // Drag a card from the 5,000 card column into the next column: the move goes to the server for that card.
  if (box) await box.evaluate((el) => { el.scrollTop = 0; });
  const target = board.locator("section").filter({ hasNot: page.getByText("Long list task 1", { exact: true }) }).first();
  const card = col.getByTestId("board-card").first();
  await expect(card).toBeInViewport();
  await page.waitForTimeout(200);
  const id = await card.getAttribute("data-task-id");
  const req = page.waitForRequest((r) => r.method() !== "GET" && r.url().includes(`/api/tasks/${id}`), { timeout: 15_000 });
  const a = (await card.boundingBox())!;
  const b = (await target.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + 12);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + 20, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 80, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  const sent = await req;
  expect(JSON.stringify(sent.postDataJSON() ?? {})).toMatch(/status|position/);
});

test("5,000 row backlog: windowed rows, full points total, drag into the sprint", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(page);
  const moved = await bigBacklog(page);
  const t0 = Date.now();
  await page.goto("/app/tasks?view=sprints");
  const panel = page.getByRole("region", { name: "Backlog" }).or(page.locator("[aria-label=Backlog]")).first();
  await expect(panel.getByText("Backlog task 1", { exact: true })).toBeVisible({ timeout: 60_000 });
  const backlogVisibleMs = Date.now() - t0;
  const rows = await panel.getByText(/^Backlog task \d+$/).count();
  const domNodes = await nodes(page);
  const box = await scroller(page, "[aria-label='Backlog tasks']");
  const scroll = await frames(page, box);
  const steps = await stepFrames(page, box);
  save("backlog", { tasks: N, renderedRows: rows, domNodes, backlogVisibleMs, scrollJumps: scroll, scrollSteps: steps });
  if (process.env.SHOTS) await page.screenshot({ path: `${DIR}/backlog-${LABEL}-5000-desktop-light.png` });
  if (!AFTER) return;

  expect(rows).toBeLessThan(120);
  expect(domNodes).toBeLessThan(4000);
  await expect(panel).toContainText(`5,000 tasks, ${FULL_POINTS} pt`); // W4: counts show a thousands separator
  await expect.poll(async () => {
    if (box) await box.evaluate((el) => { el.scrollTop = el.scrollHeight; }); else await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    return panel.getByText(`Backlog task ${N}`, { exact: true }).isVisible();
  }, { timeout: 15_000 }).toBe(true);
  await expect(panel.locator("li[data-win-row]").last()).toHaveAttribute("aria-setsize", String(N));
  // Drag a backlog row onto the sprint list: it is moved into the sprint.
  if (box) await box.evaluate((el) => { el.scrollTop = 0; }); else await page.evaluate(() => window.scrollTo(0, 0));
  const row = panel.getByTestId("backlog-row").first();
  const drop = page.getByTestId("sprint-drop");
  await expect(row).toContainText("Backlog task 1");
  await row.dragTo(drop);
  await expect.poll(() => moved.flat()).toContain("r44b_0");
  // Select three rows with Shift, then move them together.
  await panel.getByTestId("backlog-row").nth(1).getByRole("checkbox").check();
  await panel.getByTestId("backlog-row").nth(3).getByRole("checkbox").click({ modifiers: ["Shift"] });
  await expect(panel.getByText("3 selected")).toBeVisible();
  await page.getByRole("button", { name: /move 3 to sprint 44/i }).click();
  await expect.poll(() => moved.at(-1)).toEqual(["r44b_1", "r44b_2", "r44b_3"]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`shots: 5,000 card board and backlog, desktop and phone (${scheme})`, async ({ page }) => {
    test.skip(!process.env.SHOTS, "screenshots only");
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h, kind] of [[1280, 800, "desktop"], [390, 844, "phone"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.context().clearCookies();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await demo(page);
      await manyTasks(page);
      await page.goto("/app/tasks?view=board");
      await expect(page.getByTestId("board").getByText("Long list task 1", { exact: true })).toBeVisible({ timeout: 60_000 });
      const box = await scroller(page, "[data-testid=board-card]");
      if (box) await box.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
      // Keep the page header in view and bring the 5,000 card column on screen (on a phone the columns swipe sideways).
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector("main")?.scrollTo({ top: 0 }); });
      const col = page.getByTestId("board").locator("section").filter({ has: page.getByTestId("board-card") }).first();
      await col.evaluate((el) => {
        let p = el.parentElement;
        while (p && p.scrollWidth <= p.clientWidth + 1) p = p.parentElement;
        if (p) p.scrollLeft = Math.max(0, (el as HTMLElement).offsetLeft - 16);
      });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/board-${LABEL}-5000-${kind}-${scheme}.png` });
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await bigBacklog(page);
      await page.goto("/app/tasks?view=sprints");
      await expect(page.getByText("Backlog task 1", { exact: true })).toBeVisible({ timeout: 60_000 });
      await page.getByText("Backlog task 1", { exact: true }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/backlog-${LABEL}-5000-${kind}-${scheme}.png` });
    }
  });
}

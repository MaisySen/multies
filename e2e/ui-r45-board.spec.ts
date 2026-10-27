import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";

/**
 * R45 board helper: the windowed board under jump scrolling, keyboard drag past the window, keyboard multi select and
 * Move to sprint in the backlog, and a board with swimlanes under load. Mocked API like ui-r44 (the demo's first task
 * cloned 5,000 times). MEASURE=before only takes the numbers (run against a build of main); RUN=<n> tags the files.
 * PROFILE=1 also writes a CPU profile summary of the jump scroll. Numbers land in /home/user/tab/files/multies-r45/.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.145.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(240_000);

const LABEL = process.env.MEASURE === "before" ? "before" : "after";
const AFTER = LABEL === "after";
const RUN = process.env.RUN ?? "0";
const DIR = "/home/user/tab/files/multies-r45";
const N = 5000;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}

/** 5,000 tasks cloned from the demo's first one. `lanes` spreads them over that many assignees (swimlanes). */
async function manyTasks(page: Page, opts: { statuses?: boolean } = {}) {
  await page.route(/\/api\/tasks(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const body = await res.json() as { tasks: Record<string, unknown>[] };
    const base = body.tasks[0];
    if (!base) return route.fulfill({ response: res });
    const key = String(base.ref ?? "T-1").split("-")[0];
    const statuses = opts.statuses ? [...new Set(body.tasks.map((t) => t.statusId as string))] : [base.statusId as string];
    const people = [...new Map(body.tasks.filter((t) => t.assignee).map((t) => [(t.assignee as { id: string }).id, t.assignee])).values()];
    const tasks = Array.from({ length: N }, (_, i) => ({ ...base, id: `r45_${i}`, ref: `${key}-${i + 1}`, number: i + 1, title: `Long list task ${i + 1}`, position: i,
      statusId: statuses[i % statuses.length], ...(opts.statuses && people.length ? { assignee: people[i % people.length] } : {}) }));
    await route.fulfill({ response: res, json: { ...body, tasks } });
  });
}

async function frames(el: Locator) {
  return el.evaluate(async (boxEl) => {
    const box = boxEl as HTMLElement;
    const max = box.scrollHeight - box.clientHeight;
    const d: number[] = [];
    let last = performance.now();
    for (let i = 1; i <= 90; i++) {
      box.scrollTop = Math.round((max * i) / 90);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const now = performance.now(); d.push(now - last); last = now;
    }
    const raw = [...d];
    // The frames right after the jump stops, when full cards come back (R45 light cards settle after 140 ms).
    const after: number[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const now = performance.now(); after.push(now - last); last = now;
    }
    d.sort((a, b) => a - b);
    return { settleMaxMs: +Math.max(...after).toFixed(1), frames: 90, meanMs: +(d.reduce((a, b) => a + b, 0) / 90).toFixed(1), p95Ms: +d[85].toFixed(1), maxMs: +d[89].toFixed(1), scrollMax: max, raw: raw.map((x) => +x.toFixed(1)) };
  });
}
async function stepFrames(el: Locator) {
  return el.evaluate(async (boxEl) => {
    const box = boxEl as HTMLElement;
    box.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    const d: number[] = [];
    let last = performance.now();
    for (let i = 1; i <= 120; i++) {
      box.scrollTop = i * 100;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const now = performance.now(); d.push(now - last); last = now;
    }
    d.sort((a, b) => a - b);
    return { frames: 120, stepPx: 100, meanMs: +(d.reduce((a, b) => a + b, 0) / 120).toFixed(1), p95Ms: +d[113].toFixed(1), maxMs: +d[119].toFixed(1) };
  });
}
/** The nearest box that scrolls vertically from a selector, the way the windowing hook finds it. */
async function scroller(page: Page, sel: string) {
  await page.evaluate((q) => {
    for (const e of document.querySelectorAll("[data-r45-scroller]")) e.removeAttribute("data-r45-scroller");
    let b: HTMLElement | null = document.querySelector(q);
    while (b && b !== document.body) { const o = getComputedStyle(b).overflowY; if ((o === "auto" || o === "scroll") && b.scrollHeight > b.clientHeight + 1) break; b = b.parentElement; }
    if (b && b !== document.body) b.setAttribute("data-r45-scroller", "");
  }, sel);
  return page.locator("[data-r45-scroller]").first();
}
const nodes = (page: Page) => page.evaluate(() => document.querySelectorAll("*").length);
function save(name: string, data: unknown) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(`${DIR}/board-r45-${name}-${LABEL}-run${RUN}.json`, JSON.stringify(data, null, 2));
}

/** CPU profile of a callback, summarised as self time per function (top 40) plus totals. */
async function profile(page: Page, name: string, fn: () => Promise<unknown>) {
  if (!process.env.PROFILE) return fn();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await cdp.send("Profiler.start");
  const out = await fn();
  const { profile: p } = await cdp.send("Profiler.stop") as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] }[]; samples: number[]; timeDeltas: number[] } };
  const self = new Map<number, number>();
  p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
  const byFn = new Map<string, number>();
  let total = 0;
  for (const n of p.nodes) {
    const us = self.get(n.id) ?? 0; total += us;
    const f = n.callFrame;
    const k = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
    byFn.set(k, (byFn.get(k) ?? 0) + us);
  }
  const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, us]) => `${(us / 1000).toFixed(1)} ms  ${k}`);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(`${DIR}/board-r45-profile-${name}-${LABEL}-run${RUN}.txt`, `total sampled ${(total / 1000).toFixed(0)} ms\n${top.join("\n")}\n`);
  await cdp.detach();
  return out;
}

async function openBoard(page: Page, opts: { statuses?: boolean } = {}) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(page);
  await manyTasks(page, opts);
  const t0 = Date.now();
  await page.goto("/app/tasks?view=board");
  const board = page.getByTestId("board");
  await expect(board.getByText("Long list task 1", { exact: true })).toBeVisible({ timeout: 60_000 });
  return { board, visibleMs: Date.now() - t0 };
}

test("board jump scroll over a 5,000 card column stays near two frames", async ({ page }) => {
  const { visibleMs } = await openBoard(page);
  const col = await scroller(page, "[data-testid=board-card]");
  const domNodes = await nodes(page);
  // Warm up once (first measurements of every card), then measure.
  await frames(col);
  const jump = await profile(page, "jump", () => frames(col)) as Awaited<ReturnType<typeof frames>>;
  const steps = await stepFrames(col);
  save("jump", { tasks: N, domNodes, boardVisibleMs: visibleMs, jump, steps });
  if (!AFTER) return;
  expect(jump.scrollMax).toBeGreaterThan(300_000);
  expect(jump.p95Ms).toBeLessThan(60);
});

test("keyboard drag past the window scrolls the column, keeps the card in hand and drops it in place", async ({ page }) => {
  const { board } = await openBoard(page);
  const col = await scroller(page, "[data-testid=board-card]");
  const moves: { id: string; body: Record<string, unknown> }[] = [];
  await page.route(/\/api\/tasks\/r45_\d+$/, async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    moves.push({ id: route.request().url().split("/").pop()!, body: route.request().postDataJSON() as Record<string, unknown> });
    await route.fulfill({ json: { ok: true } });
  });
  const grip = board.getByRole("button", { name: "Move Long list task 3", exact: true });
  await grip.focus();
  await page.keyboard.press("Space");
  const steps = 40; // the window holds about 20 cards: this walks the card well past it
  const trace: string[] = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120); // the column scrolls smoothly after each step
    if (process.env.DEBUG_KB) trace.push(await col.evaluate((el) => `${el.scrollTop} ${(el.querySelector('[data-task-id="r45_2"]') as HTMLElement | null)?.style.transform}`));
  }
  if (process.env.DEBUG_KB) fs.writeFileSync("/tmp/r45-board-kb.txt", trace.join("\n"));
  // Still in hand: the card being dragged is in the DOM, and the column scrolled down with it, past the first window.
  expect(await col.evaluate((el) => el.scrollTop)).toBeGreaterThan(3000);
  await expect(board.locator('[data-task-id="r45_2"]')).toHaveCount(1);
  // ...and it is on screen inside the column: before R45 it was remounted at the window's edge and left behind.
  const inView = await col.evaluate((el) => {
    const a = el.querySelector('[data-task-id="r45_2"]')!.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return a.bottom > b.top && a.top < b.bottom;
  });
  expect(inView).toBe(true);
  // The screen reader is told which card it is over; the drop must land right after that card.
  const said = await page.locator("[id^=DndLiveRegion]").last().textContent() ?? "";
  const over = Number(/over droppable area r45_(\d+)/.exec(said)?.[1] ?? -1);
  expect(over).toBeGreaterThan(30);
  await page.keyboard.press("Space");
  await expect.poll(() => moves.length, { timeout: 10_000 }).toBe(1);
  expect(moves[0].id).toBe("r45_2");
  const pos = Number(moves[0].body.position);
  expect(pos).toBeGreaterThan(over);
  expect(pos).toBeLessThan(over + 1);
});

const SPRINT = { id: "r45_sprint", name: "Sprint 45", status: "planned", goal: null, startAt: "2026-10-26T00:00:00.000Z", endAt: "2026-11-08T23:59:59.000Z", carriedOver: 0 };
const SPRINT_B = { ...SPRINT, id: "r45_sprint_b", name: "Sprint 46" };
async function bigBacklog(page: Page) {
  const moved: { to: string; ids: string[] }[] = [];
  await page.route(/\/api\/sprints\?/, (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { sprints: [SPRINT, SPRINT_B], unit: "points" } }) : route.fallback());
  await page.route(/\/api\/sprints\/r45_sprint(_b)?(\?.*)?$/, (route) => route.fulfill({ json: { sprint: route.request().url().includes("_b") ? SPRINT_B : SPRINT, unit: "points", tasks: [],
    burndown: { unit: "points", timeZone: "UTC", start: 0, days: [], scope: 0, done: 0, remaining: 0 } } }));
  await page.route(/\/api\/sprints\/(r45_sprint(_b)?)\/tasks$/, async (route) => {
    moved.push({ to: route.request().url().split("/").at(-2)!, ids: (route.request().postDataJSON() as { taskIds: string[] }).taskIds });
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/sprints\/backlog\?/, async (route) => {
    const res = await route.fetch();
    const body = await res.json() as { tasks: Record<string, unknown>[] };
    const b = body.tasks[0] ?? { status: "todo", statusName: "To do", type: "task" };
    const tasks = Array.from({ length: N }, (_, i) => ({ ...b, id: `r45b_${i}`, ref: `B-${i + 1}`, number: i + 1, title: `Backlog task ${i + 1}`, points: (i % 3) + 1, status: "todo", position: i }));
    await route.fulfill({ response: res, json: { ...body, tasks } });
  });
  return moved;
}

test("backlog keyboard: Shift with arrows selects, Space toggles, Escape clears, M moves to a sprint", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(page);
  const moved = await bigBacklog(page);
  await page.goto("/app/tasks?view=sprints");
  const panel = page.locator("[aria-label=Backlog]").first();
  await expect(panel.getByText("Backlog task 1", { exact: true })).toBeVisible({ timeout: 60_000 });
  const live = panel.getByTestId("backlog-live");
  await panel.getByRole("checkbox", { name: "Select Backlog task 2", exact: true }).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowDown");
  await expect(panel.getByRole("toolbar").getByText(/^4 selected/)).toBeVisible();
  await expect(live).toHaveText("4 selected, 8 pt, of 5000");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(panel.getByRole("toolbar").getByText(/^3 selected/)).toBeVisible();
  // Space on the focused row takes it out again, Escape clears everything.
  await page.keyboard.press("Space");
  await expect(panel.getByRole("toolbar").getByText(/^2 selected/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("toolbar")).toHaveCount(0);
  // Walk far past the rendered window with the keyboard, then select a run there and move it with M.
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowDown");
  await expect(page.locator(":focus")).toHaveAttribute("aria-label", "Select Backlog task 44");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(panel.getByRole("toolbar").getByText(/^3 selected/)).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: `${DIR}/backlog-after-keyboard-select-desktop-light.png` });
  await page.keyboard.press("m");
  const menu = page.getByTestId("backlog-move-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /Sprint 46/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => moved.at(-1)).toEqual({ to: "r45_sprint_b", ids: ["r45b_43", "r45b_44", "r45b_45"] });
  await expect(menu).toHaveCount(0);
  // Escape closes the menu and gives the row its focus back.
  await page.keyboard.press("m");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.locator(":focus")).toHaveAttribute("data-backlog-check", "");
});

test("swimlanes under load: 5,000 tasks across lanes and columns stay light", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(page);
  await manyTasks(page, { statuses: true });
  await page.goto("/app/tasks?view=board");
  await expect(page.getByTestId("board").getByText("Long list task 1", { exact: true })).toBeVisible({ timeout: 60_000 });
  const t0 = Date.now();
  await page.getByTestId("swimlanes-select").selectOption("assignee");
  const lanes = page.getByTestId("lane-board");
  await expect(lanes.getByText("Long list task 1", { exact: true })).toBeVisible({ timeout: 60_000 });
  const visibleMs = Date.now() - t0;
  const laneCount = await lanes.getByTestId("lane").count();
  const cells = await lanes.getByTestId("lane-cell").count();
  const cards = await lanes.getByTestId("board-card").count();
  const domNodes = await nodes(page);
  const box = await scroller(page, "[data-testid=lane-board] [data-testid=board-card]");
  const jump = await profile(page, "lanes-jump", () => frames(box)) as Awaited<ReturnType<typeof frames>>;
  const steps = await stepFrames(box);
  save("lanes", { tasks: N, lanes: laneCount, cells, renderedCards: cards, domNodes, lanesVisibleMs: visibleMs, jump, steps });
  // Put the board back to no lanes for later specs on this server.
  await page.getByTestId("swimlanes-select").selectOption("none").catch(() => {});
  if (!AFTER) return;
  expect(laneCount).toBeGreaterThan(1);
  expect(domNodes).toBeLessThan(20_000);
});

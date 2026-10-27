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

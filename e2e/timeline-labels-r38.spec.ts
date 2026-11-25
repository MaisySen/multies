import { test, expect, type Page } from "@playwright/test";

/**
 * R38 owner feedback "looks cut off": no timeline bar label is cut. A name that does not fit inside its bar sits to the
 * right of the bar; the key alone goes inside only when it fits; no ellipsis anywhere in a bar. The task column wraps
 * names to 2 lines and its width, changed by dragging the divider, is remembered per device.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.38.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page, width = 1440) {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
const day = (n: number) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function seed(page: Page) {
  const headers = { origin: new URL(page.url()).origin };
  const project = (await (await page.request.post("/api/projects", { headers, data: { name: "Label check", key: "LBL" } })).json()).project as { id: string };
  const mk = async (title: string, s: number, e: number) => (await (await page.request.post("/api/tasks", { headers, data: { projectId: project.id, title, start: day(s), due: day(e) } })).json()).task as { id: string };
  await mk("Write the launch announcement for the customer newsletter", 0, 0); // one day bar, long name
  await mk("Design the pricing page", 1, 2);
  await mk("Ship", 3, 12); // long bar, short name: fits inside
  await mk("Send Priya the retention numbers from the quarterly review deck", 2, 5);
  return project;
}

/** Every bar label: the inside text fits its bar, no text ends in an ellipsis, and a name that does not fit is drawn outside. */
async function checkLabels(page: Page) {
  const labels = page.getByTestId("timeline-bar-label");
  await expect(labels.first()).toBeVisible();
  const report = await labels.evaluateAll((els) => els.map((el) => {
    const bar = el.closest(".wx-bar") as HTMLElement | null;
    const inside = el.querySelector(".mm-bar-in:not(.mm-bar-measure)") as HTMLElement | null;
    const out = el.querySelector(".mm-bar-out") as HTMLElement | null;
    const name = el.getAttribute("data-name") ?? "";
    const shown = `${inside?.textContent ?? ""} ${out?.textContent ?? ""}`;
    return {
      name, mode: el.getAttribute("data-mode"),
      insideFits: !inside || !bar || inside.offsetWidth <= bar.clientWidth,
      ellipsis: /\u2026|\.\.\.$/.test(shown.trim()),
      whole: (inside?.textContent ?? "") === name || shown.replace(/\s+/g, " ").trim() === name || (out?.textContent ?? "") === name,
    };
  }));
  expect(report.length).toBeGreaterThan(0);
  for (const r of report) {
    expect(r.insideFits, `inside label fits its bar: ${r.name}`).toBe(true);
    expect(r.ellipsis, `no ellipsis: ${r.name}`).toBe(false);
    expect(r.whole, `whole name shown: ${r.name}`).toBe(true);
  }
  return report;
}

test("timeline: no bar label is cut, and the task column wraps and remembers its width", async ({ page }) => {
  test.setTimeout(120_000);
  await demo(page);
  const project = await seed(page);
  await page.goto(`/app/tasks?view=timeline&project=${project.id}`);
  const report = await checkLabels(page);
  expect(report.find((r) => r.name.startsWith("LBL-3"))?.mode).toBe("full"); // "Ship" fits inside its long bar
  expect(report.find((r) => r.name.startsWith("LBL-1"))?.mode).not.toBe("full"); // the long name on a one day bar sits outside

  // Task column: the long name wraps (no single line ellipsis) and the full name is on hover.
  const cell = page.getByTestId("timeline-name-cell").filter({ hasText: "quarterly review deck" });
  await expect(cell).toHaveAttribute("title", "LBL-4 Send Priya the retention numbers from the quarterly review deck");
  const lines = await cell.locator(".mm-name-text").evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines).toBeLessThanOrEqual(2);

  // Drag the divider wider; the width is remembered after a reload.
  const resizer = page.locator(".mm-gantt .wx-resizer").first();
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 40);
  await page.mouse.down();
  await page.mouse.move(box!.x + 120, box!.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem("multies-timeline-grid-w")))).toBeGreaterThan(400);
  const saved = await page.evaluate(() => Number(localStorage.getItem("multies-timeline-grid-w")));
  await page.reload();
  await expect(page.getByTestId("timeline-bar-label").first()).toBeVisible();
  const after = await page.locator(".mm-gantt .wx-resizer").first().boundingBox();
  expect(Math.abs(after!.x - (box!.x + 120))).toBeLessThan(40);
  expect(saved).toBeGreaterThan(400);
  await checkLabels(page);
});

test("timeline on a phone: labels sit beside short bars, none cut", async ({ page }) => {
  test.setTimeout(120_000);
  await demo(page, 390);
  const project = await seed(page);
  await page.goto(`/app/tasks?view=timeline&project=${project.id}`);
  await page.getByTestId("timeline-show-chart").click(); // W4: a phone opens the timeline as a list by week; the chart is a tap away
  await checkLabels(page);
});

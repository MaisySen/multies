import { test, expect, type Page } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R39 timeline polish:
 * - an outside bar label that would run past the chart's right edge flips to the left of its bar;
 * - a days off picker (7 day toggles) in the project's schedule rules, shaded days off on the chart;
 * - the lead or lag on a link is drawn on the chart: a dashed gap in the waiting task's row with a "+2d" or "1d early" pill.
 * SHOTS=before|after writes screenshots to files/multies-r39 (desktop and phone, light and dark).
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.39.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page, width = 1440) {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
const day = (n: number) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const LONG = "Send Priya the retention numbers from the quarterly review deck with the churn notes for every region and the team";

async function seed(page: Page) {
  const headers = { origin: new URL(page.url()).origin };
  const project = (await (await page.request.post("/api/projects", { headers, data: { name: "Launch plan", key: "LCH" } })).json()).project as { id: string };
  const mk = async (title: string, s: number, e: number) => (await (await page.request.post("/api/tasks", { headers, data: { projectId: project.id, title, start: day(s), due: day(e) } })).json()).task as { id: string };
  const link = async (blocked: string, blocker: string, lag: number) => {
    expect((await page.request.post(`/api/tasks/${blocked}/dependencies`, { headers, data: { blockedBy: blocker } })).ok()).toBe(true);
    if (lag) expect((await page.request.patch(`/api/tasks/${blocked}/dependencies/${blocker}`, { headers, data: { lagDays: lag } })).ok()).toBe(true);
  };
  const design = await mk("Design the pricing page", 0, 3);
  const write = await mk("Write the launch announcement", 7, 9);
  const press = await mk("Prepare the press kit", 3, 5);
  const qa = await mk("QA pass", 10, 11);
  await mk(LONG, 21, 21); // the last bar, one day long, with a long name: its label would run past the chart's right edge
  await link(write.id, design.id, 3); // waits 3 days
  await link(press.id, design.id, -1); // starts 1 day early
  await link(qa.id, write.id, 0);
  return project;
}

async function toLastBar(page: Page) {
  // Scroll the chart so the last bar (the long name) sits near the right of the view.
  await page.locator(".mm-gantt .wx-chart").first().evaluate((el) => {
    const label = [...el.querySelectorAll<HTMLElement>("[data-testid=timeline-bar-label]")].find((x) => (x.dataset.name ?? "").includes("churn notes"));
    const bar = label?.closest<HTMLElement>(".wx-bar");
    if (bar) el.scrollLeft = Math.max(0, bar.offsetLeft + bar.offsetWidth + 24 - el.clientWidth);
  });
}

async function shot(page: Page, name: string) {
  const phase = process.env.SHOTS;
  if (!phase) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r39/timeline-${phase}-${name}.png`, fullPage: false });
}

test("timeline polish: label flips at the right edge, lag drawn on arrows, days off picker", async ({ page }) => {
  test.setTimeout(180_000);
  await demo(page);
  const project = await seed(page);
  await page.goto(`/app/tasks?view=timeline&project=${project.id}`);
  await expect(page.getByTestId("timeline-bar-label").first()).toBeVisible();
  await page.waitForTimeout(600);

  if (process.env.SHOTS) {
    // Scroll the chart so the last bar is in view, then shoot desktop light and dark.
    const toEnd = () => toLastBar(page);
    await toEnd(); await shot(page, "desktop-light");
    await page.emulateMedia({ colorScheme: "dark" }); await page.reload(); await expect(page.getByTestId("timeline-bar-label").first()).toBeVisible(); await page.waitForTimeout(500);
    await toEnd(); await shot(page, "desktop-dark");
    await page.locator(".mm-gantt .wx-chart").first().evaluate((el) => { el.scrollLeft = 0; }); await shot(page, "gaps-desktop-dark");
    await page.emulateMedia({ colorScheme: "light" }); await page.reload(); await expect(page.getByTestId("timeline-bar-label").first()).toBeVisible(); await page.waitForTimeout(500);
    await shot(page, "gaps-desktop-light");
  }
  if (process.env.SHOTS === "before") {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload(); await expect(page.getByTestId("timeline-bar-label").first()).toBeVisible(); await page.waitForTimeout(500);
      await toLastBar(page);
      await page.getByTestId("task-timeline").scrollIntoViewIfNeeded();
      await shot(page, `phone-${scheme}`);
    }
    return; // the old build has none of the R39 parts
  }

  // 1. Flip: the long name on the last bar sits LEFT of its bar, and no outside label runs past the chart's right edge.
  const sides = await page.getByTestId("timeline-bar-label").evaluateAll((els) => els.map((el) => {
    const bar = el.closest(".wx-bar") as HTMLElement;
    const area = el.closest(".wx-area") as HTMLElement;
    const out = el.querySelector(".mm-bar-out") as HTMLElement | null;
    const ab = area.getBoundingClientRect(), bb = bar.getBoundingClientRect(), ob = out?.getBoundingClientRect();
    return { name: el.getAttribute("data-name") ?? "", side: el.getAttribute("data-side"), outRight: ob ? ob.right - ab.left : 0, outLeft: ob ? ob.left - ab.left : 0, barLeft: bb.left - ab.left, width: area.scrollWidth };
  }));
  const last = sides.find((s) => s.name.includes("churn notes"));
  expect(last?.side).toBe("left");
  expect(last!.outRight).toBeLessThanOrEqual(last!.barLeft);
  for (const s of sides) {
    expect(s.outRight, `label inside the chart: ${s.name}`).toBeLessThanOrEqual(s.width + 1);
    expect(s.outLeft, `label inside the chart: ${s.name}`).toBeGreaterThanOrEqual(-1);
  }
  expect(sides.filter((s) => s.side === "right").length).toBeGreaterThan(0); // labels with room stay on the right

  // 2. Lead and lag drawn on the chart: one gap per link with a gap, each with its pill.
  const gaps = page.getByTestId("timeline-lag-gap");
  await expect(gaps).toHaveCount(2);
  await expect(gaps.filter({ hasText: "+3d" })).toHaveCount(1);
  await expect(gaps.filter({ hasText: "1d early" })).toHaveCount(1);
  await expect(gaps.filter({ hasText: "+3d" })).toHaveAttribute("title", /Waits 3 days after [A-Z]+-\d+ ends/);

  // 3. Days off picker: Saturday and Sunday are off by default; turn on working days, add Friday, and it is saved.
  await page.getByRole("switch", { name: "Working days only" }).click();
  await page.getByTestId("days-off-button").click();
  const picker = page.getByTestId("days-off-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("checkbox", { name: "Saturday" })).toBeChecked();
  await expect(picker.getByRole("checkbox", { name: "Sunday" })).toBeChecked();
  await expect(picker.getByRole("checkbox", { name: "Monday" })).not.toBeChecked();
  const saved = page.waitForResponse((r) => r.url().includes(`/projects/${project.id}/schedule`) && r.request().method() === "PUT");
  await picker.getByRole("checkbox", { name: "Friday" }).click();
  expect((await (await saved).json()).schedule.daysOff).toEqual([0, 5, 6]);
  await expect(page.getByTestId("days-off-button")).toContainText("Fri, Sat, Sun");
  await expect(page.locator(".mm-gantt .wx-weekend").first()).toBeAttached(); // days off are shaded on the chart
  if (process.env.SHOTS) await shot(page, "days-off-desktop-light");
  // At least one working day stays: with 6 days off the last working day cannot be turned off.
  for (const d of ["Monday", "Tuesday", "Wednesday", "Thursday"]) {
    const w = page.waitForResponse((r) => r.url().includes("/schedule") && r.request().method() === "PUT");
    await picker.getByRole("checkbox", { name: d }).click();
    await w;
    if (d === "Wednesday") break;
  }
  await expect(picker.getByRole("checkbox", { name: "Thursday" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await page.reload();
  await page.getByTestId("days-off-button").click();
  await expect(page.getByTestId("days-off-picker").getByRole("checkbox", { name: "Friday" })).toBeChecked();

  // 4. Phone: the flipped label still sits inside the chart.
  if (process.env.SHOTS) {
    // put the default days back for the phone shots
    await page.request.put(`/api/projects/${project.id}/schedule`, { headers: { origin: new URL(page.url()).origin }, data: { daysOff: [0, 6] } });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload(); await expect(page.getByTestId("timeline-bar-label").first()).toBeVisible(); await page.waitForTimeout(500);
      await toLastBar(page);
      await page.getByTestId("task-timeline").scrollIntoViewIfNeeded();
      await shot(page, `phone-${scheme}`);
    }
  }
});

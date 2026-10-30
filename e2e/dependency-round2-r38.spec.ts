import { test, expect, type Page } from "@playwright/test";

/**
 * R38 dependencies round 2: a gap (lag) on a link makes a clash, the list row and the board card show a Date clash
 * badge, the gap is changed from the task panel, the timeline shows the Today line, and the project's rules
 * (Working days only, Same days) are saved from the schedule bar.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.38.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
const day = (n: number) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

test("gap per link, clash badges on list and board, Today line, project rules", async ({ page }) => {
  test.setTimeout(150_000);
  await demo(page);
  const headers = { origin: new URL(page.url()).origin };
  const project = (await (await page.request.post("/api/projects", { headers, data: { name: "Gap check", key: "GAP" } })).json()).project as { id: string };
  const mk = async (title: string, s: number, e: number) => (await (await page.request.post("/api/tasks", { headers, data: { projectId: project.id, title, start: day(s), due: day(e) } })).json()).task as { id: string };
  const pour = await mk("Pour the slab", -1, 2), frame = await mk("Frame the walls", 4, 6);
  // A 3 day wait after the slab: the frame (starting 2 days after) now clashes.
  const added = await page.request.post(`/api/tasks/${frame.id}/dependencies`, { headers, data: { blockedBy: pour.id, lagDays: 3 } });
  expect(added.status()).toBe(201);

  // List: one badge on the frame row, with the blocker and the fix date in its tooltip.
  await page.goto(`/app/tasks?view=list&project=${project.id}`);
  const row = page.locator(`[data-task-id="${frame.id}"]`);
  const badge = row.getByTestId("clash-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Date clash");
  await badge.locator("[tabindex]").focus();
  await expect(badge.getByRole("tooltip")).toContainText("Waits on GAP-1 Pour the slab");
  await expect(page.locator(`[data-task-id="${pour.id}"]`).getByTestId("clash-badge")).toHaveCount(0);

  // Board: the same badge on the card.
  await page.goto(`/app/tasks?view=board&project=${project.id}`);
  await expect(page.getByTestId("clash-badge")).toHaveCount(1);

  // Task panel: change the gap to 1 day. The clash clears.
  await page.goto(`/app/tasks?view=list&project=${project.id}&task=${frame.id}`);
  const deps = page.getByTestId("dependencies");
  await expect(deps.getByTestId("lag-chip")).toHaveText(/Waits 3 days/);
  await deps.getByTestId("lag-chip").click();
  await deps.getByTestId("lag-input").fill("1");
  await deps.getByTestId("lag-input").press("Enter");
  await expect(deps.getByTestId("lag-chip")).toHaveText(/Waits 1 day/);
  await expect.poll(async () => ((await (await page.request.get(`/api/tasks/dependencies/check?projectId=${project.id}`)).json()).conflicts as unknown[]).length).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(`[data-task-id="${frame.id}"]`).getByTestId("clash-badge")).toHaveCount(0);

  // A later blocker shifts the frame by the gap: 1 day after the slab's new end.
  const plan = await (await page.request.post(`/api/tasks/${pour.id}/reschedule`, { headers, data: { start: day(-1), due: day(4), preview: true } })).json();
  expect(plan.moved[0]).toMatchObject({ ref: "GAP-2", to: { start: day(6), due: day(8) } });

  // Timeline: the Today line and the project rules.
  await page.goto(`/app/tasks?view=timeline&project=${project.id}`);
  await expect(page.getByTestId("timeline-today")).toBeAttached({ timeout: 15_000 });
  await expect(page.getByTestId("timeline-today")).toContainText("Today");
  const wd = page.getByRole("switch", { name: "Working days only" });
  await expect(wd).toHaveAttribute("aria-checked", "false");
  await wd.click();
  await page.getByTestId("move-mode-same").click();
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${project.id}/schedule`)).json()).schedule).toMatchObject({ workingDaysOnly: true, strict: true });
  await page.reload();
  await expect(page.getByRole("switch", { name: "Working days only" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("move-mode-same")).toHaveAttribute("aria-checked", "true");
});

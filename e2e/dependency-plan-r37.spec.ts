import { test, expect, type Page } from "@playwright/test";

/**
 * R37 dependencies that plan for you: the timeline shows a date clash, the clash sheet fixes it, and dragging a
 * task later (here through the same reschedule preview the drag uses) offers to move the tasks that wait on it.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.37.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
const day = (n: number) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

test("timeline: a clash shows, Fix clears it, and a later blocker moves the tasks that wait", async ({ page }) => {
  test.setTimeout(120_000);
  await demo(page);
  const headers = { origin: new URL(page.url()).origin };
  const project = (await (await page.request.post("/api/projects", { headers, data: { name: "Plan check", key: "PLN" } })).json()).project as { id: string };
  const mk = async (title: string, s: number, e: number) => (await (await page.request.post("/api/tasks", { headers, data: { projectId: project.id, title, start: day(s), due: day(e) } })).json()).task as { id: string };
  const copy = await mk("Write copy", 0, 3), design = await mk("Design pages", 2, 5), build = await mk("Build site", 6, 9);
  await page.request.post(`/api/tasks/${design.id}/dependencies`, { headers, data: { blockedBy: copy.id } });
  await page.request.post(`/api/tasks/${build.id}/dependencies`, { headers, data: { blockedBy: design.id } });

  await page.goto(`/app/tasks?view=timeline&project=${project.id}`);
  const pill = page.getByTestId("schedule-clash-pill");
  await expect(pill).toHaveText("1 date clash");
  await expect(page.getByTestId("timeline-late-style")).toBeAttached();

  // Shift+D (command menu "Show date clashes") opens the same sheet; the e2e uses the pill (the key is an R38 check).
  await pill.click();
  const sheet = page.getByRole("dialog", { name: "1 date clash" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("schedule-clash-list")).toContainText("PLN-2 Design pages");
  await sheet.getByRole("button", { name: "Fix PLN-2" }).click();
  await expect(page.getByTestId("schedule-ok-pill")).toHaveText("Dates line up");
  const startOf = async (id: string) => ((await (await page.request.get(`/api/tasks/${id}`)).json()).task as { start: string }).start.slice(0, 10);
  await expect.poll(() => startOf(design.id)).toBe(day(4));
  await expect.poll(() => startOf(build.id)).toBe(day(8)); // the chain after it moved too
  await page.keyboard.press("Escape");

  // A later blocker: the preview the drag uses lists both waiting tasks; Move all moves them.
  const plan = await (await page.request.post(`/api/tasks/${copy.id}/reschedule`, { headers, data: { start: day(1), due: day(6), preview: true } })).json();
  expect(plan.moved.map((m: { ref: string }) => m.ref)).toEqual(["PLN-2", "PLN-3"]);
  expect(await startOf(design.id)).toBe(day(4)); // preview wrote nothing
  await page.request.post(`/api/tasks/${copy.id}/reschedule`, { headers, data: { start: day(1), due: day(6) } });
  await page.reload();
  await expect(page.getByTestId("schedule-ok-pill")).toHaveText("Dates line up");
  expect(await startOf(design.id)).toBe(day(7));

  // The switch is remembered on this device.
  const sw = page.getByRole("switch", { name: "Move tasks that wait" });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Move tasks that wait" })).toHaveAttribute("aria-checked", "false");
});

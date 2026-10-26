import { test, expect } from "@playwright/test";

/**
 * R38 dashboard widgets end to end: seed tasks and time, open the picker, search it, move through it with the
 * keyboard, add each of the seven new widget types from it and see each one render with its numbers. Then change a
 * widget's date range from its chip and reload: it stays.
 */
let visitor = 0;
const ip = () => `10.139.${test.info().workerIndex % 200}.${++visitor}`;
const DAY = 86_400_000;

test("add every R38 widget type from the picker and see it render", async ({ browser }) => {
  test.setTimeout(180_000);
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1360, height: 1000 }, timezoneId: "UTC", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Planner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const me = (await (await page.request.get("/api/account/me")).json()) as { user: { id: string } };
  const project = (await (await page.request.post("/api/projects", { data: { name: "Website relaunch", key: "WEB" }, headers })).json()).project as { id: string };
  const ids: string[] = [];
  for (const [title, extra] of [["Design the pricing page", { priority: "urgent", assignee: `member:${me.user.id}` }], ["Fix the signup form", { priority: "high" }], ["Write the launch post", { assignee: `member:${me.user.id}` }], ["Plan the webinar", {}]] as const) {
    const r = await page.request.post("/api/tasks", { data: { title, projectId: project.id, ...extra }, headers });
    expect(r.status()).toBe(201);
    ids.push((await r.json()).task.id);
  }
  expect((await page.request.patch(`/api/tasks/${ids[3]}`, { data: { status: "done" }, headers })).status()).toBe(200);
  expect((await page.request.post("/api/time", { data: { taskId: ids[0], minutes: 90, date: new Date(Date.now() - DAY).toISOString().slice(0, 10) }, headers })).status()).toBe(201);
  const d = (await (await page.request.post("/api/dashboards", { data: { name: "Launch" }, headers })).json()).dashboard as { id: string };
  await page.goto(`/app/dashboards/${d.id}`);
  await expect(page.getByText("No widgets yet")).toBeVisible();

  const widgets = page.getByTestId("widget");
  const open = async () => { await page.getByRole("button", { name: "Add widget" }).first().click(); return page.getByRole("dialog"); };

  // Search narrows the grid; Enter in the search picks the first match.
  let dlg = await open();
  await expect(dlg.getByTestId("picker-tile-pivot")).toBeVisible();
  await dlg.getByTestId("picker-search").fill("matrix");
  await expect(dlg.locator("[data-tile]")).toHaveCount(1);
  await dlg.getByTestId("picker-search").press("Enter");
  await expect(dlg.getByLabel("Rows")).toBeVisible();
  await dlg.getByLabel("Rows").selectOption("assignee");
  await dlg.getByLabel("Columns").selectOption("status");
  await dlg.getByRole("button", { name: "Add widget" }).click();
  await expect(widgets).toHaveCount(1);
  await expect(page.locator('[data-type="pivot"]').getByTestId("pivot-total")).toHaveText("4");

  // Arrow keys move through the tiles; Enter picks.
  dlg = await open();
  await dlg.getByTestId("picker-search").press("ArrowDown");
  await expect(dlg.getByTestId("picker-tile-count")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(dlg.getByTestId("picker-tile-calculation")).toBeFocused();
  await page.keyboard.press("Enter");
  await dlg.getByLabel("Measure").selectOption("hours");
  await dlg.getByLabel("Goal").fill("3");
  await dlg.getByRole("button", { name: "Add widget" }).click();
  const calc = page.locator('[data-type="calculation"]');
  await expect(calc.getByTestId("widget-number")).toHaveText("1.5");
  await expect(calc.getByRole("img", { name: "50% of the goal" })).toBeVisible();
  await expect(calc.getByTestId("widget-trend")).toBeVisible();

  const add = async (type: string, fill?: () => Promise<void>) => {
    const dl = await open();
    await dl.getByTestId(`picker-tile-${type}`).click();
    if (fill) await fill();
    await dl.getByRole("button", { name: "Add widget" }).click();
  };
  await add("battery", async () => { await page.getByRole("dialog").getByLabel("Tasks from").selectOption({ label: "Website relaunch" }); });
  await expect(page.locator('[data-type="battery"]').getByTestId("widget-number")).toHaveText("25%");
  await expect(page.locator('[data-type="battery"]').getByTestId("widget-chips")).toContainText("Website relaunch");
  await add("created_completed");
  await expect(page.locator('[data-type="created_completed"]').getByTestId("net-chip")).toHaveText("Backlog grew by 3");
  await add("task_list", async () => { await page.getByRole("dialog").getByLabel("Sort by").selectOption("priority"); });
  await expect(page.locator('[data-type="task_list"]').getByRole("link").first()).toContainText("Design the pricing page");
  await add("time_tracked");
  await expect(page.locator('[data-type="time_tracked"]').getByTestId("widget-number")).toHaveText("1.5");
  await add("note", async () => { await page.getByRole("dialog").getByLabel("Text").fill("Launch week. Log your time."); });
  await expect(page.locator('[data-type="note"]').getByTestId("widget-note")).toHaveText("Launch week. Log your time.");
  await expect(widgets).toHaveCount(7);

  // The date range chip changes one widget and is saved.
  const cc = page.locator('[data-type="created_completed"]');
  await expect(cc.getByTestId("range-chip")).toContainText("Last 30 days");
  await cc.getByTestId("range-chip").click();
  await page.getByRole("menuitem", { name: "Last 7 days" }).click();
  await expect(cc.getByTestId("range-chip")).toContainText("Last 7 days");
  await page.reload();
  await expect(widgets).toHaveCount(7);
  await expect(page.locator('[data-type="created_completed"]').getByTestId("range-chip")).toContainText("Last 7 days");
  await expect(page.locator('[data-type="pivot"]').getByTestId("pivot-total")).toHaveText("4");
  await ctx.close();
});

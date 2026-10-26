import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R24.3 Dashboards end to end: seed tasks, make Team overview in one click and check its counts,
 * add a widget from a saved filter, drag a widget to reorder, and reload: the order stays.
 */
let visitor = 0;
const ip = () => `10.125.${test.info().workerIndex % 200}.${++visitor}`;
const DAY = 86_400_000;

async function drag(page: Page, from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>) {
  const a = (await from.boundingBox())!; const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 4 });
  await page.mouse.move(b.x + b.width * 0.25, b.y + b.height * 0.25, { steps: 14 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

test("make Team overview, see the counts, add a widget from a saved filter, reorder and reload", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1360, height: 1000 }, timezoneId: "UTC", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Planner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const me = (await (await page.request.get("/api/account/me")).json()) as { user: { id: string } };
  const project = (await (await page.request.post("/api/projects", { data: { name: "Website relaunch", key: "WEB" }, headers })).json()).project as { id: string };
  const today = new Date(); today.setUTCHours(23, 0, 0, 0);
  const seed: [string, Record<string, unknown>][] = [
    ["Design the pricing page", { due: new Date(today.getTime() - 3 * DAY).toISOString(), priority: "high", assignee: `member:${me.user.id}` }],
    ["Fix the signup form", { due: new Date(today.getTime() - 2 * DAY).toISOString(), priority: "high" }],
    ["Write the launch post", { due: today.toISOString(), assignee: `member:${me.user.id}` }],
    ["Plan the webinar", { assignee: `member:${me.user.id}` }],
    ["Refresh screenshots", {}],
  ];
  const ids: string[] = [];
  for (const [title, extra] of seed) {
    const r = await page.request.post("/api/tasks", { data: { title, projectId: project.id, ...extra }, headers });
    expect(r.status()).toBe(201);
    ids.push((await r.json()).task.id);
  }
  expect((await page.request.patch(`/api/tasks/${ids[4]}`, { data: { status: "done" }, headers })).status()).toBe(200);
  expect((await page.request.post("/api/tasks/views", { data: { name: "High priority", view: "list", projectId: project.id, filters: { priority: "high" } }, headers })).ok()).toBe(true);

  await page.goto("/app/dashboards");
  await expect(page.getByText("No dashboards yet")).toBeVisible();
  await page.getByRole("button", { name: "Team overview" }).first().click();
  await expect(page).toHaveURL(/\/app\/dashboards\/dsh_/);
  const widgets = page.getByTestId("widget");
  await expect(widgets).toHaveCount(4);
  const titles = () => widgets.evaluateAll((els) => els.map((e) => e.getAttribute("data-title")));
  expect(await titles()).toEqual(["Tasks by status", "Open tasks by person", "Due this week and overdue", "Completed per week"]);
  // 5 tasks: 4 to do and 1 done; 3 open with Ada, 1 unassigned; 2 overdue and 1 due this week.
  const status = page.locator('[data-title="Tasks by status"]');
  await expect(status.getByRole("listitem").filter({ hasText: "To do" })).toContainText("4");
  await expect(status.getByRole("listitem").filter({ hasText: "Done" })).toContainText("1");
  await expect(page.getByTestId("due-overdue")).toHaveText("2");
  await expect(page.getByTestId("due-week")).toHaveText("1");
  await expect(page.locator('[data-title="Due this week and overdue"]').getByRole("link")).toHaveCount(3);

  // Add a widget from the saved filter.
  await page.getByRole("button", { name: "Add widget" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Widget").selectOption("count");
  await dlg.getByLabel("Tasks from").selectOption({ label: "High priority" });
  await dlg.getByLabel("Title").fill("High priority tasks");
  await dlg.getByRole("button", { name: "Add" }).click();
  await expect(widgets).toHaveCount(5);
  await expect(page.locator('[data-title="High priority tasks"]').getByTestId("widget-number")).toHaveText("2");

  // Drag "Open tasks by person" onto the first card.
  await drag(page, page.getByRole("button", { name: "Move Open tasks by person", exact: true }), page.locator('[data-title="Tasks by status"]'));
  await expect.poll(titles).toEqual(["Open tasks by person", "Tasks by status", "Due this week and overdue", "Completed per week", "High priority tasks"]);
  await expect.poll(async () => ((await (await page.request.get(page.url().replace(/.*\/app\/dashboards\//, "/api/dashboards/"))).json()).dashboard.widgets as { title: string }[])[0].title).toBe("Open tasks by person");
  await page.reload();
  await expect(widgets).toHaveCount(5);
  expect(await titles()).toEqual(["Open tasks by person", "Tasks by status", "Due this week and overdue", "Completed per week", "High priority tasks"]);
  await expect(page.locator('[data-title="High priority tasks"]').getByTestId("widget-number")).toHaveText("2");
  await expect(page.locator('[data-title="Completed per week"] .recharts-line-dots circle')).toHaveCount(8);
  mkdirSync("/home/user/tab/files/multies-r24", { recursive: true });
  await page.screenshot({ path: "/home/user/tab/files/multies-r24/dash.png" });
  await ctx.close();
});

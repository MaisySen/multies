import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R24.1 Formula and rollup fields end to end: add a number field, a formula field (with its live
 * preview) and a rollup field in the Fields dialog, see the computed column in the table, add
 * subtasks with points and see the rollup sum on the parent, then reload and see it all again.
 */
let visitor = 0;
const ip = () => `10.123.${test.info().workerIndex % 200}.${++visitor}`;

test("formula and rollup columns in the table, live preview, rollup of subtasks, project rollups", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1360, height: 820 }, timezoneId: "UTC", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Fran Planner", email: `fran-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const project = (await (await page.request.post("/api/projects", { data: { name: "Website relaunch", key: "WEB" }, headers })).json()).project as { id: string };
  const seed: [string, number | null][] = [["Launch campaign", 12000], ["Design the pricing page", 4500], ["Write help articles", 1800], ["Set up analytics", null]];
  const ids: Record<string, string> = {};
  for (const [title] of seed) {
    const r = await page.request.post("/api/tasks", { data: { title, projectId: project.id }, headers });
    expect(r.status()).toBe(201);
    ids[title] = (await r.json()).task.id;
  }

  await page.goto(`/app/tasks?view=list&project=${project.id}`);
  await page.getByRole("button", { name: "Project actions" }).click(); // R75: project actions are one menu
  await page.getByRole("menuitem", { name: "Fields", exact: true }).click();
  const dialog = page.getByRole("dialog");
  // A number field.
  await dialog.getByLabel("New field name").fill("Budget");
  await dialog.getByLabel("New field type").selectOption("currency");
  await dialog.getByRole("button", { name: "Add field" }).click();
  await expect(dialog.getByLabel("Name of Budget")).toBeVisible();
  // A formula with a live preview and an inline error first.
  await dialog.getByLabel("New field name").fill("With GST");
  await dialog.getByLabel("New field type").selectOption("formula");
  await dialog.getByLabel("New field formula").fill("{Budget} *");
  await expect(dialog.getByTestId("formula-error")).toContainText("ends too early");
  await dialog.getByLabel("New field formula").fill("{Budget} * 1.1");
  await expect(dialog.getByTestId("formula-preview")).toContainText("Launch campaign");
  await dialog.getByRole("button", { name: "Add field" }).click();
  await expect(dialog.getByLabel("Name of With GST")).toBeVisible();
  // A rollup of subtask points.
  await dialog.getByLabel("New field name").fill("Sub points");
  await dialog.getByLabel("New field type").selectOption("rollup");
  await dialog.getByLabel("New field rollup source").selectOption("subtasks");
  await dialog.getByLabel("New field rollup function").selectOption("sum");
  await dialog.getByLabel("New field rollup field").selectOption("points");
  await dialog.getByRole("button", { name: "Add field" }).click();
  await expect(dialog.getByLabel("Name of Sub points")).toBeVisible();
  await page.keyboard.press("Escape");

  // Values and subtasks through the API, like a teammate or an agent would add them.
  const fields = (await (await page.request.get(`/api/fields?projectId=${project.id}`)).json()).fields as { id: string; name: string }[];
  const budget = fields.find((f) => f.name === "Budget")!.id;
  for (const [title, amount] of seed) if (amount !== null) expect((await page.request.patch(`/api/tasks/${ids[title]}`, { data: { fields: { [budget]: amount } }, headers })).status()).toBe(200);
  for (const [title, points] of [["Hero copy", 3], ["Social posts", 5], ["Launch email", 2]] as const) {
    expect((await page.request.post("/api/tasks", { data: { title, projectId: project.id, parentId: ids["Launch campaign"], points }, headers })).status()).toBe(201);
  }
  expect((await page.request.post("/api/tasks", { data: { title: "Plans table", projectId: project.id, parentId: ids["Design the pricing page"], points: 8 }, headers })).status()).toBe(201);
  expect((await page.request.post("/api/fields", { data: { projectId: project.id, name: "Total budget", type: "rollup", config: { source: "project", fn: "sum", field: budget } }, headers })).status()).toBe(201);
  expect((await page.request.post("/api/fields", { data: { projectId: project.id, name: "Done", type: "rollup", config: { source: "project", fn: "percent_done" } }, headers })).status()).toBe(201);

  expect((await page.request.patch(`/api/tasks/${ids["Write help articles"]}`, { data: { status: "done" }, headers })).status()).toBe(200);

  await page.reload();
  const table = page.getByTestId("task-table");
  const row = (title: string) => table.locator("tr", { hasText: title }).first();
  const cell = (title: string, col: string) => row(title).locator(`td[aria-label="${col}"]`);
  await expect(cell("Launch campaign", "With GST")).toHaveText("13,200");
  await expect(cell("Design the pricing page", "With GST")).toHaveText("4,950");
  await expect(cell("Set up analytics", "With GST")).toHaveText("-");
  await expect(cell("Launch campaign", "Sub points")).toHaveText("10");
  await expect(cell("Design the pricing page", "Sub points")).toHaveText("8");
  await expect(cell("Write help articles", "Sub points")).toHaveText("0");
  await expect(cell("Launch campaign", "With GST").locator("[data-computed]")).toHaveAttribute("title", "= {Budget} * 1.1");
  await expect(page.getByTestId("rollup-Total budget")).toHaveText("$18,300");
  await expect(page.getByTestId("rollup-Done")).toHaveText("13%"); // 1 of 8 live tasks (subtasks count too)
  // Project rollups stay out of the columns.
  await expect(table.locator('th', { hasText: "Total budget" })).toHaveCount(0);
  mkdirSync(`${SHOTS_ROOT}/multies-r24`, { recursive: true });
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r24/formula.png` });

  // A new subtask changes the rollup; it persists across a reload.
  expect((await page.request.post("/api/tasks", { data: { title: "Press kit", projectId: project.id, parentId: ids["Launch campaign"], points: 4 }, headers })).status()).toBe(201);
  await page.reload();
  await expect(cell("Launch campaign", "Sub points")).toHaveText("14");
  await expect(cell("Launch campaign", "With GST")).toHaveText("13,200");
  await ctx.close();
});

import { test, expect } from "@playwright/test";
// W4: since R79 a task opens in the side panel ("Task details") on a wide screen, over the page ("Task") otherwise.
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 21 sprints end to end: plan a sprint in a project, move two backlog tasks into it, start it,
 * finish one task, see the burndown, then complete it with the unfinished task carried to the next sprint.
 */
let visitor = 0;
const ip = () => `10.121.${test.info().workerIndex % 200}.${++visitor}`;

test("plan, fill, start and complete a sprint, carrying the unfinished task over", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1360, height: 900 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Planner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const project = (await (await page.request.post("/api/projects", { data: { name: "Website relaunch", key: "WEB" }, headers })).json()).project as { id: string };
  const seed: [string, number][] = [["Design the new pricing page", 5], ["Write launch announcement", 3], ["Set up redirects", 2], ["Refresh product screenshots", 3], ["Accessibility pass on forms", 5], ["Update help centre links", 1]];
  for (const [title, points] of seed) expect((await page.request.post("/api/tasks", { data: { title, projectId: project.id, points }, headers })).status()).toBe(201);

  await page.goto(`/app/tasks?view=sprints&project=${project.id}`);
  await expect(page.getByText("No sprints yet")).toBeVisible();
  await page.getByRole("button", { name: "Plan a sprint" }).click();
  const plan = page.getByRole("dialog", { name: "Plan a sprint" });
  await plan.getByLabel("Name").fill("Sprint 1");
  await plan.getByLabel("Goal").fill("Pricing page and launch post ready for review");
  await plan.getByRole("button", { name: "Plan sprint" }).click();
  await expect(page.getByRole("combobox", { name: "Sprint" })).toBeVisible();

  const backlog = page.getByRole("list", { name: "Backlog tasks" });
  for (const title of ["Design the new pricing page", "Write launch announcement"]) {
    await backlog.getByRole("listitem").filter({ hasText: title }).getByRole("button", { name: "Move to sprint" }).click();
    await page.getByRole("menuitem", { name: "Sprint 1" }).click();
    await expect(page.getByRole("list", { name: "Sprint tasks" }).getByText(title)).toBeVisible();
  }
  await expect(backlog.getByRole("listitem")).toHaveCount(4);

  await page.getByRole("button", { name: "Start sprint" }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("0 of 8 done")).toBeVisible();

  // Finish one task from the task panel.
  await page.getByRole("list", { name: "Sprint tasks" }).getByRole("button", { name: "Design the new pricing page" }).click();
  const panel = page.getByRole("dialog", { name: "Task" }).or(page.getByRole("complementary", { name: "Task details" }));
  await expect(panel.getByLabel("Move to sprint")).toHaveValue(/spr_/);
  await expect(panel.getByLabel("Estimate")).toHaveValue("5");
  await panel.getByRole("button", { name: "Mark as done" }).click();
  await expect(panel.getByRole("button", { name: "Mark as not done" })).toBeVisible();
  await panel.getByRole("button", { name: "Close task" }).click();

  await expect(page.getByText("5 of 8 done")).toBeVisible({ timeout: 10_000 });
  const chart = page.getByRole("img", { name: /^Burndown: 3 points left of 8/ });
  await expect(chart).toBeVisible();
  mkdirSync(`${SHOTS_ROOT}/multies-r21`, { recursive: true });
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r21/sprints.png` });

  await page.getByRole("button", { name: "Complete sprint" }).click();
  const done = page.getByRole("dialog", { name: "Complete Sprint 1" });
  await expect(done.getByText("1 task isn't done.")).toBeVisible();
  await done.getByLabel("Move to a new sprint").check();
  await done.getByRole("button", { name: "Complete sprint" }).click();
  await expect(done).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Sprint" })).toHaveValue(/spr_/);
  await expect(page.getByRole("combobox", { name: "Sprint" }).locator("option:checked")).toHaveText("Sprint 2");
  await expect(page.getByRole("list", { name: "Sprint tasks" }).getByText("Write launch announcement")).toBeVisible();
  await expect(page.getByRole("list", { name: "Sprint tasks" }).getByText("Design the new pricing page")).toHaveCount(0);

  // Plan from the table: pick two backlog tasks and send them to Sprint 2 in one go.
  await page.goto(`/app/tasks?view=list&project=${project.id}`);
  const table = page.getByTestId("task-table");
  for (const title of ["Set up redirects", "Update help centre links"]) await table.getByRole("row").filter({ hasText: title }).getByRole("checkbox").click();
  const bar = page.getByTestId("bulk-bar");
  await expect(bar).toContainText("2 selected");
  await bar.getByRole("button", { name: "Sprint" }).click();
  await bar.getByRole("menuitem", { name: /Sprint 2/ }).click();
  await page.goto(`/app/tasks?view=sprints&project=${project.id}`);
  for (const title of ["Set up redirects", "Update help centre links"]) await expect(page.getByRole("list", { name: "Sprint tasks" }).getByText(title)).toBeVisible();
  await ctx.close();
});

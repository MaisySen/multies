import { test, expect } from "@playwright/test";

/**
 * R55 (MB-140): a task rule made in Automations does several things in order. An admin on a demo workspace
 * makes "When a task is made: set the priority to high, then add the label triage, then notify the assignee";
 * a new task comes out high with the label.
 */
let visitor = 0;
const ip = () => `10.155.${test.info().workerIndex % 200}.${++visitor}`;

test("a rule with extra actions runs them all on a new task", async ({ page, context }) => {
  test.setTimeout(90_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const headers = { origin: new URL(test.info().project.use.baseURL!).origin };
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });

  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto("/app/automations");
  await page.getByRole("button", { name: "New rule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Triage new tasks");
  await dialog.getByLabel("When").selectOption("task_created");
  await dialog.getByLabel("Then", { exact: true }).selectOption("set_priority");
  await expect(dialog.getByLabel("Priority", { exact: true }).nth(1)).toHaveValue(""); // asks, instead of showing a choice it would not save
  await dialog.getByLabel("Priority", { exact: true }).nth(1).selectOption("high"); // nth(0) is the "only tasks with this priority" condition
  const more = dialog.getByRole("group", { name: "And then" });
  await expect(more).toBeVisible();
  await more.getByRole("button", { name: "Add an action" }).click();
  const steps = more.getByTestId("extra-action");
  await steps.nth(0).getByLabel("Label", { exact: true }).fill("triage");
  await more.getByRole("button", { name: "Add an action" }).click();
  await steps.nth(1).getByLabel("Action", { exact: true }).selectOption("notify");
  await expect(steps).toHaveCount(2);
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Triage new tasks")).toBeVisible();
  await expect(page.getByText(/Then 2 more actions\./)).toBeVisible();

  const rules = (await (await page.request.get("/api/automations")).json()).automations as { name: string; action: string; actionConfig: { then?: { action: string; actionConfig: Record<string, unknown> }[] } }[];
  const rule = rules.find((r) => r.name === "Triage new tasks")!;
  expect(rule.action).toBe("set_priority");
  expect(rule.actionConfig.then).toEqual([{ action: "add_label", actionConfig: { label: "triage" } }, { action: "notify", actionConfig: { to: "assignee" } }]);

  const projects = (await (await page.request.get("/api/projects")).json()).projects as { id: string }[];
  const made = await page.request.post("/api/tasks", { data: { title: "Checkout button does nothing", projectId: projects[0].id }, headers });
  expect(made.status()).toBe(201);
  const id = ((await made.json()).task ?? (await made.json())).id as string;
  const task = (await (await page.request.get(`/api/tasks/${id}`)).json()).task as { priority: string; labels: string[] };
  expect(task.priority).toBe("high");
  expect(task.labels).toContain("triage");
});

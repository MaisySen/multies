import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * R27 (DF-3 slice 2): an AI agent member works a task with its own key: it starts a run, logs steps and finishes with
 * a result. The task panel shows the run with the Agent badge, its steps and result, and the audit log reads it in
 * plain words.
 */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1280, height: 900 } });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.97.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

test("an agent runs a task through the API and the task panel and audit log show it", async () => {
  const made = await page.request.post("/api/team/agents", { data: { name: "Builder", title: "Engineering lead", avatarColor: "#0071E3" } });
  expect(made.status()).toBe(201);
  const { member, secret } = await made.json() as { member: { userId: string }; secret: string };
  const auth = { authorization: `Bearer ${secret}` };
  const projects = (await (await page.request.get("/api/projects")).json()).projects as { id: string }[];
  const task = (await (await page.request.post("/api/tasks", { data: { projectId: projects[0].id, title: "Fix the sprint filter", assignee: `member:${member.userId}` } })).json()).task as { id: string; ref: string };

  const start = await page.request.post(`/api/v1/tasks/${task.ref}/runs`, { headers: auth, data: { moveToDoing: true, note: "Read the task and the failing test" } });
  expect(start.status()).toBe(201);
  const run = (await start.json()).run as { id: string };
  for (const s of [{ kind: "tool", text: "Ran the unit tests: 3 failed in sprint-filter" }, { kind: "note", text: "The sprint id was dropped when the query had a project" }, { kind: "status_change", text: "Tests green after the fix" }]) {
    expect((await page.request.post(`/api/v1/runs/${run.id}/steps`, { headers: auth, data: s })).status()).toBe(201);
  }
  const fin = await page.request.post(`/api/v1/runs/${run.id}/finish`, { headers: auth, data: { status: "succeeded", result: "Sprint filter fixed and covered by a test.", moveTo: "review", comment: true } });
  expect(fin.status()).toBe(200);

  // The task panel lists the run; it opens to the steps and the result.
  await page.goto(`/app/tasks?task=${task.id}`);
  const runs = page.getByTestId("task-runs");
  await expect(runs).toBeVisible({ timeout: 15_000 });
  const row = runs.getByTestId("task-run").first();
  await expect(row.getByText("Builder", { exact: true })).toBeVisible();
  await expect(row.getByText("Agent", { exact: true })).toBeVisible();
  await expect(row.getByText("Succeeded", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: /Builder run, Succeeded/ }).click();
  await expect(row.getByText("Ran the unit tests: 3 failed in sprint-filter")).toBeVisible();
  await expect(row.getByTestId("run-result")).toHaveText("Sprint filter fixed and covered by a test.");
  await runs.scrollIntoViewIfNeeded();
  await page.screenshot({ path: process.env.R27_SHOT ?? "test-results/r27-agent-run.png" });

  // The audit log names the agent and the task.
  await page.goto("/app/activity?tab=audit");
  await expect(page.getByText(`started a run on`).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`${task.ref} (succeeded)`).first()).toBeVisible();
  await expect(page.getByText("Builder", { exact: true }).first()).toBeVisible();
});

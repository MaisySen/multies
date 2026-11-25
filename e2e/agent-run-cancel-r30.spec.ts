import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * R30: cancel an agent run from the task panel. A person queues a run for an agent member, opens the task, presses
 * Cancel run, confirms, and the run shows Cancelled at once; the server agrees and the agent can no longer step it.
 */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1280, height: 900 } });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.98.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

test("a person cancels a queued run in the run detail and it shows Cancelled", async () => {
  const made = await page.request.post("/api/team/agents", { data: { name: "Builder", title: "Engineering lead", avatarColor: "#0071E3" } });
  expect(made.status()).toBe(201);
  const { member, secret } = await made.json() as { member: { userId: string }; secret: string };
  const projects = (await (await page.request.get("/api/projects")).json()).projects as { id: string }[];
  const task = (await (await page.request.post("/api/tasks", { data: { projectId: projects[0].id, title: "Tidy the release notes", assignee: `member:${member.userId}` } })).json()).task as { id: string; ref: string };
  const queued = await page.request.post(`/api/tasks/${task.id}/runs`, { data: { agentUserId: member.userId } });
  expect(queued.status()).toBe(201);
  const run = (await queued.json()).run as { id: string; status: string };
  expect(run.status).toBe("queued");

  await page.goto(`/app/tasks?task=${task.id}`);
  const runs = page.getByTestId("task-runs");
  await expect(runs).toBeVisible({ timeout: 15_000 });
  const row = runs.getByTestId("task-run").first();
  await expect(row.getByText("Queued", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: /Builder run, Queued/ }).click();

  // The first press asks; "Keep running" backs out without a change.
  await row.getByRole("button", { name: "Cancel run" }).click();
  const confirm = row.getByTestId("run-cancel-confirm");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Keep running" }).click();
  await expect(confirm).toBeHidden();
  await expect(row.getByText("Queued", { exact: true })).toBeVisible();

  // R31: on a phone width panel the two confirm buttons stay together on one line, each on one line.
  // W4: since R79 the task sits in the side panel on a desktop and over the page on a phone, so a resize opens it
  // afresh: the phone check asks there, and the desktop asks again after.
  await page.setViewportSize({ width: 390, height: 844 });
  // The panel opened afresh over the page, with the run's detail closed: open it again.
  await expect(page.getByRole("dialog", { name: "Task" })).toBeVisible();
  if (!(await row.getByRole("button", { name: "Cancel run" }).isVisible())) await row.getByRole("button", { name: /Builder run, Queued/ }).click();
  await row.getByRole("button", { name: "Cancel run" }).click();
  await expect(confirm).toBeVisible();
  const keep = (await confirm.getByRole("button", { name: "Keep running" }).boundingBox())!;
  const stop = (await confirm.getByRole("button", { name: "Cancel run" }).boundingBox())!;
  expect(Math.abs(keep.y - stop.y)).toBeLessThan(2);
  expect(Math.abs(keep.height - stop.height)).toBeLessThan(2); // both one line (44 px touch height on a phone)
  expect(Math.max(keep.height, stop.height)).toBeLessThan(50);
  await page.setViewportSize({ width: 1280, height: 900 });
  await runs.scrollIntoViewIfNeeded();
  if (!(await confirm.isVisible())) {
    if (!(await row.getByRole("button", { name: "Cancel run" }).isVisible())) await row.getByRole("button", { name: /Builder run, Queued/ }).click();
    await row.getByRole("button", { name: "Cancel run" }).click();
  }
  await expect(confirm).toBeVisible();
  if (process.env.R30_SHOT_CONFIRM) await page.screenshot({ path: process.env.R30_SHOT_CONFIRM });
  await confirm.getByRole("button", { name: "Cancel run" }).click();
  await expect(row.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(page.getByText("Run cancelled")).toBeVisible();
  await expect(row.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
  if (process.env.R30_SHOT_DONE) await page.screenshot({ path: process.env.R30_SHOT_DONE });

  // The server agrees, and the agent can't pick the run up again.
  const got = await (await page.request.get(`/api/agent-runs/${run.id}`)).json() as { run: { status: string } };
  expect(got.run.status).toBe("cancelled");
  const late = await page.request.post(`/api/v1/runs/${run.id}/steps`, { headers: { authorization: `Bearer ${secret}` }, data: { text: "late" } });
  expect(late.status()).toBe(409);
  expect((await late.json()).error.code).toBe("run_cancelled");

  // The audit log reads it in plain words.
  await page.goto("/app/activity?tab=audit");
  await expect(page.getByText("cancelled a run on").first()).toBeVisible({ timeout: 15_000 });
});

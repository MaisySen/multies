import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R27 teardown end to end: Watch a task from the task panel (the creator already watches, stop and start again,
 * see who watches), then Duplicate it from the More menu and land on the copy with its subtask and checklist.
 */
let visitor = 0;
const ip = () => `10.127.${test.info().workerIndex % 200}.${++visitor}`;
const SHOTS = `${SHOTS_ROOT}/multies-r27`;

test("watch a task and duplicate it with its subtask and checklist", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1360, height: 900 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Planner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const project = (await (await page.request.post("/api/projects", { data: { name: "Website relaunch", key: "WEB" }, headers })).json()).project as { id: string };
  const task = (await (await page.request.post("/api/tasks", { data: { title: "Launch the new pricing page", projectId: project.id, labels: ["launch"], priority: "high" }, headers })).json()).task as { id: string };
  expect((await page.request.post("/api/tasks", { data: { title: "Plan comparison table", parentId: task.id }, headers })).status()).toBe(201);
  expect((await page.request.post(`/api/tasks/${task.id}/checklist`, { data: { items: [{ title: "Final copy from marketing", done: true }, { title: "Stripe prices in AUD" }] }, headers })).status()).toBe(201);

  // Watch: the creator already watches; stop, then start again; the count lists who watches.
  await page.goto(`/app/tasks?view=board&project=${project.id}`);
  await page.getByRole("button", { name: "Launch the new pricing page", exact: true }).click();
  const watch = page.getByTestId("watch-task");
  await expect(watch).toHaveAttribute("aria-pressed", "true");
  await expect(watch).toContainText("Watching");
  await watch.click();
  await expect(watch).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("watcher-count")).toHaveText("0");
  await watch.click();
  await expect(watch).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("watcher-count")).toHaveText("1");
  await page.getByTestId("watcher-count").click();
  await expect(page.getByRole("menuitem", { name: /Ada Planner/ })).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400); // let the menu finish opening and the toasts settle for the screenshot
  await page.screenshot({ path: `${SHOTS}/teardown-watch.png` });
  await page.getByTestId("watcher-count").click(); // close the menu (Escape would close the panel too)
  await expect(page.getByRole("menuitem", { name: /Ada Planner/ })).toHaveCount(0);
  const api = await (await page.request.get(`/api/tasks/${task.id}/watchers`)).json();
  expect(api).toMatchObject({ watching: true, count: 1 });

  // Duplicate from the More menu: the copy opens with its subtask and unticked checklist.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Duplicate task" }).click();
  await expect(page.getByText(/Duplicated as WEB-3 with 1 subtask and 2 checklist items/)).toBeVisible();
  await expect(page).toHaveURL(/task=tsk_/);
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Launch the new pricing page (copy)");
  const panel = page.getByRole("region", { name: "Checklist" });
  await expect(panel.getByTestId("checklist-progress")).toHaveText("0 of 2");
  await expect(page.getByText("Plan comparison table").first()).toBeVisible();
  await panel.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: `${SHOTS}/teardown-duplicate.png` });
  // The copy is watched by the person who made it; the original is untouched.
  const list = (await (await page.request.get(`/api/tasks?projectId=${project.id}`)).json()).tasks as { title: string; status: string }[];
  expect(list.map((t) => t.title)).toEqual(expect.arrayContaining(["Launch the new pricing page", "Launch the new pricing page (copy)"]));
  await ctx.close();
});

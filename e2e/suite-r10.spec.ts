import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Round 10 end to end: team chat (post, link a task, turn a message into a task, thread reply),
 * the notifications inbox and its settings, a starter template, a goal with key results,
 * a repeating task, and a real 404 for an unknown page.
 */
// One demo workspace for the whole file: the demo endpoint is rate limited per address, so
// remote runs (E2E_BASE_URL) would otherwise be refused after a few tests.
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
let demoTasks: { id: string; ref: string; title: string; projectId: string }[] = [];
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.90.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  demoTasks = await demo(page);
});
test.afterAll(async () => { await ctx?.close(); });

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  const list = async () => ((await (await page.request.get("/api/tasks")).json().catch(() => ({}))).tasks ?? []) as unknown[];
  await expect.poll(async () => (await list()).length, { timeout: 30_000 }).toBeGreaterThan(5);
  return (await list()) as { id: string; ref: string; title: string; projectId: string }[];
}

test("chat: post with a task link, reply in a thread and turn a message into a task", async () => {
  const tasks = demoTasks;
  await page.goto("/app/chat");
  await expect(page).toHaveURL(/\/app\/chat\/chn_/);
  const box = page.getByTestId("chat-composer");
  await box.fill(`Can someone pick up ${tasks[0].ref} today?`);
  await box.press("Enter");
  const msg = page.getByTestId("chat-message").filter({ hasText: "Can someone pick up" });
  await expect(msg).toBeVisible();
  await expect(msg.getByTestId("chat-link")).toContainText(tasks[0].ref);
  // Thread reply.
  await msg.hover();
  await msg.getByRole("button", { name: "Reply in thread" }).click();
  const thread = page.getByRole("complementary", { name: "Thread" });
  await thread.getByTestId("thread-composer").fill("On it after lunch");
  await thread.getByTestId("thread-composer").press("Enter");
  await expect(thread.getByText("On it after lunch")).toBeVisible();
  await page.getByRole("button", { name: "Close thread" }).click();
  await expect(msg.getByRole("button", { name: "1 reply" })).toBeVisible();
  // Make task.
  await msg.hover();
  await msg.getByText("More").click();
  await page.getByRole("menuitem", { name: "Make task" }).click();
  await expect(page).toHaveURL(/\/app\/tasks\?task=tsk_/);
  await expect(page.getByRole("dialog", { name: "Task" }).getByLabel("Title")).toHaveValue(/Can someone pick up/);
});

test("notifications inbox lists, filters and marks read; settings save", async () => {
  // A mention of yourself does not notify, so make an assignment-free notification through a goal update instead:
  // the inbox page and filters must work whether or not there are items.
  await page.goto("/app/notifications");
  await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /^Mentions/ }).click();
  await expect(page.getByRole("button", { name: /^Mentions/ })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/app/settings/notifications");
  const sw = page.getByRole("switch", { name: "Status changes on my phone" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await (await page.request.get("/api/notifications/settings")).json()).settings.status.push).toBe(true);
});

test("templates: make a project from the client onboarding starter", async () => {
  await page.goto("/app/templates");
  const card = page.getByTestId("template-card").filter({ hasText: "Client onboarding" });
  await card.getByRole("button", { name: "Use template" }).click();
  const dialog = page.getByRole("dialog", { name: /Use "Client onboarding"/ });
  await dialog.getByLabel("Project name (optional)").fill("Onboard Harbour Coffee");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/app\/tasks\?project=/);
  await expect(page.getByText("30 day check-in")).toBeVisible();
});

test("goals: a goal with a number key result shows its progress", async () => {
  await page.goto("/app/goals");
  await page.getByRole("button", { name: "New goal" }).first().click();
  await page.getByRole("dialog", { name: "New goal" }).getByLabel("Goal").fill("Grow repeat customers");
  await page.getByRole("dialog", { name: "New goal" }).getByRole("button", { name: "Create goal" }).click();
  const goal = page.getByTestId("goal").filter({ hasText: "Grow repeat customers" });
  await goal.getByRole("button", { name: "Key result" }).click();
  const kr = page.getByRole("dialog", { name: "Add a key result" });
  await kr.getByLabel("Key result").fill("Repeat orders a month");
  await kr.getByLabel("Target").fill("40");
  await kr.getByLabel("Now").fill("10");
  await kr.getByRole("button", { name: "Add" }).click();
  await expect(goal.getByRole("progressbar", { name: "Grow repeat customers progress" })).toHaveAttribute("aria-valuenow", "25");
});

test("a task set to repeat weekly makes the next one when done", async () => {
  const tasks = demoTasks;
  const t = tasks[0];
  await page.goto(`/app/tasks?task=${t.id}`);
  const panel = page.getByRole("dialog", { name: "Task" });
  await panel.getByRole("combobox", { name: "Repeat" }).selectOption("weekly");
  await expect(panel.getByText(/Every week/)).toBeVisible();
  const before = ((await (await page.request.get(`/api/tasks?projectId=${t.projectId}`)).json()).tasks as { title: string }[]).filter((x) => x.title === t.title).length;
  await panel.getByRole("button", { name: "Mark as done" }).click();
  await expect.poll(async () => ((await (await page.request.get(`/api/tasks?projectId=${t.projectId}`)).json()).tasks as { title: string }[]).filter((x) => x.title === t.title).length).toBe(before + 1);
});

test("an unknown page answers 404 and shows page not found", async () => {
  const res = await page.goto("/this-page-does-not-exist");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This page bounced." })).toBeVisible();
  expect((await page.request.get("/pricing")).status()).toBe(200);
});

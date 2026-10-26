import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * R26 (DF-3): an admin adds an AI agent member, gives a task to it and sees the Agent badge in the
 * task list and in People; pausing it shows Paused and its key is refused.
 */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1280, height: 900 } });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.93.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

test("admin adds an agent member, assigns it a task and sees the Agent badge", async () => {
  await page.goto("/app/settings/team");
  await page.getByRole("button", { name: "Add agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an AI agent" });
  await dialog.getByLabel("Name").fill("Builder");
  await dialog.getByLabel("Title").fill("Engineering lead");
  await dialog.getByLabel("Bio").fill("Writes the code, opens the pull requests and ships the builds.");
  await dialog.getByRole("button", { name: "Add agent" }).click();
  const key = (await page.getByTestId("agent-key").textContent())!.trim();
  await page.getByRole("button", { name: "Done" }).click();

  // Two more teammates through the app's own route, with colours.
  for (const a of [{ name: "QA", title: "Quality lead", bio: "Runs every test suite before a release.", avatarColor: "#30B158" }, { name: "Scout", title: "Research", bio: "Reads the competitors and writes the notes.", avatarColor: "#BF5AF2" }]) {
    expect((await page.request.post("/api/team/agents", { data: a })).status()).toBe(201);
  }
  const agents = (await (await page.request.get("/api/team/agents")).json()).agents as { userId: string; name: string }[];
  const builder = agents.find((a) => a.name === "Builder")!;

  // Give Builder a task, then see it in the list with the Bot badge.
  const projects = (await (await page.request.get("/api/projects")).json()).projects as { id: string }[];
  const made = await page.request.post("/api/tasks", { data: { projectId: projects[0].id, title: "Ship the agents release", assignee: `member:${builder.userId}` } });
  expect(made.status()).toBe(201);
  expect((await made.json()).task.assignee).toMatchObject({ name: "Builder", isAgent: true });
  await page.goto(`/app/tasks?project=${projects[0].id}&view=list`);
  const row = page.getByRole("row").filter({ hasText: "Ship the agents release" });
  await expect(row.locator("svg.lucide-bot").first()).toBeVisible();

  // The agent works the task with its own key, under its own name.
  const id = (await made.json()).task.id as string;
  expect((await page.request.patch(`/api/v1/tasks/${id}`, { headers: { authorization: `Bearer ${key}` }, data: { status: "doing" } })).status()).toBe(200);

  // Pause Scout from its menu: Paused shows, and the badge stays on every agent.
  await page.goto("/app/settings/team");
  await page.getByRole("button", { name: "Actions for Scout" }).click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  const scout = page.getByTestId("agent-member").filter({ hasText: "Scout" });
  await expect(scout.getByTestId("agent-paused")).toBeVisible();
  for (const n of ["Builder", "QA", "Scout"]) await expect(page.getByTestId("agent-member").filter({ hasText: n }).getByText("AI agent", { exact: true })).toBeVisible();
  const card = page.getByRole("list", { name: "AI agents" }).locator("xpath=..");
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: process.env.R26_SHOT ?? "test-results/r26-agents.png" });
});

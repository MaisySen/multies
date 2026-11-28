import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Agent members, titles and bios, and weekly meeting series, end to end on a demo workspace:
 * add an AI agent in People and use its key, edit your own title, schedule a weekly series and
 * edit it as a whole.
 */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.92.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

test("adds an AI agent member in People and its key posts to chat under its name", async () => {
  await page.goto("/app/settings/team");
  await expect(page.getByRole("heading", { name: "AI agents" })).toBeVisible();
  await page.getByRole("button", { name: "Add agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an AI agent" });
  await dialog.getByLabel("Name").fill("QA bot");
  await dialog.getByLabel("Title").fill("Quality lead");
  await dialog.getByLabel("Bio").fill("An AI agent that runs the test suites.");
  await dialog.getByRole("button", { name: "Add agent" }).click();
  const key = (await page.getByTestId("agent-key").textContent())!.trim();
  expect(key).toMatch(/^mm_live_/);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const row = page.getByTestId("agent-member").filter({ hasText: "QA bot" });
  await expect(row.getByText("AI agent", { exact: true })).toBeVisible();
  await expect(row.getByText("Quality lead")).toBeVisible();

  const auth = { authorization: `Bearer ${key}` };
  const people = (await (await page.request.get("/api/v1/people", { headers: auth })).json()).people as { name: string; kind: string; title: string }[];
  expect(people.find((p) => p.name === "QA bot")).toMatchObject({ kind: "agent", title: "Quality lead" });
  const channels = (await (await page.request.get("/api/v1/chat/channels", { headers: auth })).json()).channels as { id: string; name: string }[];
  const general = channels.find((x) => x.name === "general") ?? channels[0];
  const posted = await page.request.post(`/api/v1/chat/channels/${general.id}/messages`, { headers: auth, data: { body: "Suite is green." } });
  expect(posted.status()).toBe(201);
  expect((await posted.json()).message.author.name).toBe("QA bot");
  // The member role: no workspace admin work.
  expect((await page.request.post("/api/v1/domains", { headers: auth, data: { name: "e2e-agent.example" } })).status()).toBe(403);
});

test("edits your own title and bio", async () => {
  await page.goto("/app/settings/team");
  const me = (await (await page.request.get("/api/account/me")).json()).user as { name: string };
  await page.getByRole("button", { name: `Actions for ${me.name}` }).first().click();
  await page.getByRole("menuitem", { name: "Edit title and bio" }).click();
  const dialog = page.getByRole("dialog", { name: `Profile for ${me.name}` });
  await dialog.getByLabel("Title").fill("Founder");
  await dialog.getByLabel("Bio").fill("Runs the company.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Runs the company.")).toBeVisible();
});

test("schedules a weekly series, lists its occurrences and edits the series", async () => {
  await page.goto("/app/meetings");
  await page.getByRole("button", { name: "Schedule" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule a meeting" });
  await dialog.getByLabel("Title").fill("Weekly product review");
  await dialog.getByLabel("Repeat").selectOption("1");
  await dialog.getByLabel("Ends").selectOption("count");
  await dialog.getByLabel("Meetings").fill("4");
  await dialog.getByRole("button", { name: "Save without inviting" }).click();
  await expect(page).toHaveURL(/\/app\/meetings\/mtg_/);
  await expect(page.getByTestId("meeting-series")).toContainText("Every week on");
  await expect(page.getByTestId("meeting-series")).toContainText("4 times");
  const id = page.url().split("/").pop()!;

  const ics = await page.request.get(`/api/meetings/${id}/ics`);
  expect(await ics.text()).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;");

  await page.goto("/app/meetings");
  await expect(page.getByTestId("meeting-row").filter({ hasText: "Weekly product review" })).toHaveCount(4);

  await page.goto(`/app/meetings/${id}`);
  await page.getByRole("button", { name: "Edit series" }).click();
  const edit = page.getByRole("dialog", { name: "Edit series" });
  await edit.getByLabel("Title").fill("Product review");
  await edit.getByLabel("Repeat").selectOption("2");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("meeting-series")).toContainText("Every 2 weeks");
  await expect(page.getByRole("heading", { name: "Product review", level: 1 })).toBeVisible();
});

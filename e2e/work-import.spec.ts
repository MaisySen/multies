import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { join } from "node:path";

/**
 * Round 20, moved to the R38 wizard: Settings, Import and export. Pick the Trello tile, upload the board JSON, check the
 * columns, people and statuses, preview, import into a new project, open it, then undo the whole import.
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

test("imports a Trello board through the wizard, then undoes it", async () => {
  await page.goto("/app/settings/import");
  await expect(page.getByRole("heading", { name: "Bring your work in" })).toBeVisible();
  await page.getByTestId("move-source-trello").click();
  const wizard = page.getByTestId("move-wizard");
  await expect(wizard.getByText("Export as JSON")).toBeVisible();
  await page.getByLabel("File to import").setInputFiles(join(process.cwd(), "tests/fixtures/import/trello.json"));
  await expect(wizard.getByText("5 tasks, 2 of them subtasks found")).toBeVisible();
  await wizard.getByRole("button", { name: "Next" }).click();
  await expect(wizard.getByRole("heading", { name: "Where it goes" })).toBeVisible();
  await wizard.getByLabel("Project name").fill("Website relaunch E2E");
  await wizard.getByRole("button", { name: "Next" }).click();
  const preview = wizard.getByRole("table", { name: "Import preview" });
  await expect(preview.getByText("Draft the headline")).toBeVisible();
  await wizard.getByRole("button", { name: "Import 5 tasks" }).click();
  await expect(wizard.getByText("Done: 5 tasks brought in")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("move-history-row").first()).toContainText("Tasks from Trello");
  // The tasks are in the project.
  const projectHref = await wizard.getByRole("link", { name: "Open project" }).getAttribute("href");
  await page.goto(projectHref!);
  await expect(page.getByText("Write the homepage copy").first()).toBeVisible();
  // Undo from History removes them again.
  await page.goto("/app/settings/import");
  const row = page.getByTestId("move-history-row").first();
  await row.getByRole("button", { name: /^Undo/ }).click();
  await page.getByRole("button", { name: "Undo import" }).click();
  await expect(row.getByText("Undone")).toBeVisible({ timeout: 20_000 });
  await page.goto(projectHref!);
  await expect(page.getByText("Write the homepage copy")).toHaveCount(0);
});

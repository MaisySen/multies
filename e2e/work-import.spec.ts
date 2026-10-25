import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { join } from "node:path";

/**
 * Round 20: Settings, Import, Work tools. Upload the Trello fixture, check the detected source and
 * the preview, change one column, import into a new project, then open the project and see the tasks.
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

test("imports a Trello board from Settings and shows its tasks in the project", async () => {
  await page.goto("/app/settings/import");
  await expect(page.getByRole("heading", { name: "Work tools" })).toBeVisible();
  await page.getByLabel("Export file").setInputFiles(join(process.cwd(), "tests/fixtures/import/trello.json"));
  await expect(page.getByText("From Trello")).toBeVisible();
  const preview = page.getByRole("table", { name: "Import preview" });
  // The card itself, and as the parent of its two checklist items (shown by title).
  await expect(preview.getByRole("cell", { name: "Write the homepage copy", exact: true })).toHaveCount(3);
  await expect(preview.getByText("Draft the headline")).toBeVisible();
  await expect(page.getByText("5 tasks, 2 of them subtasks")).toBeVisible();
  // The person can change the mapping: drop the labels column and the preview follows.
  await page.getByLabel("Labels", { exact: true }).selectOption("");
  await expect(preview.getByText("Design")).toHaveCount(0);
  await page.getByLabel("Project name").fill("Website relaunch E2E");
  await page.getByRole("button", { name: "Import 5 tasks" }).click();
  await expect(page.getByText("Imported 5 tasks into Website relaunch E2E.")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 1800 });
  await page.locator("#work-tools").screenshot({ path: process.env.E2E_SHOT ?? "test-results/work-import.png" }).catch(() => {});
  // Importing the same file again adds nothing.
  await expect(page.getByText("5 are already in Multies and will be skipped.")).toBeVisible();
  await page.getByRole("link", { name: "Open project" }).click();
  await expect(page).toHaveURL(/\/app\/tasks\?project=/);
  await expect(page.getByText("Write the homepage copy").first()).toBeVisible();
  await expect(page.getByText("Pick photos").first()).toBeVisible();
});

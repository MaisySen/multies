import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { join } from "node:path";

/**
 * R38 move your data: a CSV import through the wizard with a person mapped to "Leave unassigned", the progress ring,
 * Undo from the summary, and a full workspace export whose link downloads a ZIP.
 */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.93.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

test("imports a CSV through the wizard and undoes it from the summary", async () => {
  await page.goto("/app/settings/import");
  await page.getByTestId("move-source-csv").click();
  const wizard = page.getByTestId("move-wizard");
  await page.getByLabel("File to import").setInputFiles(join(process.cwd(), "tests/fixtures/import/e2e-move.csv"));
  await expect(wizard.getByText("3 tasks found")).toBeVisible();
  await expect(wizard.getByLabel("Title", { exact: true })).toHaveValue("Name");
  await wizard.getByRole("button", { name: "Next" }).click();
  await expect(wizard.getByText("Robin Field")).toBeVisible();
  await expect(wizard.getByLabel("Assign tasks for Robin Field")).toHaveValue("none");
  await wizard.getByLabel("Project name").fill("Kickoff E2E");
  await wizard.getByRole("button", { name: "Next" }).click();
  await expect(wizard.getByRole("table", { name: "Import preview" }).getByText("Book the venue")).toBeVisible();
  await wizard.getByRole("button", { name: "Import 3 tasks" }).click();
  await expect(wizard.getByText("Done: 3 tasks brought in")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("progressbar", { name: "Import progress" })).toHaveAttribute("aria-valuenow", "100");
  await wizard.getByTestId("move-undo").click();
  await page.getByRole("button", { name: "Undo import" }).click();
  await expect(wizard.getByText("Undone. Everything this import made is gone.")).toBeVisible({ timeout: 20_000 });
});

test("exports the workspace and the link downloads a ZIP", async () => {
  await page.goto("/app/settings/import");
  await page.getByTestId("move-export-start").click();
  await expect(page.getByText("Your export is ready")).toBeVisible({ timeout: 30_000 });
  const href = await page.getByTestId("move-download").getAttribute("href");
  expect(href).toMatch(/\/api\/data-moves\/exports\/.+\/download\?token=/);
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("zip");
  const body = await res.body();
  expect(body.subarray(0, 2).toString()).toBe("PK");
  // A second export within 10 minutes is refused.
  await page.reload();
  await page.getByTestId("move-export-start").click();
  await expect(page.getByRole("alert")).toContainText(/minute/);
});

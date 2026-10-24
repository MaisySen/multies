import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Round 13 end to end: the sidebar groups, a domain's setup records with copy buttons, and
 * Save as template from the doc editor.
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

test("sidebar: grouped into Work, Mail and Admin, with Shared inbox under Mail", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const nav = page.getByRole("navigation", { name: "App" });
  await expect(nav.getByTestId("nav-group")).toHaveText(["Work", "Mail", "Admin"]);
  await expect(nav.getByRole("link", { name: "Shared inbox" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Team inbox" })).toHaveCount(0);
});

test("domains: the setup page lists every record with copy buttons", async () => {
  await page.goto("/app/domains");
  await page.locator('a[href^="/app/domains/dom_"]').first().click();
  await expect(page).toHaveURL(/\/app\/domains\/dom_/);
  for (const t of ["Ownership", "Inbound mail (MX)", "Sender policy (SPF)", "Signing key (DKIM)", "Policy (DMARC)"]) {
    await expect(page.getByRole("heading", { name: t })).toBeVisible();
  }
  expect(await page.getByRole("button", { name: /to clipboard$/ }).count()).toBeGreaterThanOrEqual(10);
});

test("docs: Save as template from the editor", async () => {
  await page.goto("/app/docs");
  await page.locator('a[href^="/app/docs/doc_"]').first().click();
  await expect(page).toHaveURL(/\/app\/docs\/doc_/);
  const title = await page.getByLabel("Doc title").inputValue();
  await page.getByRole("button", { name: "Save as template" }).click();
  await expect(page.getByText("Saved as a doc template")).toBeVisible();
  await page.goto("/app/templates");
  await expect(page.getByTestId("template-card").filter({ hasText: title || "Untitled" }).first()).toBeVisible();
});

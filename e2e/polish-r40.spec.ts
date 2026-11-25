import { test, expect, type Page } from "@playwright/test";

/**
 * R40 polish (QA MB-206 to MB-218): Start now on Meetings, the New project button and templates, Add another in
 * New task, the always visible column add button at 390 px, the phone Filter sheet, sign up straight into the app,
 * and no sideways scroll at 390 px.
 */
let visitor = 0;
const ip = () => `10.141.${test.info().workerIndex % 200}.${++visitor}`;

async function signUp(page: Page, name = "Polly Polish") {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(`polish-r40-${Date.now()}-${visitor}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  // MB-218: straight into the app, no /thanks stop, with a one time welcome toast.
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
  await expect(page.getByText("Welcome to Multies")).toBeVisible();
}

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("Start now opens a meeting at once and Schedule stays one tap away", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await signUp(page);
  await page.goto("/app/meetings");
  await expect(page.getByRole("button", { name: "Schedule" })).toBeVisible();
  await page.getByTestId("meeting-start-now").click();
  await expect(page).toHaveURL(/\/app\/meetings\/[^/?]+\?join=1$/);
  await expect(page.getByText(/Meeting started/)).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  expect(copied).toMatch(/\/meet\/|\/m\/|guest|join/i);
  await ctx.close();
});

test("New project starts from a template, statuses under Customize; Add another keeps the dialog open", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await signUp(page);
  await page.goto("/app/tasks");
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: /Kanban/ })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByLabel("Status name").first()).toBeHidden();
  await dialog.getByTestId("template-simple").click();
  await dialog.getByRole("button", { name: "Customize" }).click();
  await expect(dialog.getByLabel("Status name")).toHaveCount(2);
  await dialog.getByLabel("Name", { exact: true }).fill("Launch R40");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("button", { name: "New task" }).first().click();
  const nt = page.getByRole("dialog");
  await nt.getByLabel("Add another").check();
  for (const t of ["First", "Second", "Third"]) {
    await nt.getByLabel("Title").fill(t);
    await nt.getByLabel("Title").press("Enter");
    await expect(nt.getByLabel("Title")).toHaveValue("");
  }
  await expect(nt).toBeVisible();
  await nt.getByRole("button", { name: "Done", exact: true }).click();
  await ctx.close();
});

test("390 px: column add button visible, Filter sheet with chips, no sideways scroll", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await signUp(page);
  await page.goto("/app/tasks?view=board");
  await expect(page.getByRole("button", { name: /^Add a task to / }).first()).toBeVisible();
  // MB-209: one Filter button instead of four browser selects.
  await expect(page.getByLabel("Priority filter")).toBeHidden();
  await page.getByTestId("phone-filter-button").click();
  const sheet = page.getByRole("dialog", { name: "Filter" });
  await sheet.getByRole("radiogroup", { name: "Priority" }).getByRole("radio", { name: "High" }).click();
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByTestId("filter-chip")).toHaveText(/High/);
  await expect(page).toHaveURL(/priority=high/);
  await page.getByRole("button", { name: "Clear priority filter" }).click();
  await expect(page.getByTestId("filter-chip")).toHaveCount(0);
  expect(await noSideways(page)).toBe(true);
  for (const path of ["/app/meetings", "/app/tasks", "/app", "/app/settings/import", "/app/settings/sign-up-emails"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await noSideways(page), path).toBe(true);
  }
  await ctx.close();
});

test("API key name has a linked label; import tile names the other workspace", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await signUp(page);
  await page.goto("/app/settings/developers");
  await page.getByRole("button", { name: "Create API key" }).click();
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "Name" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/app/settings/import");
  await expect(page.getByText("From another Multies workspace")).toBeVisible();
  await ctx.close();
});

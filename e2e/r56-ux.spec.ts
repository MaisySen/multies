import { test, expect, type Page } from "@playwright/test";

/** R56 small fixes from QA pass 4: MB-243 (New task focuses its title). */
let visitor = 0;
const ip = () => `10.156.${test.info().workerIndex % 200}.${++visitor}`;

async function signUp(page: Page, name = "Nina Newtask") {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(`r56-${Date.now()}-${visitor}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

for (const vp of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }]) {
  test(`New task opens with the title focused, not Close (MB-243, ${vp.name})`, async ({ browser }) => {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() }, viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await signUp(page);
    await page.goto("/app/tasks");
    await page.getByRole("button", { name: "New task" }).first().click();
    const nt = page.getByRole("dialog");
    await expect(nt.getByLabel("Title")).toBeFocused();
    await page.keyboard.type("Typed straight away");
    await expect(nt.getByLabel("Title")).toHaveValue("Typed straight away");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await ctx.close();
  });
}

test("Reply from the shared inbox in the Mail composer, and the draft survives a reload (MB-242, MB-244)", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /Password reset not arriving/ }).click();
  const bar = page.getByTestId("inbox-reply-bar");
  await expect(bar.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Reply all" })).toBeVisible();
  await bar.getByRole("button", { name: "Reply", exact: true }).click();
  const body = page.locator("textarea").first();
  await expect(body).toBeVisible();
  await expect(page).toHaveURL(/\/app\/inbox/);
  const words = `Checking this now ${Date.now()}`;
  await body.press("Home");
  await body.pressSequentially(words, { delay: 5 });
  await expect(page.getByTestId("draft-autosave")).toHaveText("Saved", { timeout: 15_000 });
  await page.reload();
  await page.goto("/app/mail?folder=drafts");
  await expect(page.getByText(words).first()).toBeVisible({ timeout: 15_000 });
});

test("the reply buttons fit a phone and notes stay separate (MB-242, phone)", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /Password reset not arriving/ }).click();
  const bar = page.getByTestId("inbox-reply-bar");
  await expect(bar.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
  const box = await bar.getByRole("button", { name: "Reply", exact: true }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(bar.getByText("Team notes below stay inside your team.")).toBeVisible();
});

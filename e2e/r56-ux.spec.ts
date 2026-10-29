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

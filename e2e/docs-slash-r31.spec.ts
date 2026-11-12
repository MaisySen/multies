import { test, expect, type Browser } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R31: the docs "/" menu. "/" then "head" and Enter makes a heading; "/" then "to" makes a
 * to-do; arrows and Escape work; a second person in the same doc sees each block once and no menu.
 */
let visitor = 0;
const ip = () => `10.132.${test.info().workerIndex % 200}.${++visitor}`;

async function signUp(browser: Browser) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, timezoneId: "UTC", colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return { ctx, page, headers, base };
}

const SHOTS = `${SHOTS_ROOT}/multies-r31`;

test("slash menu: heading, to-do, keyboard, and one copy for a second person", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page, headers } = await signUp(browser);
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Launch notes", text: "Intro line." }, headers })).json()).doc as { id: string };
  await page.goto(`/app/docs/${doc.id}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("Intro line.");
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("group", { name: "Basic" })).toBeVisible();
  await expect(menu.getByRole("group", { name: "Lists" })).toBeVisible();
  await page.keyboard.type("head");
  await expect(menu.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByTestId("slash-h2")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await page.screenshot({ path: `${SHOTS}/docs-slash.png` });
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await page.keyboard.type("Goals");
  await expect(page.locator(".ProseMirror h1", { hasText: "Goals" })).toBeVisible();
  await expect(editor).not.toContainText("/head");

  await page.keyboard.press("Enter");
  await page.keyboard.type("/to");
  await expect(menu.getByRole("option").first()).toContainText("To-do list");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Book the venue");
  await expect(page.locator('.ProseMirror ul[data-type="taskList"] li', { hasText: "Book the venue" })).toBeVisible();

  // Escape closes the menu and leaves the slash as typed text.
  await page.keyboard.press("Enter");
  await page.keyboard.type("and/or /zz");
  await expect(menu).toContainText('No blocks match "zz"');
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(editor).toContainText("and/or /zz");

  // A second person in the same doc: each block once, and no menu of theirs.
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
  const other = await ctx.newPage();
  await other.goto(`/app/docs/${doc.id}`);
  await expect(other.locator(".ProseMirror h1", { hasText: "Goals" })).toHaveCount(1, { timeout: 15_000 });
  await expect(other.locator(".ProseMirror li", { hasText: "Book the venue" })).toHaveCount(1);
  await expect(other.getByTestId("slash-menu")).toHaveCount(0);
  await ctx.close();
});

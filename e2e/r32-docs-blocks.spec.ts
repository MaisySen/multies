import { test, expect, type Browser } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R32: docs table, image and callout blocks. "/table" Enter makes a 3 by 3 table with a header
 * row and the table menu adds a row; "/callout" makes a callout whose icon switches the variant;
 * "/image" with a link and alt text inserts an image with that alt.
 */
let visitor = 0;
const ip = () => `10.133.${test.info().workerIndex % 200}.${++visitor}`;

async function signUp(browser: Browser) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, timezoneId: "UTC", colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return { ctx, page, headers };
}

// A tiny PNG served by the test itself, so no outside network is needed.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("docs blocks: table, callout and image from the slash menu", async ({ browser }) => {
  test.setTimeout(240_000);
  const { ctx, page, headers } = await signUp(browser);
  await page.route("https://images.example.com/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Launch plan", text: "Owners and dates for the launch." }, headers })).json()).doc as { id: string };
  await page.goto(`/app/docs/${doc.id}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("Owners and dates");
  await editor.click();
  await editor.press("Control+End");

  // Callout
  await page.keyboard.press("Enter");
  await page.keyboard.type("/callout");
  const menu = page.getByTestId("slash-menu");
  await expect(menu.getByRole("option").first()).toContainText("Callout");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ship on Friday after the review.");
  const callout = editor.locator('[data-callout="info"]');
  await expect(callout).toContainText("Ship on Friday");
  await callout.getByTestId("callout-icon").click();
  await expect(editor.locator('[data-callout="success"]')).toContainText("Ship on Friday");

  // Table (leave the callout first)
  await editor.locator("p", { hasText: "Owners and dates" }).click();
  await editor.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  await expect(menu.getByRole("option").first()).toContainText("Table");
  await page.keyboard.press("Enter");
  const table = editor.locator("table");
  await expect(table.locator("tr")).toHaveCount(3);
  await expect(table.locator("th")).toHaveCount(3);
  await page.keyboard.type("Task");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Owner");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Due");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Press kit");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Ana");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Thu");
  await expect(table.locator("th").nth(1)).toHaveText("Owner");
  const tmenu = page.getByTestId("table-menu");
  await expect(tmenu).toBeVisible();
  await tmenu.getByRole("button", { name: "Add row below" }).click();
  await expect(table.locator("tr")).toHaveCount(4);

  // Image by link with alt text
  await editor.locator("p", { hasText: "Owners and dates" }).click();
  await editor.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/image");
  await expect(menu.getByRole("option").first()).toContainText("Image");
  await page.keyboard.press("Enter");
  const dlg = page.getByTestId("image-dialog");
  await expect(dlg).toBeVisible();
  await dlg.getByTestId("image-url").fill("https://images.example.com/launch.png");
  await dlg.getByTestId("image-alt").fill("Launch timeline");
  await dlg.getByTestId("image-insert").click();
  await expect(dlg).toHaveCount(0);
  const img = editor.locator('img[alt="Launch timeline"]');
  await expect(img).toHaveAttribute("src", "https://images.example.com/launch.png");
  await img.click();
  const bar = page.getByTestId("image-toolbar");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Wide" }).click();
  await expect(editor.locator('img[alt="Launch timeline"][data-size="wide"]')).toBeVisible();

  // Saved: the stored doc has all three blocks.
  await expect(page.locator('span[role="status"]')).toHaveText("Saved", { timeout: 20_000 }); // the save line, not the drag and drop live region
  const saved = (await (await page.request.get(`/api/docs/${doc.id}`)).json()).doc as { content: { content: { type: string }[] } };
  const types = saved.content.content.map((n) => n.type);
  for (const t of ["callout", "table", "image"]) expect(types).toContain(t);

  await page.mouse.click(1300, 120);
  const shots = "/home/user/tab/files/multies-r32";
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/docs-blocks.png` });
  await ctx.close();
});

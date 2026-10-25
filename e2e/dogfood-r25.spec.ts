import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * R25 dogfood: a mailbox's default Reply-To from Settings, Mailboxes (MB-61), and the goal
 * countdown that reads "down to" (DF-5).
 */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.95.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

test("mailboxes: set a default Reply-To, see it on the row, clear it", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/mailboxes");
  const actions = page.getByRole("button", { name: /^Actions for / }).first();
  await expect(actions).toBeVisible();
  const address = ((await actions.getAttribute("aria-label")) ?? "").replace("Actions for ", "");
  await actions.click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const field = page.getByLabel("Replies go to");
  await expect(field).toBeVisible();
  await field.fill("support@example.com");
  if (process.env.R25_DOGFOOD_SHOT) await page.screenshot({ path: process.env.R25_DOGFOOD_SHOT });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Mailbox updated")).toBeVisible();
  await expect(page.getByText(/replies to support@example\.com/)).toBeVisible();
  const list = await page.evaluate(async () => (await (await fetch("/api/mailboxes")).json()) as { mailboxes: { address: string; replyTo: string | null }[] });
  expect(list.mailboxes.find((m) => m.address === address)?.replyTo).toBe("support@example.com");

  await page.getByRole("button", { name: `Actions for ${address}` }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByLabel("Replies go to").fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/replies to support@example\.com/)).toHaveCount(0);
});

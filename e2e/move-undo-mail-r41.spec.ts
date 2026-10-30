import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * R41 move: a mail archive (.mbox) import can be undone from the history like any other import. The 3 messages
 * it brought in are deleted and the row shows Undone. SHOTS=after saves move-after-undo-mail-* (desktop and phone,
 * light and dark) in files/multies-r41.
 */
test.describe.configure({ mode: "serial" });
const SHOT_DIR = "/home/user/tab/files/multies-r41";
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1280, height: 900 } });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.95.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

async function shots(what: string) {
  if (process.env.SHOTS !== "after") return;
  mkdirSync(SHOT_DIR, { recursive: true });
  for (const [form, size] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      await page.locator("#move-history").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOT_DIR}/move-after-${what}-${form}-${scheme}.png`, type: "png" });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

test("a mail archive import shows Undo in the history, and Undo removes its messages", async () => {
  test.setTimeout(90_000);
  await page.goto("/app/settings/import");
  await page.getByTestId("move-source-mbox").click();
  const card = page.getByTestId("mbox-import");
  await page.getByLabel("Mail archive file").setInputFiles(join(process.cwd(), "tests/fixtures/import/e2e-archive.mbox"));
  await card.getByTestId("mbox-start").click();
  await expect(card.getByTestId("mbox-progress")).toHaveText("Done: 3 messages brought in", { timeout: 20_000 });
  await card.getByRole("button", { name: "Close" }).click();

  const row = page.getByTestId("move-history-row").filter({ hasText: "Mail archive import" }).first();
  await expect(row).toContainText("3 messages brought in", { timeout: 15_000 });
  await row.getByRole("button", { name: "Undo Mail archive import" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("deletes the 3 messages it brought in");
  await dialog.getByRole("button", { name: "Undo import" }).click();
  await expect(row.getByText("Undone")).toBeVisible({ timeout: 15_000 });
  await expect(row.getByRole("button", { name: "Undo Mail archive import" })).toHaveCount(0);
  await shots("undo-mail");

  // The messages are gone: the same archive imports all 3 again instead of skipping them as already there.
  await page.getByTestId("move-source-mbox").click();
  await page.getByLabel("Mail archive file").setInputFiles(join(process.cwd(), "tests/fixtures/import/e2e-archive.mbox"));
  await page.getByTestId("mbox-start").click();
  await expect(page.getByTestId("mbox-progress")).toHaveText("Done: 3 messages brought in", { timeout: 20_000 });
});

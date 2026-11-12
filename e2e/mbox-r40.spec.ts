import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R40 move: upload a small .mbox in Settings, Import and export, watch the count, and run it again to see every
 * message skipped as already there. SHOTS=before|after also saves light and dark shots, desktop and phone.
 */
test.describe.configure({ mode: "serial" });
const SHOT_DIR = `${SHOTS_ROOT}/multies-r40`;
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1280, height: 900 } });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.94.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

async function shots(what: string) {
  const tag = process.env.SHOTS;
  if (!tag) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  for (const [form, size] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      const target = page.getByTestId("mbox-import");
      const el = (await target.count()) ? target : page.getByRole("list", { name: "Import from" });
      await el.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOT_DIR}/move-${tag}-${what}-${form}-${scheme}.png`, type: "png" });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

test("before: the source picker", async () => {
  test.skip(process.env.SHOTS !== "before");
  await page.goto("/app/settings/import");
  await expect(page.getByRole("list", { name: "Import from" })).toBeVisible();
  await shots("picker");
});

test("uploads an mbox in batches, then a second run skips every message", async () => {
  test.skip(process.env.SHOTS === "before");
  await page.goto("/app/settings/import");
  await page.getByTestId("move-source-mbox").click();
  const card = page.getByTestId("mbox-import");
  await expect(card.getByText("Bring in a mail archive")).toBeVisible();
  await shots("pick");
  await page.getByLabel("Mail archive file").setInputFiles(join(process.cwd(), "tests/fixtures/import/e2e-archive.mbox"));
  await card.getByTestId("mbox-start").click();
  await expect(card.getByTestId("mbox-progress")).toHaveText("Done: 3 messages brought in", { timeout: 20_000 });
  await expect(page.getByRole("progressbar", { name: "Mail import progress" })).toHaveAttribute("aria-valuenow", "100");
  await shots("done");
  await card.getByRole("button", { name: "Close" }).click();

  await page.getByTestId("move-source-mbox").click();
  await page.getByLabel("Mail archive file").setInputFiles(join(process.cwd(), "tests/fixtures/import/e2e-archive.mbox"));
  await page.getByTestId("mbox-start").click();
  await expect(page.getByTestId("mbox-progress")).toHaveText("Done: 0 messages brought in", { timeout: 20_000 });
  await expect(page.getByTestId("mbox-skipped")).toHaveText("3 already here");
});

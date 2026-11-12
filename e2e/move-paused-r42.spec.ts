import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R42 move: the import page says what really happens when an import is paused. Imports run only while their page is
 * open, so a paused run says so, Carry on continues the same run (no second run), and a paused history row says to
 * choose the same file again. The paused answer is staged by rewriting the first step's reply (a real pause needs
 * 15 seconds of work). SHOTS=after saves move-after-copy-* (desktop and phone, light and dark) in files/multies-r42.
 */
test.describe.configure({ mode: "serial" });
const SHOT_DIR = `${SHOTS_ROOT}/multies-r42`;
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1280, height: 900 } });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.96.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

async function shots(what: string, target: string) {
  if (process.env.SHOTS !== "after") return;
  mkdirSync(SHOT_DIR, { recursive: true });
  for (const [form, size] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      await page.getByTestId(target).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOT_DIR}/move-after-copy-${what}-${form}-${scheme}.png`, type: "png" });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

test("a paused import says the page must stay open, and Carry on continues the same run", async () => {
  test.setTimeout(120_000);
  await page.goto("/app/settings/import");
  await page.getByTestId("move-source-csv").click();
  const wizard = page.getByTestId("move-wizard");
  await page.getByLabel("File to import").setInputFiles(join(process.cwd(), "tests/fixtures/import/e2e-move.csv"));
  await expect(wizard.getByText("3 tasks found")).toBeVisible();
  await wizard.getByRole("button", { name: "Next" }).click();
  await wizard.getByLabel("Project name").fill("Paused R42");
  await wizard.getByRole("button", { name: "Next" }).click();

  // The first step's real reply is rewritten as a run paused after 1 of 3 (what a closed page leaves behind).
  const bodies: Record<string, unknown>[] = [];
  let first = true;
  await page.route("**/api/data-moves/imports/run", async (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? "{}"));
    const res = await route.fetch();
    const json = await res.json();
    if (first) { first = false; json.move = { ...json.move, status: "stopped", done: 1, created: 1 }; json.stopped = null; }
    await route.fulfill({ response: res, json });
  });
  await wizard.getByRole("button", { name: "Import 3 tasks" }).click();
  await expect(wizard.getByText("1 of 3 in so far")).toBeVisible({ timeout: 30_000 });
  await expect(wizard.getByTestId("move-paused-note")).toHaveText("Imports run only while this page is open. Carry on now, or choose the same file again later and it picks up where it stopped.");
  await shots("paused", "move-wizard");

  await wizard.getByRole("button", { name: "Carry on" }).click();
  await expect(wizard.getByText(/^Done: \d+ tasks brought in$/)).toBeVisible({ timeout: 30_000 });
  expect(bodies).toHaveLength(2);
  expect(bodies[0].moveId ?? null).toBeNull();
  expect(typeof bodies[1].moveId).toBe("string"); // the same run carries on, never a second run
  await page.unroute("**/api/data-moves/imports/run");

  // A paused row in the history says how to carry on.
  await page.route("**/api/data-moves", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    if (json.items?.[0]) json.items[0] = { ...json.items[0], status: "stopped", done: 1, created: 1 };
    await route.fulfill({ response: res, json });
  });
  await page.reload();
  const row = page.getByTestId("move-history-row").first();
  await expect(row).toContainText("Choose the same file again to carry on", { timeout: 15_000 });
  await expect(row).toContainText("Paused");
  await shots("history", "move-history-row");
  await page.unroute("**/api/data-moves");
});

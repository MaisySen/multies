import { test, expect, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tools P2, H7: the three editors end to end in a browser: page editor, form filler and compare.
 * Local only, against a server with Tools on (TOOLS_FEATURES including editor, forms, compare) and the
 * stand in engine e2e/support/editors-engine.mjs (EDITORS_E2E=1, E2E_BASE_URL=http://localhost:PORT).
 * EDITORS_SHOTS=<dir> also writes the screenshots (1280 and 390, light and dark).
 */
const FIX = "e2e/fixtures/tools";
const SHOTS = process.env.EDITORS_SHOTS;
test.skip(process.env.EDITORS_E2E !== "1", "needs a server with the editors on and the stand in engine");
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  const email = `editors${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  const r = await page.request.post("/api/auth/sign-up/email", { data: { name: "Edie Editor", email, password: "a-strong-password" } });
  expect(r.status()).toBe(200);
  const done = await page.request.post("/api/account/onboarding", { data: { name: "Edie Editor", timezone: "Australia/Sydney", locale: "en-AU", company: "Editors Test Co", workspaceTimezone: "Australia/Sydney" } });
  expect(done.status()).toBeLessThan(300);
}

async function shots(page: Page, name: string, setup?: () => Promise<void>) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const [vp, w, h] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      if (setup) await setup();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(SHOTS, `editors-${name}-${vp}-${scheme}.png`), fullPage: vp === "phone" ? false : true, type: "png" });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 860 });
}

const order = async (page: Page) => page.getByTestId("page-tile").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-page")}:${e.getAttribute("data-rotate")}`));

test("page editor: reorder by keyboard, turn, delete, undo, save", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/tools/pages");
  await expect(page.getByTestId("page-editor")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("page-editor-pdf-input").setInputFiles(join(FIX, "sample-a.pdf"));
  await expect(page.getByTestId("page-tile")).toHaveCount(6, { timeout: 30_000 });
  expect(await order(page)).toEqual(["1:0", "2:0", "3:0", "4:0", "5:0", "6:0"]);
  await expect(page.getByTestId("page-save")).toBeDisabled();

  // Keyboard: pick up page 1, move it one place right, drop it.
  const first = page.getByTestId("page-tile").first().getByRole("button", { name: /^Page 1\b/ });
  await first.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  await page.keyboard.press("Space");
  await expect.poll(() => order(page)).toEqual(["2:0", "1:0", "3:0", "4:0", "5:0", "6:0"]);

  await page.getByRole("button", { name: "Turn page 3 right" }).click();
  await page.getByRole("button", { name: "Turn page 4 left" }).click();
  await page.getByRole("button", { name: "Delete page 6" }).click();
  expect(await order(page)).toEqual(["2:0", "1:0", "3:90", "4:270", "5:0"]);
  await page.getByTestId("page-undo").click();
  expect(await order(page)).toEqual(["2:0", "1:0", "3:90", "4:270", "5:0", "6:0"]);
  await page.getByRole("button", { name: "Delete page 6" }).click();
  await expect(page.getByTestId("page-summary")).toHaveText("5 pages: new order, 2 turned, 1 deleted");
  await page.mouse.move(0, 0);
  await shots(page, "pages-grid", async () => { await page.getByTestId("page-grid-card").scrollIntoViewIfNeeded(); });

  await page.getByTestId("page-save").click();
  await expect(page.getByTestId("editor-download")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("editor-result-name")).toHaveText("sample-a-edited.pdf");
  await expect(page.getByTestId("editor-facts")).toHaveText("5 pages.");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("editor-download").click()]);
  expect(readFileSync((await dl.path())!).subarray(0, 5).toString()).toBe("%PDF-");
  await shots(page, "pages-done");
});

test("form filler: fields as a form, required marks, flatten, fill; a PDF with no fields says so", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/tools/forms");
  await page.getByTestId("form-pdf-input").setInputFiles(join(FIX, "sample-b.pdf"));
  await expect(page.getByTestId("form-card")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("form-field")).toHaveCount(6);
  await expect(page.getByTestId("form-signature")).toBeVisible();
  await page.getByLabel("Full name").fill("Jane Citizen");
  await page.getByLabel("Email").fill("jane@example.com");
  await page.getByLabel("State").selectOption("NSW");
  await page.getByText("Yearly", { exact: true }).click();
  await expect(page.getByTestId("form-missing")).toHaveText("1 required field is still empty.");
  await page.getByRole("checkbox", { name: /Agree terms/ }).check();
  await page.getByTestId("form-flatten").getByRole("switch").click();
  await shots(page, "forms-filled");
  await page.getByTestId("form-fill").click();
  await expect(page.getByTestId("editor-download")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("editor-facts")).toHaveText("5 fields filled in, flattened so it cannot be changed.");
  await expect(page.getByTestId("editor-result-name")).toHaveText("sample-b-filled.pdf");

  const none = join(tmpdir(), "no-fields-letter.pdf");
  copyFileSync(join(FIX, "sample-a.pdf"), none);
  await page.goto("/app/tools/forms");
  await page.getByTestId("form-pdf-input").setInputFiles(none);
  await expect(page.getByTestId("form-empty")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("form-empty")).toContainText("This PDF has no form fields");
  await shots(page, "forms-none");
});

test("compare: two versions, summary, colour coded change list, report", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/tools/compare");
  await page.getByTestId("compare-older-input").setInputFiles(join(FIX, "sample-a.pdf"));
  await page.getByTestId("compare-newer-input").setInputFiles(join(FIX, "sample-b.pdf"));
  await shots(page, "compare-pick");
  await page.getByTestId("compare-run").click();
  await expect(page.getByTestId("compare-changes")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("compare-page")).toHaveCount(3);
  await expect(page.getByTestId("compare-added")).toHaveCount(2);
  await expect(page.getByTestId("compare-removed")).toHaveCount(3);
  await expect(page.getByTestId("compare-summary")).toContainText("23");
  await expect(page.getByTestId("editor-result-name")).toHaveText("sample-b-changes.pdf");
  await shots(page, "compare-done");
});

import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";

/**
 * R82F: the Tools half of the QA9 fixes. MB-276 a bad Split range keeps Run off and the range comes back after a
 * reload; MB-275 Ctrl K finds Split PDF; MB-286 Convert asks before a reload loses the picked files; R78 leftover: a
 * PNG asked to be PNG shows its own picture in the results. Needs the Tools server (TOOLS_P2_E2E=1, E2E_BASE_URL).
 */
const FIX = "e2e/fixtures/tools";
const CFIX = "e2e/fixtures/convert";
test.skip(process.env.TOOLS_P2_E2E !== "1", "needs a server with Tools on and the stand in engine");

async function signIn(page: Page) {
  const email = `r82ftools${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Tia Tools", email, password: "a-strong-password" } })).status()).toBe(200);
  expect((await page.request.post("/api/account/onboarding", { data: { name: "Tia Tools", timezone: "Australia/Sydney", locale: "en-AU", company: "Tools Test Co", workspaceTimezone: "Australia/Sydney" } })).status()).toBeLessThan(300);
}

test("MB-276 a wrong Split range keeps Run off, and the range survives a reload", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/app/tools?op=split");
  await page.getByTestId("tools-input").setInputFiles(join(FIX, "sample-a.pdf"));
  await expect(page.getByTestId("split-presets")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("split-custom").click();
  const field = page.getByTestId("tools-options").getByRole("textbox").first();
  await field.fill("3-1");
  await expect(page.getByTestId("split-preview")).toContainText(/./);
  await expect(page.getByTestId("split-preview").locator(".text-bad")).toBeVisible();
  await expect(page.getByTestId("tools-run")).toBeDisabled();
  await field.fill("1-2, 99");
  await expect(page.getByTestId("tools-run")).toBeDisabled();
  await field.fill("1");
  await expect(page.getByTestId("split-preview").locator(".text-bad")).toHaveCount(0);
  await expect(page.getByTestId("tools-run")).toBeEnabled();
  await page.waitForTimeout(500);
  page.once("dialog", (d) => void d.accept());
  await page.reload();
  await expect(page.getByTestId("split-presets")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("split-custom")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("tools-options").getByRole("textbox").first()).toHaveValue("1");
});

test("MB-275 Ctrl K finds Split PDF by name", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/app/my-work");
  await page.getByTestId("topbar-search-entry").click();
  await page.getByRole("combobox").first().fill("split");
  const hit = page.getByRole("option", { name: /^Split PDF/ }).first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(/\/app\/tools\?op=split/);
});

test("MB-286 Convert asks before a reload loses the picked files; a PNG kept as PNG shows its picture", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/app/tools/convert");
  await expect(page.getByTestId("convert-drop")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("convert-input").setInputFiles([join(CFIX, "photo-a.png"), join(CFIX, "photo-b.jpg")]);
  await expect(page.getByTestId("convert-file")).toHaveCount(2);
  await page.getByTestId("convert-hub").click({ position: { x: 5, y: 5 } }); // a real gesture, as the browser needs for its question
  let asked = "";
  page.once("dialog", (d) => { asked = d.type(); void d.dismiss(); });
  await page.reload({ timeout: 3000 }).catch(() => {}); // the reload is called off, so it never finishes
  await expect.poll(() => asked).toBe("beforeunload");
  await expect(page.getByTestId("convert-file")).toHaveCount(2);
  // Both to PNG: the one already PNG is kept as it is, and its row shows the picture, not only a tick.
  await page.getByTestId("convert-to-png").click();
  await page.getByTestId("convert-run").click();
  await expect(page.locator('[data-testid="convert-job"][data-status="done"]')).toHaveCount(2, { timeout: 15_000 });
  const kept = page.getByTestId("convert-job").filter({ hasText: "photo-a.png · " });
  await expect(kept).toHaveCount(1);
  await expect(kept.locator("img")).toHaveCount(1);
});

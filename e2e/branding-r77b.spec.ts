import { test, expect, type Page } from "@playwright/test";

/**
 * R77B: every action on Settings, Branding and Appearance, after the owner said it "didn't work" and was not
 * interactive. Picking a theme repaints the app at once, Discard puts it back, Save keeps it after a reload, a square
 * logo shows in the sidebar, a failed upload offers Try again, Reset asks first, and the layout has no overlap or
 * sideways scroll at 1600, 1280, 1024, 768 and 390.
 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAO0lEQVR4nO3OMREAIAwAsYIOBhSxYKeS8QAiypjf/y4tx7lRaK9Z2aOX7g8BAAAAAAAAAAAAAAAAAAA8hscDhK8XGPIAAAAASUVORK5CYII=", "base64");
const brandVar = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim().toLowerCase());
const previewBrand = (page: Page) => page.getByTestId("brand-preview").locator(".bg-brand").first().evaluate((e) => getComputedStyle(e).backgroundColor);

async function demo(page: Page) {
  if (!process.env.E2E_BASE_URL) await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `10.98.${test.info().workerIndex % 200}.${(Date.now() % 200) + 1}` });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

test("every branding action works and shows at once", async ({ page }) => {
  await demo(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  const bar = page.getByTestId("brand-actions");
  await expect(bar).toContainText("All changes saved");
  const start = await brandVar(page);

  // A theme click paints the preview and the whole app straight away, before saving.
  const p0 = await previewBrand(page);
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await expect(page.getByRole("button", { name: "Forest", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => previewBrand(page)).not.toBe(p0);
  await expect.poll(() => brandVar(page)).toBe("#137839");
  await expect(bar).toContainText("Unsaved changes");

  // Discard puts the saved look back.
  await bar.getByRole("button", { name: "Discard" }).click();
  await expect.poll(() => brandVar(page)).toBe(start);
  await expect(bar).toContainText("All changes saved");

  // Colours, corners, density and font all change the draft; Ctrl S saves.
  await page.getByLabel("Brand colour hex").fill("#0f766e");
  await expect.poll(() => brandVar(page)).toBe("#0f766e");
  await page.getByRole("radio", { name: "Round", exact: true }).click();
  await page.getByRole("radio", { name: "Compact", exact: true }).click();
  await page.getByRole("radio", { name: /Serif/ }).click();
  await page.keyboard.press("Control+s");
  await expect(bar).toContainText("Saved for everyone");
  await page.reload();
  await expect(page.getByTestId("branding-settings")).toBeVisible();
  await expect.poll(() => brandVar(page)).toBe("#0f766e");
  await expect(page.getByRole("radio", { name: "Round", exact: true })).toHaveAttribute("aria-checked", "true");

  // A theme then Save brand.
  await page.getByRole("button", { name: "Aubergine", exact: true }).click();
  await bar.getByRole("button", { name: "Save brand" }).click();
  await expect(bar).toContainText("Saved for everyone");

  // A failed upload says why and offers Try again, which then works.
  const row = page.getByTestId("logo-mark_light");
  await page.route("**/api/branding/logo/mark_light", (r) => (r.request().method() === "PUT" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Couldn't upload the logo." } }) }) : r.continue()));
  await row.locator("input[type=file]").setInputFiles({ name: "mark.png", mimeType: "image/png", buffer: PNG });
  await expect(row).toHaveAttribute("data-state", "error");
  await expect(row.getByRole("alert")).toContainText("Couldn't upload the logo");
  await page.unroute("**/api/branding/logo/mark_light");
  await row.getByRole("button", { name: "Try again" }).click();
  await expect(row).toHaveAttribute("data-state", "saved");
  await expect(row.locator("img")).toHaveCount(1);
  // The square logo shows at the top of the sidebar right away.
  await expect(page.getByTestId("workspace-mark-logo")).toBeVisible();

  // A wrong file type is refused with plain words.
  await page.getByTestId("logo-wide_light").locator("input[type=file]").setInputFiles({ name: "x.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
  await expect(page.getByTestId("logo-wide_light").getByRole("alert")).toContainText("PNG, JPEG or WebP");

  // Use my logo colours takes them from the uploaded logo.
  await page.getByRole("button", { name: "Use my logo colours" }).click();
  await expect(page.getByRole("button", { name: "Use my logo colours" })).toHaveAttribute("aria-pressed", "true");
  await expect(bar).toContainText("Unsaved changes");
  await bar.getByRole("button", { name: "Discard" }).click();

  // Remove asks first.
  await row.getByRole("button", { name: /Remove square logo/ }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row.locator("img")).toHaveCount(0);

  // Reset asks first, then brings back the Multies look.
  await page.getByRole("button", { name: "Reset to Multies default" }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(bar).toContainText("Saved for everyone");
  await expect(page.getByRole("button", { name: "Multies", exact: true })).toHaveAttribute("aria-pressed", "true");

  // Leaving with changes not saved puts the saved look back.
  await page.getByRole("button", { name: "Berry", exact: true }).click();
  await expect.poll(() => brandVar(page)).toBe("#be185d");
  await page.goto("/app/settings/general");
  await expect.poll(() => brandVar(page)).not.toBe("#be185d");
});

test("Appearance: the whole switch row toggles, an own accent applies at once", async ({ page }) => {
  await demo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/settings/appearance");
  await expect(page.getByTestId("appearance-settings")).toBeVisible({ timeout: 20_000 });
  const row = page.getByTestId("follow-brand");
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await row.getByText("Follow workspace brand").click();
  await expect(page.getByRole("switch", { name: "Follow workspace brand" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Crimson", exact: true }).click();
  await expect(page.getByRole("button", { name: "Crimson", exact: true })).toHaveAttribute("aria-pressed", "true");
  await row.getByText("Follow workspace brand").click();
  await expect(page.getByRole("switch", { name: "Follow workspace brand" })).toHaveAttribute("aria-checked", "true");
});

for (const width of [1600, 1280, 1024, 768, 390]) {
  test(`branding layout at ${width}: no overlap, no sideways scroll, bar above the fields`, async ({ page }) => {
    await demo(page);
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    for (const path of ["/app/settings/branding", "/app/settings/appearance"]) {
      await page.goto(path);
      await expect(page.locator('[data-testid="branding-settings"], [data-testid="appearance-settings"]')).toBeVisible({ timeout: 20_000 });
      const r = await page.evaluate(() => {
        const main = document.querySelector("main")!;
        const overlap = [...document.querySelectorAll('[data-testid^="logo-"]')].some((c) => {
          const text = c.querySelector(".min-w-0")!.getBoundingClientRect();
          return text.width < 80 || [...c.querySelectorAll("button")].some((b) => { const x = b.getBoundingClientRect(); return x.top < text.top - 1; });
        });
        const pill = [...document.querySelectorAll('[data-testid="brand-preview"] span')].find((s) => s.textContent === "New message");
        return { hscroll: main.scrollWidth > main.clientWidth + 1, overlap, pillH: pill ? pill.getBoundingClientRect().height : 0 };
      });
      expect(r.hscroll).toBe(false);
      expect(r.overlap).toBe(false);
      expect(r.pillH).toBeLessThanOrEqual(30);
    }
  });
}

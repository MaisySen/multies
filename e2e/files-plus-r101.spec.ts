import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";

/**
 * R101 Files plus (FILES_PLUS_R101=on) in a demo workspace (made up files only). Flows: empty state, upload with the
 * picker and by drag and drop, folders and Move to, image and PDF preview, new version and restore, trash and restore,
 * bulk zip, brand library tags and use. Axe at 1280 and 390, light and dark; Forest shots. SHOTS_DIR writes r101-*.png.
 */
const SHOTS = process.env.SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
// A 2x2 PNG and a one page PDF, made here.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDEwMDAwAAAhEgEC0Z3yWQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<<>>>>endobj
4 0 obj<</Length 35>>stream
0 0 1 rg 20 20 160 160 re f
endstream endobj
trailer<</Root 1 0 R>>
%%EOF`);

async function demo(page: Page) {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
}
async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(250);
}
async function noSeriousAxe(page: Page) {
  await page.mouse.move(0, 0);
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function check(page: Page, name: string, schemes: readonly ("light" | "dark")[] = ["light", "dark"]) {
  for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const scheme of schemes) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await noSeriousAxe(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} ${vp} horizontal scroll`).toBeLessThanOrEqual(1);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `r101-${name}-${vp}-${scheme}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
}
const rows = (page: Page) => page.getByTestId("drive-row");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
async function upload(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByTestId("drive-file-input").setInputFiles(files);
  for (const f of files) await expect(row(page, f.name.replace(/\.[^.]+$/, "")).first()).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: "serial" });
let page: Page;
test.beforeAll(async ({ browser }) => { const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }); page = await ctx.newPage(); await demo(page); });
test.afterAll(async () => { await page.context().close(); });

test("1. team files: empty state, upload by picker and by drag and drop", async () => {
  await page.goto("/app/files?view=team");
  await expect(page.getByTestId("drive-nav-team")).toHaveAttribute("aria-current", "page", { timeout: 20_000 });
  await expect(page.getByText("Share files with your team")).toBeVisible();
  await check(page, "team-empty");
  await upload(page, [{ name: "logo.png", mimeType: "image/png", buffer: PNG }, { name: "Brief.pdf", mimeType: "application/pdf", buffer: PDF }]);
  // Drag and drop from the desktop.
  const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(["Plan for Monday"], "notes.txt", { type: "text/plain" })); return d; });
  await page.getByTestId("drive-card").dispatchEvent("dragenter", { dataTransfer: dt });
  await expect(page.getByTestId("drive-drop")).toBeVisible();
  await page.getByTestId("drive-card").dispatchEvent("drop", { dataTransfer: dt });
  await expect(row(page, "notes.txt")).toBeVisible({ timeout: 20_000 });
  await expect(rows(page)).toHaveCount(3);
  await check(page, "team-list");
});

test("2. folders and Move to, breadcrumbs", async () => {
  await page.getByTestId("drive-new-folder").click();
  await page.getByRole("dialog").getByRole("textbox").fill("Clients");
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await expect(row(page, "Clients")).toBeVisible();
  await row(page, "notes.txt").getByRole("button", { name: "More for notes.txt" }).click();
  await page.getByRole("menuitem", { name: "Move to", exact: true }).click();
  await page.getByTestId("drive-move-folders").getByRole("button", { name: /Clients/ }).click();
  await page.getByTestId("drive-move-here").click();
  await expect(row(page, "notes.txt")).toHaveCount(0);
  await row(page, "Clients").getByRole("button", { name: "Clients", exact: true }).click();
  await expect(page.getByTestId("drive-path")).toContainText("Clients");
  await expect(row(page, "notes.txt")).toBeVisible();
  await page.getByTestId("drive-path").getByRole("button", { name: "Team files" }).click();
  await expect(row(page, "Clients")).toBeVisible();
});

test("3. preview image and PDF; new version and restore", async () => {
  await row(page, "logo.png").getByRole("button", { name: "logo.png", exact: true }).click();
  const panel = page.getByTestId("drive-preview");
  await expect(panel.getByTestId("drive-preview-image")).toBeVisible();
  await check(page, "preview-image");
  await panel.getByTestId("drive-tab-versions").click();
  await panel.getByTestId("drive-version-input").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.concat([PNG, Buffer.from([0])]) });
  await expect(panel.getByTestId("drive-version")).toHaveCount(2, { timeout: 20_000 });
  await panel.getByTestId("drive-version").filter({ hasText: "Version 1" }).getByRole("button", { name: "Restore" }).click();
  await expect(panel.getByTestId("drive-version")).toHaveCount(3);
  await expect(panel.getByText("Restored from version 1")).toBeVisible();
  await check(page, "versions");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await row(page, "Brief.pdf").getByRole("button", { name: "Brief.pdf", exact: true }).click();
  await expect(page.getByTestId("drive-preview-pdf").locator("canvas")).toHaveCount(1, { timeout: 20_000 });
  await page.getByRole("button", { name: "Close preview" }).click();
});

test("4. bulk zip, trash and restore", async () => {
  await row(page, "logo.png").getByRole("checkbox").check();
  await row(page, "Clients").getByRole("checkbox").check();
  await expect(page.getByTestId("drive-bulk")).toContainText("2 selected");
  const dl = page.waitForEvent("download");
  await page.getByTestId("drive-bulk-zip").click();
  const file = await (await dl).path();
  const names = Object.keys(unzipSync(new Uint8Array(readFileSync(file)))).sort();
  expect(names).toEqual(["Clients/notes.txt", "logo.png"]);
  await page.getByTestId("drive-bulk").getByRole("button", { name: "Move to trash" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to trash" }).click();
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId("drive-nav-trash").click();
  await expect(rows(page)).toHaveCount(2);
  await check(page, "trash");
  await row(page, "Clients").getByRole("button", { name: "More for Clients" }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId("drive-nav-team").click();
  await expect(row(page, "Clients")).toBeVisible();
  await expect(row(page, "logo.png")).toHaveCount(0);
});

test("5. brand library: add, tag, filter and use", async () => {
  await page.getByTestId("drive-nav-brand").click();
  await expect(page.getByText("Your brand library")).toBeVisible();
  await upload(page, [{ name: "Fintex mark.png", mimeType: "image/png", buffer: PNG }]);
  await row(page, "Fintex mark").getByRole("button", { name: /Fintex mark/ }).first().click();
  const panel = page.getByTestId("drive-preview");
  await expect(panel.getByTestId("drive-brand-use")).toBeVisible();
  await panel.getByTestId("drive-tab-details").click();
  await panel.getByTestId("drive-tags-input").fill("logo, dark");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("drive-tags")).toContainText("logo");
  await page.getByTestId("drive-tags").getByRole("button", { name: /dark/ }).click();
  await expect(rows(page)).toHaveCount(1);
  await check(page, "brand");
});

test("6. Forest theme shots", async () => {
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await expect(page.getByRole("button", { name: "Forest", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const view of ["team", "brand"]) {
    await page.goto(`/app/files?view=${view}`);
    await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
    for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await noSeriousAxe(page);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `r101-${view}-${vp}-forest.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});

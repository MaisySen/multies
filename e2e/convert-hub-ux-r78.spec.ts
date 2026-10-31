import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * R78 Convert hub against the UX quality gate: every state (empty, drop, chosen, progress, error, done), keyboard
 * only use, clicks from drop to download, no sideways scroll at 1280, 1024, 768 and 390, and axe with 0 serious or
 * critical findings. Same server as convert-hub-r78.spec.ts (TOOLS_P2_E2E=1). CONVERT_SHOTS=<dir> writes
 * ux-<state>-<width>-<scheme>.png; CONVERT_THEME=<name> adds a brand theme pass when the workspace supports one.
 */
const FIX = "e2e/fixtures/convert";
const TOOLS = "e2e/fixtures/tools";
const SHOTS = process.env.CONVERT_SHOTS;
test.skip(process.env.TOOLS_P2_E2E !== "1", "needs a server with Tools on and the stand in engine");
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  const email = `convertux${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Uma Ux", email, password: "a-strong-password" } })).status()).toBe(200);
  expect((await page.request.post("/api/account/onboarding", { data: { name: "Uma Ux", timezone: "Australia/Sydney", locale: "en-AU", company: "Ux Test Co", workspaceTimezone: "Australia/Sydney" } })).status()).toBeLessThan(300);
}
async function open(page: Page) {
  await page.goto("/app/tools/convert");
  await expect(page.getByTestId("convert-drop")).toBeVisible({ timeout: 20_000 });
}
async function shots(page: Page, name: string, focus?: string, widths: number[] = [1280, 390]) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: w > 500 ? 900 : 844 });
      await page.waitForTimeout(250);
      if (w < 500 && focus) await page.getByTestId(focus).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(100);
      await page.screenshot({ path: join(SHOTS, `ux-${name}-${w}-${scheme}.png`), fullPage: w > 500 });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 900 });
}
async function noSideScroll(page: Page) {
  for (const w of [1280, 1024, 768, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    const [x, y] = await page.evaluate(() => { const d = document.documentElement; return [d.scrollWidth - d.clientWidth, d.scrollHeight - d.clientHeight]; });
    expect(x, `sideways scroll at ${w}`).toBeLessThanOrEqual(0);
    expect(y, `the page itself scrolls past the app frame at ${w}`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
async function axe(page: Page, where: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.waitForTimeout(400);
    const { violations } = await new AxeBuilder({ page }).include('[data-testid="convert-hub"]').analyze();
    const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where} ${scheme}: ${v.id} ${v.nodes[0]?.target}`);
    expect(bad).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("states: empty, drop, chosen, progress, error and done, with axe and no sideways scroll", async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page); await page.setViewportSize({ width: 1280, height: 900 }); await open(page);

  // Empty: how it works, the formats, the shortcuts.
  await expect(page.getByTestId("convert-empty")).toBeVisible();
  await noSideScroll(page);
  await axe(page, "empty");
  await shots(page, "empty");

  // Drop: dragging a file over the page lights the zone.
  await page.getByTestId("convert-drop").dispatchEvent("dragover", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await expect(page.getByTestId("convert-drop")).toContainText("Drop to add");
  await shots(page, "drop");
  await page.getByTestId("convert-drop").dispatchEvent("dragleave");
  await expect(page.getByTestId("convert-drop")).not.toContainText("Drop to add");

  // Chosen: five files and a target.
  await page.getByTestId("convert-input").setInputFiles(["photo-a.png", "photo-b.jpg", "photo-c.webp", "photo-d.gif", "logo.svg"].map((f) => join(FIX, f)));
  await page.getByTestId("convert-to-webp").click();
  await expect(page.getByTestId("convert-local-note")).toBeVisible();
  await noSideScroll(page);
  await axe(page, "chosen");
  await shots(page, "chosen", "convert-targets");

  // Done: the batch converts and the tray says so.
  await page.getByTestId("convert-run").click();
  await expect(page.locator('[data-testid="convert-job"][data-status="done"]')).toHaveCount(5, { timeout: 60_000 });
  await expect(page.getByTestId("convert-tray-count")).toHaveText("all 5 ready");
  await expect(page.getByTestId("convert-announce")).toHaveText("5 results ready to download.");
  await noSideScroll(page);
  await axe(page, "done");
  await shots(page, "done", "convert-tray");

  // Progress: an engine job held mid way.
  await page.getByTestId("convert-clear-files").click();
  await expect(page.getByText("Files cleared")).toBeVisible();
  await page.getByTestId("convert-clear-tray").click();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route("**/api/tools/jobs**", async (route) => { if (route.request().method() === "POST") await held; await route.continue(); });
  await page.getByTestId("convert-input").setInputFiles([join(TOOLS, "sample.docx")]);
  await page.getByTestId("convert-to-pdf").click();
  await expect(page.getByTestId("convert-engine-note")).toBeVisible();
  await page.getByTestId("convert-run").click();
  await expect(page.locator('[data-testid="convert-job"][data-status="running"]')).toHaveCount(1);
  await expect(page.getByRole("progressbar")).toBeVisible();
  await axe(page, "progress");
  await shots(page, "progress", "convert-tray");
  release();
  await expect(page.locator('[data-testid="convert-job"][data-status="done"]')).toHaveCount(1, { timeout: 60_000 });
  await page.unroute("**/api/tools/jobs**");

  // Error: a damaged PDF says so in plain words and offers Try again.
  await page.getByTestId("convert-clear-files").click();
  await page.getByTestId("convert-clear-tray").click();
  await page.getByTestId("convert-input").setInputFiles([{ name: "damaged.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 this is not really a pdf") }]);
  await page.getByTestId("convert-action-rotate").click();
  await page.getByTestId("convert-run").click();
  await expect(page.locator('[data-testid="convert-job"][data-status="failed"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("convert-job-error")).toHaveText("This PDF can't be opened. It may be damaged.");
  await expect(page.getByTestId("convert-retry")).toBeVisible();
  await axe(page, "error");
  await shots(page, "error", "convert-tray");
});

test("three clicks from drop to download, and the whole flow by keyboard", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page); await open(page);
  let clicks = 0;
  await page.getByTestId("convert-input").setInputFiles([join(FIX, "photo-a.png")]); // the drop
  await page.getByTestId("convert-to-jpg").click(); clicks++;
  await page.getByTestId("convert-run").click(); clicks++;
  await expect(page.locator('[data-testid="convert-job"][data-status="done"]')).toHaveCount(1, { timeout: 30_000 });
  const [d] = await Promise.all([page.waitForEvent("download"), page.getByTestId("convert-download").click()]); clicks++;
  expect(d.suggestedFilename()).toBe("photo-a.jpg");
  expect(clicks).toBeLessThanOrEqual(3);

  // Keyboard only: Tab to a target, Space to pick it, Ctrl Enter to convert, Tab to Download, Enter.
  await page.getByTestId("convert-clear-files").click();
  await page.getByTestId("convert-clear-tray").click();
  await page.getByTestId("convert-input").setInputFiles([join(FIX, "photo-b.jpg")]);
  await page.getByTestId("convert-to-png").focus();
  await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab"); // real keyboard moves, so the focus ring shows
  await expect(page.getByTestId("convert-to-png")).toBeFocused();
  const ringShown = await page.getByTestId("convert-to-png").evaluate((el) => getComputedStyle(el).boxShadow !== "none" || getComputedStyle(el).outlineStyle !== "none");
  expect(ringShown).toBe(true);
  await page.keyboard.press("Space");
  await expect(page.getByTestId("convert-to-png")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator('[data-testid="convert-job"][data-status="done"]')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId("convert-download").focus();
  const [k] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  expect(k.suggestedFilename()).toBe("photo-b.png");

  // Ctrl O opens the chooser.
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Control+o")]);
  expect(chooser.isMultiple()).toBe(true);

  // Ctrl K finds it.
  await page.goto("/app");
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await dialog.getByRole("combobox").fill("convert files");
  await expect(dialog.getByRole("option", { name: /Convert files/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/tools\/convert$/);
});

test("phone: the convert button stays in reach and tap targets are 44px", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.getByTestId("convert-input").setInputFiles(["photo-a.png", "photo-b.jpg"].map((f) => join(FIX, f)));
  await page.getByTestId("convert-to-pdf").click();
  const bar = page.getByTestId("convert-actions-bar");
  await expect(bar).toHaveCSS("position", "sticky");
  for (const id of ["convert-to-pdf", "convert-run", "convert-clear-files"]) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.height, id).toBeGreaterThanOrEqual(44);
  }
  for (const b of await page.getByRole("button", { name: /^(Move|Remove) / }).all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFString, PDFArray } from "pdf-lib";

/**
 * R100 Tools C end to end, against a local server with TOOLS_FEATURES=all and the stand in engine (TOOLS_P2_E2E=1).
 * Tools hub heading, the 1024 px resize keeps a picked file, Fix a PDF (repair, lock with a password), QR on a PDF,
 * Read comments, four utilities with the Copied toast. SHOTS_DIR writes shots at 1280 and 390, light and dark, plus Forest.
 */
const TOOLS = "e2e/fixtures/tools";
const SHOTS = process.env.SHOTS_DIR;
test.skip(process.env.TOOLS_P2_E2E !== "1", "needs a server with Tools on and the stand in engine");
test.describe.configure({ mode: "serial" });
test.beforeEach(() => { test.setTimeout(SHOTS ? 420_000 : 150_000); });

async function signIn(page: Page) {
  const email = `r100${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Tess Tools", email, password: "a-strong-password" } })).status()).toBe(200);
  expect((await page.request.post("/api/account/onboarding", { data: { name: "Tess Tools", timezone: "Australia/Sydney", locale: "en-AU", company: "Tools C Co", workspaceTimezone: "Australia/Sydney" } })).status()).toBeLessThan(300);
}
async function shots(page: Page, name: string, widths: ("1280" | "390")[] = ["1280", "390"]) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // Crossing the 1024 px desktop shell breakpoint remounts the page (and drops picked files), so every 1280 shot is
  // taken first and the 390 ones last; callers take shots at the end of a flow or at 1280 only mid flow.
  for (const [vp, w, h] of ([["1280", 1280, 900], ["390", 390, 844]] as const).filter(([v]) => widths.includes(v))) {
    await page.setViewportSize({ width: w, height: h });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, `r100-${name}-${vp}-${scheme}.png`), fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
}
async function noSeriousAxe(page: Page) {
  // A toast sliding in is half transparent for a moment; check colours once motion has settled.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [d] = await Promise.all([page.waitForEvent("download"), click()]);
  return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
}

const sample = () => join(TOOLS, "sample-a.pdf");

async function withComments(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText("Quarterly numbers", { x: 60, y: 760, size: 18 });
  const ctx = doc.context;
  const note = ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [60, 700, 80, 720], Contents: PDFString.of("Please check the totals"), T: PDFString.of("Ana Reviewer"), M: PDFString.of("D:20261030120000Z") });
  const hl = ctx.obj({ Type: "Annot", Subtype: "Highlight", Rect: [58, 755, 240, 782], QuadPoints: [58, 782, 240, 782, 58, 755, 240, 755], Contents: PDFString.of("Is this the right quarter"), T: PDFString.of("Ben Mate") });
  page.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(note), ctx.register(hl)]) as PDFArray);
  return Buffer.from(await doc.save());
}

test("1. Tools hub has its heading and the new cards, axe clean", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/app/tools");
  await expect(page.getByRole("heading", { level: 1, name: "Tools" })).toBeVisible({ timeout: 20_000 });
  for (const name of ["Fix a PDF", "QR and barcodes on a PDF", "Read comments"]) await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("main").getByText("Utilities").first()).toBeVisible();
  await noSeriousAxe(page);
  await shots(page, "hub");
});

test("2. Crossing 1024 px keeps the picked file in Edit a PDF", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/app/tools/edit-pdf");
  await page.getByTestId("edit-pdf-input").setInputFiles(sample());
  const pages = page.getByTestId("edit-pdf-page");
  await expect(pages.first()).toBeVisible({ timeout: 20_000 });
  const n = await pages.count();
  // Mark the page node: a remount would drop it.
  await pages.first().evaluate((el) => el.setAttribute("data-r100-mark", "kept"));
  for (const w of [900, 1280, 390, 1280]) {
    await page.setViewportSize({ width: w, height: w > 500 ? 900 : 844 });
    await page.waitForTimeout(400);
    await expect(pages).toHaveCount(n);
    await expect(page.locator('[data-r100-mark="kept"]')).toHaveCount(1);
  }
});

test("3. Fix a PDF: repair, then lock with a password; a mismatch blocks the button", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/app/tools/pdf-fix");
  await expect(page.getByRole("heading", { level: 1, name: "Fix a PDF" })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("pdf-fix-input").setInputFiles(sample());
  await shots(page, "pdf-fix-picked", ["1280"]);
  await page.getByTestId("pdf-fix-run").click();
  const fixed = await download(page, () => page.getByTestId("pdf-fix-download").click());
  expect(fixed.name).toMatch(/\(repaired\)\.pdf$/);
  const srcCount = (await PDFDocument.load(readFileSync(sample()))).getPageCount();
  expect((await PDFDocument.load(fixed.bytes)).getPageCount()).toBe(srcCount);
  await noSeriousAxe(page);

  await page.goto("/app/tools/pdf-fix");
  await page.getByTestId("pdf-fix-input").setInputFiles(sample());
  await page.locator('input[name="fix-op"][value="encrypt"]').check();
  await page.getByTestId("pdf-fix-pw").fill("river stone 42");
  await page.getByTestId("pdf-fix-pw2").fill("river stone 4");
  await expect(page.getByTestId("pdf-fix-run")).toBeDisabled();
  await page.getByTestId("pdf-fix-pw2").fill("river stone 42");
  await noSeriousAxe(page);
  await shots(page, "pdf-fix-encrypt", ["1280"]);
  await page.getByTestId("pdf-fix-run").click();
  const locked = await download(page, () => page.getByTestId("pdf-fix-download").click());
  expect(locked.name).toMatch(/\(locked\)\.pdf$/);
  expect(locked.bytes.toString("latin1")).toMatch(/\/Encrypt/);
  await expect(PDFDocument.load(locked.bytes)).rejects.toThrow(/encrypt/i);
  await shots(page, "pdf-fix-done");
});

test("4. QR code on a PDF: preview, then a page with the code on it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/app/tools/pdf-codes");
  await page.getByTestId("pdf-codes-input").setInputFiles(sample());
  await page.getByTestId("pdf-codes-text").fill("https://multies.si/invoice/42");
  await expect(page.getByTestId("pdf-codes-preview")).toBeVisible({ timeout: 20_000 });
  await noSeriousAxe(page);
  await shots(page, "pdf-codes", ["1280"]);
  await page.getByTestId("pdf-codes-run").click();
  const out = await download(page, () => page.getByTestId("pdf-codes-download").click());
  const doc = await PDFDocument.load(out.bytes);
  // The code is drawn as vector squares in an extra content stream on the first page only.
  const refs = (i: number) => (String(doc.getPage(i).node.get(PDFName.of("Contents"))).match(/\d+ 0 R/g) ?? []).length;
  const before = await PDFDocument.load(readFileSync(sample()));
  const was = (i: number) => (String(before.getPage(i).node.get(PDFName.of("Contents"))).match(/\d+ 0 R/g) ?? []).length;
  expect(doc.getPageCount()).toBe(before.getPageCount());
  expect(refs(0)).toBeGreaterThan(was(0));
  if (doc.getPageCount() > 1) expect(refs(1)).toBe(was(1));
});

test("5. Read comments lists notes and highlights with author; a clean file says so", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/app/tools/pdf-comments");
  await page.getByTestId("pdf-comments-input").setInputFiles({ name: "review.pdf", mimeType: "application/pdf", buffer: await withComments() });
  const list = page.getByTestId("pdf-comments-list");
  await expect(list).toContainText("Please check the totals", { timeout: 20_000 });
  await expect(list).toContainText("Ana Reviewer");
  await expect(list).toContainText("Is this the right quarter");
  await noSeriousAxe(page);
  await shots(page, "pdf-comments");
  await page.goto("/app/tools/pdf-comments");
  await page.getByTestId("pdf-comments-input").setInputFiles(sample());
  await expect(page.getByTestId("pdf-comments-empty")).toBeVisible({ timeout: 20_000 });
});

test("6. Utilities: data, Base64, hash and regex, each with Copy and the Copied toast", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  await page.goto("/app/tools/utilities");
  try { await expect(page.getByTestId("utilities-grid")).toBeVisible({ timeout: 30_000 }); }
  catch (e) { await page.screenshot({ path: "/tmp/r100-u6.png" }); writeFileSync("/tmp/r100-u6.txt", `${page.url()}\n${(await page.locator("body").innerText()).slice(0, 600)}`); throw e; }
  await noSeriousAxe(page);
  await shots(page, "utilities");
  const copied = async () => {
    await page.getByRole("button", { name: /^Copy/ }).first().click();
    await expect(page.getByText("Copied").first()).toBeVisible();
  };

  await page.goto("/app/tools/utilities/data");
  await page.getByTestId("data-input").fill('{"b":1,"a":[1,2]}');
  await expect(page.getByTestId("util-output")).toHaveValue(/"b": 1/);
  await copied();
  await page.getByTestId("data-input").fill('{"b":1,');
  await expect(page.getByRole("main")).toContainText(/not valid|could not|check/i);
  await noSeriousAxe(page);
  await shots(page, "util-data");

  await page.goto("/app/tools/utilities/base64");
  await page.getByTestId("b64-input").fill("hello");
  await expect(page.getByTestId("util-output")).toHaveValue("aGVsbG8=");
  await copied();

  await page.goto("/app/tools/utilities/hash");
  await page.getByTestId("hash-input").fill("abc");
  await expect(page.getByTestId("hash-list")).toContainText("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  await copied();

  await page.goto("/app/tools/utilities/regex");
  await page.getByTestId("regex-pattern").fill("\\d+");
  await page.getByTestId("regex-text").fill("a1 b22 c333");
  await expect(page.getByTestId("regex-matches").locator("li")).toHaveCount(3);
  await copied();
  await noSeriousAxe(page);
  await shots(page, "util-regex");
});

test("7. Forest theme on Utilities and Fix a PDF, at 1280 and 390", async ({ page }) => {
  test.skip(!SHOTS, "screenshots only with SHOTS_DIR");
  await signIn(page);
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  mkdirSync(SHOTS!, { recursive: true });
  for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const [name, path] of [["utilities", "/app/tools/utilities"], ["pdf-fix", "/app/tools/pdf-fix"], ["hub", "/app/tools"]] as const) {
      await page.goto(path);
      await page.waitForTimeout(600);
      await noSeriousAxe(page);
      await page.screenshot({ path: join(SHOTS!, `r100-${name}-${vp}-forest.png`), fullPage: true });
    }
  }
});

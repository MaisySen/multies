import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, degrees } from "pdf-lib";
import { unzipSync, gunzipSync, strFromU8 } from "fflate";

/**
 * R86 Tools round B end to end: video and sound, HEIC outside Safari, e-books, archives unpacked and packed, compress
 * with sizes before and after, OCR to a searchable PDF and to text, the PNG to PNG picture, and Edit a PDF (text,
 * black out, signature, watermark, page numbers, turn and delete pages). Same server as the R78 hub specs
 * (TOOLS_P2_E2E=1, TOOLS_FEATURES with convert_plus and editor, the stand in engine). R86_SHOTS=<dir> writes
 * r86-<state>-<1280|390>-<light|dark|forest>.png.
 */
const FIX = "e2e/fixtures/convert";
const TOOLS = "e2e/fixtures/tools";
const SHOTS = process.env.R86_SHOTS;
test.skip(process.env.TOOLS_P2_E2E !== "1", "needs a server with Tools on and the stand in engine");
test.describe.configure({ mode: "serial" });
// Screenshots at two widths and two schemes are slow on a shared box; give each test room when they are on.
test.beforeEach(() => { test.setTimeout(SHOTS ? 420_000 : 150_000); });

async function signIn(page: Page) {
  const email = `r86${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Rhea Round", email, password: "a-strong-password" } })).status()).toBe(200);
  expect((await page.request.post("/api/account/onboarding", { data: { name: "Rhea Round", timezone: "Australia/Sydney", locale: "en-AU", company: "Round B Co", workspaceTimezone: "Australia/Sydney" } })).status()).toBeLessThan(300);
}
async function open(page: Page) {
  await page.goto("/app/tools/convert");
  await expect(page.getByTestId("convert-drop")).toBeVisible({ timeout: 20_000 });
}
const MIME: Record<string, string> = { csv: "text/csv", png: "image/png", jpg: "image/jpeg", pdf: "application/pdf" };
async function add(page: Page, files: (string | { name: string; mimeType: string; buffer: Buffer })[]) {
  // Playwright takes paths or buffers, not both at once: a mixed list goes as buffers.
  const mixed = files.some((f) => typeof f !== "string") && files.some((f) => typeof f === "string");
  const list = mixed ? files.map((f) => (typeof f === "string" ? { name: f.split("/").pop()!, mimeType: MIME[f.split(".").pop()!] ?? "", buffer: readFileSync(f) } : f)) : files;
  await page.getByTestId("convert-input").setInputFiles(list as never);
  await expect(page.getByTestId("convert-file")).toHaveCount(files.length);
}
async function run(page: Page, jobs: number, timeout = 60_000) {
  await page.getByTestId("convert-run").click();
  await expect(page.locator('[data-testid="convert-job"][data-status="done"]')).toHaveCount(jobs, { timeout });
  await expect(page.locator('[data-testid="convert-job"][data-status="failed"]')).toHaveCount(0);
}
async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [d] = await Promise.all([page.waitForEvent("download"), click()]);
  return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
}
const firstDownload = (page: Page) => download(page, () => page.getByTestId("convert-download").first().click());
const head = (b: Buffer, n = 12) => b.subarray(0, n).toString("latin1");

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
      await page.screenshot({ path: join(SHOTS, `r86-${name}-${vp}-${scheme}.png`), fullPage: true });
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

test("1. a video becomes MP3 on the engine, with its limits said and progress shown", async ({ page }) => {
  await signIn(page); await open(page);
  await add(page, [join(FIX, "clip.mp4")]);
  for (const t of ["mov", "webm", "gif", "mp3", "m4a", "wav"]) await expect(page.getByTestId(`convert-to-${t}`)).toBeVisible();
  await expect(page.getByTestId("convert-to-pdf")).toHaveCount(0);
  await page.getByTestId("convert-to-mp3").click();
  await expect(page.getByTestId("convert-engine-note")).toContainText("Multies engine");
  await expect(page.getByTestId("convert-engine-limit").first()).toContainText("3 minutes");
  await shots(page, "video-chosen", ["1280"]);
  await page.getByTestId("convert-run").click();
  await expect(page.locator('[data-testid="convert-job"] [role="progressbar"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="convert-job"][data-status="done"]')).toHaveCount(1, { timeout: 60_000 });
  const f = await firstDownload(page);
  expect(f.name).toBe("clip.mp3");
  await shots(page, "video-done", ["1280"]);
});

test("2. HEIC outside Safari goes to the engine and says so; 3. EPUB to PDF", async ({ page }) => {
  await signIn(page); await open(page);
  await add(page, [join(FIX, "photo.heic")]);
  await expect(page.getByTestId("convert-file-hint")).toContainText("Multies engine", { timeout: 20_000 });
  await page.getByTestId("convert-to-jpg").click();
  await run(page, 1);
  let f = await firstDownload(page);
  expect(f.name).toBe("photo.jpg");
  expect(f.bytes[0]).toBe(0xff); expect(f.bytes[1]).toBe(0xd8);
  await page.getByTestId("convert-clear-files").click();
  await page.getByTestId("convert-clear-tray").click();
  await add(page, [join(FIX, "story.epub")]);
  await page.getByTestId("convert-to-pdf").click();
  await run(page, 1);
  f = await firstDownload(page);
  expect(f.name).toBe("story.pdf");
  expect(head(f.bytes, 5)).toBe("%PDF-");
});

test("4. ZIP and 7Z unpack on the device, each file listed, folders kept in the ZIP", async ({ page }) => {
  await signIn(page); await open(page);
  await add(page, [join(FIX, "bundle.zip"), join(FIX, "bundle.7z")]);
  await page.getByTestId("convert-action-extract").click();
  await expect(page.getByTestId("convert-engine-note")).toHaveCount(0);
  await run(page, 2);
  const files = page.getByTestId("convert-job-files").first();
  await files.locator("summary").click();
  await expect(files.locator("li")).toHaveCount(2);
  const z = await firstDownload(page);
  expect(z.name).toMatch(/\.zip$/);
  const entries = Object.keys(unzipSync(new Uint8Array(z.bytes))).sort();
  expect(entries).toEqual(["b.bin", "dir/a.txt"]);
  expect(strFromU8(unzipSync(new Uint8Array(z.bytes))["dir/a.txt"])).toBe("hello\n");
  // One file on its own.
  const one = await download(page, () => files.getByRole("button", { name: "Download a.txt" }).click());
  expect(one.bytes.toString()).toBe("hello\n");
  await shots(page, "unpacked", ["1280"]);
});

test("5. any files pack into one TAR.GZ, even a kind Multies can't convert", async ({ page }) => {
  await signIn(page); await open(page);
  await add(page, [join(FIX, "people.csv"), join(FIX, "photo-a.png"), { name: "notes.xyz", mimeType: "application/octet-stream", buffer: Buffer.from("plain notes") }]);
  await page.getByTestId("convert-action-archive").click();
  await page.getByTestId("convert-pack-as").getByRole("button", { name: "TAR.GZ" }).click();
  await run(page, 1);
  await expect(page.getByTestId("convert-job-sizes")).toContainText("KB");
  const f = await firstDownload(page);
  expect(f.name).toMatch(/^files-\d{4}-\d{2}-\d{2}\.tar\.gz$/);
  const tar = gunzipSync(new Uint8Array(f.bytes));
  const names: string[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const name = strFromU8(tar.subarray(at, at + 100)).replace(/\0.*$/s, "");
    if (!name) break;
    names.push(name);
    const size = parseInt(strFromU8(tar.subarray(at + 124, at + 136)).replace(/\0.*$/s, "").trim(), 8);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  expect(names).toEqual(["people.csv", "photo-a.png", "notes.xyz"]);
});

test("6. compress: a PDF and a video on the engine, a photo on the device, sizes before and after", async ({ page }) => {
  await signIn(page); await open(page);
  await add(page, [join(TOOLS, "sample-a.pdf"), join(FIX, "clip.mp4")]);
  await page.getByTestId("convert-action-compress").click();
  await page.getByTestId("convert-level").getByRole("button", { name: "Smallest" }).click();
  await expect(page.getByTestId("convert-engine-note")).toContainText("Multies engine");
  await run(page, 2);
  await expect(page.getByTestId("convert-job-sizes")).toHaveCount(2);
  await expect(page.getByTestId("convert-job-sizes").first()).toContainText("% smaller");
  await shots(page, "compressed", ["1280"]);
  await page.getByTestId("convert-clear-files").click();
  await add(page, [join(FIX, "photo-b.jpg")]);
  await page.getByTestId("convert-action-compress").click();
  await expect(page.getByTestId("convert-engine-note")).toHaveCount(0);
  await page.getByTestId("convert-run").click();
  await expect(page.locator('[data-testid="convert-job"][data-status="done"]')).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByTestId("convert-job-sizes").first()).toContainText(/smaller|already small/);
});

test("7. OCR: a scan to a searchable PDF and a photo to text", async ({ page }) => {
  await signIn(page); await open(page);
  await add(page, [join(TOOLS, "scan.pdf")]);
  await page.getByTestId("convert-action-ocr-pdf").click();
  await expect(page.getByTestId("convert-ocr-language")).toBeVisible();
  await run(page, 1);
  let f = await firstDownload(page);
  expect(f.name).toBe("scan-searchable.pdf");
  expect(head(f.bytes, 5)).toBe("%PDF-");
  await page.getByTestId("convert-clear-files").click();
  await page.getByTestId("convert-clear-tray").click();
  await add(page, [join(FIX, "photo-b.jpg")]);
  await page.getByTestId("convert-action-ocr-text").click();
  await run(page, 1);
  f = await firstDownload(page);
  expect(f.name).toBe("photo-b.txt");
  expect(f.bytes.toString().trim().length).toBeGreaterThan(5);
});

test("8. PNG to PNG shows its own picture even when the browser gives no type", async ({ page }) => {
  await signIn(page); await open(page);
  // PNG is a target when the batch holds another kind too; the PNG itself is kept and must show its picture.
  await add(page, [{ name: "plain.png", mimeType: "", buffer: readFileSync(join(FIX, "photo-a.png")) }, { name: "b.jpg", mimeType: "image/jpeg", buffer: readFileSync(join(FIX, "photo-b.jpg")) }]);
  await page.getByTestId("convert-to-png").click();
  await run(page, 2);
  await expect(page.locator('[data-testid="convert-job"] img')).toHaveCount(2);
});

test("9. Edit a PDF: text, black out, signature, watermark, numbers, turn and delete pages", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/tools");
  await page.getByRole("button", { name: /^Edit a PDF / }).first().click();
  await expect(page).toHaveURL(/\/app\/tools\/edit-pdf/);
  const src = readFileSync(join(TOOLS, "sample-a.pdf"));
  const n = (await PDFDocument.load(src)).getPageCount();
  await page.getByTestId("edit-pdf-input").setInputFiles(join(TOOLS, "sample-a.pdf"));
  await expect(page.getByTestId("edit-pdf-page")).toHaveCount(n, { timeout: 20_000 });
  const first = page.getByTestId("edit-pdf-page").first().getByRole("group");
  await expect(page.getByTestId("edit-pdf-page").first().getByText("Loading page")).toHaveCount(0, { timeout: 20_000 });
  const box = (await first.boundingBox())!;
  // Text.
  await page.getByTestId("edit-pdf-tool-text").click();
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await page.getByTestId("edit-pdf-text").first().fill("Approved by Rhea");
  // Black out a box.
  await page.getByTestId("edit-pdf-tool-box").click();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("edit-pdf-item-box")).toHaveCount(1);
  // Signature: draw, use, place.
  await page.getByTestId("edit-pdf-tool-sign").click();
  const pad = page.getByTestId("edit-pdf-sign-pad").locator("canvas").first();
  const pb = (await pad.boundingBox())!;
  await page.mouse.move(pb.x + 20, pb.y + pb.height / 2); await page.mouse.down();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + 10, { steps: 6 }); await page.mouse.move(pb.x + pb.width - 20, pb.y + pb.height - 10, { steps: 6 }); await page.mouse.up();
  await page.getByTestId("edit-pdf-use-signature").click();
  // The page is taller than the window: let Playwright scroll the spot into view before the tap.
  await first.click({ position: { x: box.width * 0.6, y: box.height * 0.62 } });
  await expect(page.getByTestId("edit-pdf-item-sign")).toHaveCount(1);
  // Watermark and numbers.
  await page.getByText("Watermark and page numbers").click();
  await page.getByTestId("edit-pdf-watermark").fill("DRAFT");
  await page.getByTestId("edit-pdf-numbers").check();
  // Turn page 1, delete the last page.
  await page.getByTestId("edit-pdf-turn").first().click();
  if (n > 1) await page.getByTestId("edit-pdf-delete-page").last().click();
  await page.getByTestId("edit-pdf-tool-move").click();
  await noSeriousAxe(page);
  const f = await download(page, () => page.getByTestId("edit-pdf-save").click());
  expect(f.name).toBe("sample-a-edited.pdf");
  const out = await PDFDocument.load(f.bytes);
  expect(out.getPageCount()).toBe(Math.max(1, n - 1));
  expect(out.getPage(0).getRotation()).toEqual(degrees(90));
  const raw = f.bytes.toString("latin1");
  // The blacked out page is a picture now (its words are gone), the rest keeps text; text and numbers use Helvetica.
  expect(raw).toMatch(/\/Subtype\s*\/Image/);
  // Fonts can sit inside compressed object streams, so look at the parsed objects rather than the raw bytes.
  const objs = out.context.enumerateIndirectObjects().map(([, o]) => String(o)).join("\n");
  expect(objs).toMatch(/\/BaseFont \/Helvetica/);
  await shots(page, "edit-pdf", ["1280"]);
});

test("10. Forest theme on the hub and Edit a PDF, at 1280 and 390", async ({ page }) => {
  test.skip(!SHOTS, "screenshots only with R86_SHOTS");
  await signIn(page);
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  // Each width starts fresh: crossing the desktop breakpoint remounts the page.
  for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await open(page);
    await add(page, [join(FIX, "clip.mp4"), join(FIX, "bundle.zip")]);
    await page.getByTestId("convert-action-archive").click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS!, `r86-hub-${vp}-forest.png`), fullPage: true });
    await page.goto("/app/tools/edit-pdf");
    await page.getByTestId("edit-pdf-input").setInputFiles(join(TOOLS, "sample-a.pdf"));
    await expect(page.getByTestId("edit-pdf-page").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("edit-pdf-page").first().getByText("Loading page")).toHaveCount(0, { timeout: 20_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS!, `r86-edit-${vp}-forest.png`) });
    await noSeriousAxe(page);
  }
});

test("11. phone width: compress with sizes, unpack, and Edit a PDF with a text box", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page); await open(page);
  await add(page, [join(TOOLS, "sample-a.pdf"), join(FIX, "photo-b.jpg")]);
  await page.getByTestId("convert-action-compress").click();
  await run(page, 2);
  await expect(page.getByTestId("convert-job-sizes")).toHaveCount(2);
  const noSideScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await noSideScroll();
  await noSeriousAxe(page);
  await shots(page, "phone-compressed", ["390"]);
  await page.getByTestId("convert-clear-files").click();
  await page.getByTestId("convert-clear-tray").click();
  await add(page, [join(FIX, "bundle.zip")]);
  await page.getByTestId("convert-action-extract").click();
  await run(page, 1);
  await page.getByTestId("convert-job-files").first().locator("summary").click();
  await noSideScroll();
  await shots(page, "phone-unpacked", ["390"]);
  await page.goto("/app/tools/edit-pdf");
  await page.getByTestId("edit-pdf-input").setInputFiles(join(TOOLS, "sample-a.pdf"));
  await expect(page.getByTestId("edit-pdf-page").first().getByText("Loading page")).toHaveCount(0, { timeout: 20_000 });
  const first = page.getByTestId("edit-pdf-page").first().getByRole("group");
  const box = (await first.boundingBox())!;
  await page.getByTestId("edit-pdf-tool-text").click();
  await first.click({ position: { x: box.width * 0.15, y: box.height * 0.1 } });
  await page.getByTestId("edit-pdf-text").first().fill("Approved");
  await noSideScroll();
  await noSeriousAxe(page);
  await shots(page, "phone-edit", ["390"]);
});

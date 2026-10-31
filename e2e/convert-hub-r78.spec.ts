import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";

/**
 * R78 Convert hub: real conversions end to end in a browser. Images, PDF basics and spreadsheets run on the page
 * (nothing uploaded); Word to PDF goes to the stand in engine. Local only, like the other Tools specs: a server with
 * Tools on and e2e/support/tools-p2-engine.mjs (TOOLS_P2_E2E=1, E2E_BASE_URL=http://localhost:PORT).
 * CONVERT_SHOTS=<dir> writes convert-<state>-<1280|390>-<light|dark>.png.
 */
const FIX = "e2e/fixtures/convert";
const TOOLS = "e2e/fixtures/tools";
const SHOTS = process.env.CONVERT_SHOTS;
test.skip(process.env.TOOLS_P2_E2E !== "1", "needs a server with Tools on and the stand in engine");
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  const email = `convert${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  const r = await page.request.post("/api/auth/sign-up/email", { data: { name: "Cora Convert", email, password: "a-strong-password" } });
  expect(r.status()).toBe(200);
  const done = await page.request.post("/api/account/onboarding", { data: { name: "Cora Convert", timezone: "Australia/Sydney", locale: "en-AU", company: "Convert Test Co", workspaceTimezone: "Australia/Sydney" } });
  expect(done.status()).toBeLessThan(300);
}

async function open(page: Page) {
  await page.goto("/app/tools/convert");
  await expect(page.getByTestId("convert-hub")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("convert-drop")).toBeVisible();
}

async function add(page: Page, files: string[]) {
  await page.getByTestId("convert-input").setInputFiles(files);
  await expect(page.getByTestId("convert-file")).toHaveCount(files.length);
}

async function clearAll(page: Page) {
  if (await page.getByTestId("convert-clear-files").isVisible()) await page.getByTestId("convert-clear-files").click();
  if (await page.getByTestId("convert-clear-tray").isVisible()) await page.getByTestId("convert-clear-tray").click();
}

/** Runs the chosen conversion and waits until every job in the tray is done. */
async function run(page: Page, jobs: number) {
  await page.getByTestId("convert-run").click();
  await expect(page.locator('[data-testid="convert-job"][data-status="done"]')).toHaveCount(jobs, { timeout: 60_000 });
  await expect(page.locator('[data-testid="convert-job"][data-status="failed"]')).toHaveCount(0);
}

async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [d] = await Promise.all([page.waitForEvent("download"), click()]);
  return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
}
const firstDownload = (page: Page) => download(page, () => page.getByTestId("convert-download").first().click());
const head = (b: Buffer, n = 12) => b.subarray(0, n).toString("latin1");

async function shots(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, `convert-${name}-${vp}-${scheme}.png`), fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("file first: the hub reads files and shows what they can become", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  // Listed first in the Convert section of Tools.
  await page.goto("/app/tools");
  await expect(page.getByTestId("toolpage-convert-any").first()).toBeVisible({ timeout: 20_000 });
  await open(page);
  await expect(page.getByTestId("convert-formats")).toBeVisible();
  await shots(page, "empty");
  await add(page, [join(FIX, "photo-a.png")]);
  for (const to of ["jpg", "webp", "avif", "gif", "bmp", "pdf"]) await expect(page.getByTestId(`convert-to-${to}`)).toBeVisible();
  await page.getByTestId("convert-to-jpg").click();
  await expect(page.getByTestId("convert-local-note")).toContainText("Stays on your device");
  await shots(page, "chosen");
});

test("1. PNG to JPG on the device", async ({ page }) => {
  await signIn(page); await open(page);
  const uploads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/tools/jobs") && r.method() === "POST") uploads.push(r.url()); });
  await add(page, [join(FIX, "photo-a.png")]);
  await page.getByTestId("convert-to-jpg").click();
  await run(page, 1);
  const f = await firstDownload(page);
  expect(f.name).toBe("photo-a.jpg");
  expect(f.bytes[0]).toBe(0xff); expect(f.bytes[1]).toBe(0xd8);
  expect(uploads).toHaveLength(0); // nothing left the device
});

test("2. a batch of 5 images to WEBP, then download all as one ZIP", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page); await open(page);
  await add(page, ["photo-a.png", "photo-b.jpg", "photo-d.gif", "photo-e.bmp", "logo.svg"].map((f) => join(FIX, f)));
  await page.getByTestId("convert-to-webp").click();
  await run(page, 5);
  await shots(page, "batch-done");
  const zip = await download(page, () => page.getByTestId("convert-download-all").click());
  expect(zip.name).toMatch(/\.zip$/);
  const entries = unzipSync(new Uint8Array(zip.bytes));
  const names = Object.keys(entries).sort();
  expect(names).toEqual(["logo.webp", "photo-a.webp", "photo-b.webp", "photo-d.webp", "photo-e.webp"]);
  for (const n of names) { const b = Buffer.from(entries[n]); expect(head(b, 4)).toBe("RIFF"); expect(b.subarray(8, 12).toString("latin1")).toBe("WEBP"); }
});

test("3. JPG to AVIF with the on device encoder", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page); await open(page);
  await add(page, [join(FIX, "photo-b.jpg")]);
  await page.getByTestId("convert-to-avif").click();
  await run(page, 1);
  const f = await firstDownload(page);
  expect(f.name).toBe("photo-b.avif");
  expect(f.bytes.subarray(4, 12).toString("latin1")).toBe("ftypavif");
});

test("4. WEBP to GIF and 5. BMP to PNG", async ({ page }) => {
  await signIn(page); await open(page);
  await add(page, [join(FIX, "photo-c.webp")]);
  await page.getByTestId("convert-to-gif").click();
  await run(page, 1);
  expect(head((await firstDownload(page)).bytes, 6)).toBe("GIF89a");
  await clearAll(page);
  await add(page, [join(FIX, "photo-e.bmp")]);
  await page.getByTestId("convert-to-png").click();
  await run(page, 1);
  expect(head((await firstDownload(page)).bytes, 8)).toBe("\x89PNG\r\n\x1a\n");
});

test("6. images into one PDF, in the order shown", async ({ page }) => {
  await signIn(page); await open(page);
  await add(page, [join(FIX, "photo-a.png"), join(FIX, "photo-b.jpg"), join(FIX, "photo-c.webp")]);
  await page.getByTestId("convert-action-images-pdf").click();
  await expect(page.getByTestId("convert-local-note")).toBeVisible();
  await run(page, 1);
  const f = await firstDownload(page);
  expect(head(f.bytes, 5)).toBe("%PDF-");
  expect((await PDFDocument.load(f.bytes)).getPageCount()).toBe(3);
});

test("7. merge PDFs, 8. split pages, 9. rotate, 10. page numbers", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page); await open(page);
  await add(page, [join(TOOLS, "sample-a.pdf"), join(TOOLS, "sample-b.pdf")]);
  await page.getByTestId("convert-action-merge").click();
  await run(page, 1);
  const merged = await firstDownload(page);
  expect((await PDFDocument.load(merged.bytes)).getPageCount()).toBe(5);

  await clearAll(page);
  await add(page, [join(TOOLS, "sample-a.pdf")]);
  await page.getByTestId("convert-action-split").click();
  await page.getByTestId("convert-ranges").fill("1-2, 3");
  await run(page, 1);
  const parts = await firstDownload(page);
  expect(parts.name).toMatch(/\.zip$/);
  const files = unzipSync(new Uint8Array(parts.bytes));
  expect(Object.keys(files).sort()).toEqual(["sample-a-p1-2.pdf", "sample-a-p3.pdf"]);
  expect((await PDFDocument.load(files["sample-a-p1-2.pdf"])).getPageCount()).toBe(2);

  await clearAll(page);
  await add(page, [join(TOOLS, "sample-b.pdf")]);
  await page.getByTestId("convert-action-rotate").click();
  await run(page, 1);
  const rotated = await PDFDocument.load((await firstDownload(page)).bytes);
  expect(rotated.getPages().every((p) => p.getRotation().angle === 90)).toBe(true);

  await clearAll(page);
  await add(page, [join(TOOLS, "sample-b.pdf")]);
  await page.getByTestId("convert-action-numbers").click();
  await page.getByTestId("convert-num-style").getByRole("button", { name: "Page 1 of 9" }).click();
  await run(page, 1);
  const numbered = await firstDownload(page);
  expect(numbered.name).toBe("sample-b-numbered.pdf");
  expect(numbered.bytes.length).toBeGreaterThan(readFileSync(join(TOOLS, "sample-b.pdf")).length);
});

test("11. PDF pages to PNG on the device", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page); await open(page);
  await add(page, [join(TOOLS, "sample-a.pdf")]);
  await page.getByTestId("convert-to-png").click();
  await run(page, 1);
  const f = await firstDownload(page);
  const pages = unzipSync(new Uint8Array(f.bytes));
  expect(Object.keys(pages)).toHaveLength(3);
  for (const b of Object.values(pages)) expect(head(Buffer.from(b), 4)).toBe("\x89PNG");
});

test("12. CSV to Excel, 13. Excel to CSV (one per sheet), 14. JSON to CSV", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page); await open(page);
  await add(page, [join(FIX, "people.csv")]);
  await page.getByTestId("convert-to-xlsx").click();
  await run(page, 1);
  const x = await firstDownload(page);
  expect(x.name).toBe("people.xlsx");
  const book = unzipSync(new Uint8Array(x.bytes));
  const strings = strFromU8(book["xl/sharedStrings.xml"] ?? new Uint8Array()) + strFromU8(book["xl/worksheets/sheet1.xml"]);
  expect(strings).toContain("Kathmandu");
  expect(strings).toContain("Chen, Li");

  await clearAll(page);
  await add(page, [join(FIX, "book.xlsx")]);
  await page.getByTestId("convert-to-csv").click();
  await run(page, 1);
  const csvs = unzipSync(new Uint8Array((await firstDownload(page)).bytes));
  expect(Object.keys(csvs).sort()).toEqual(["book-People.csv", "book-Totals.csv"]);
  expect(strFromU8(csvs["book-People.csv"])).toContain("Bikash,Kathmandu,88");

  await clearAll(page);
  await add(page, [join(FIX, "rows.json")]);
  await page.getByTestId("convert-to-csv").click();
  await run(page, 1);
  const csv = (await firstDownload(page)).bytes.toString("utf8").replace(/^\ufeff/, "");
  expect(csv.split(/\r?\n/)[0]).toBe("name,city,amount");
  expect(csv).toContain("Asha,Sydney,120.5");
});

test("15. Word to PDF falls back to the engine, and says so", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page); await open(page);
  await add(page, [join(TOOLS, "sample.docx")]);
  await page.getByTestId("convert-to-pdf").click();
  await expect(page.getByTestId("convert-engine-note")).toContainText("Multies engine");
  await run(page, 1);
  const f = await firstDownload(page);
  expect(f.name).toBe("sample.pdf");
  expect(head(f.bytes, 5)).toBe("%PDF-");
});

test("mixed files: only the common targets show, and unknown files are named", async ({ page }) => {
  await signIn(page); await open(page);
  await page.getByTestId("convert-input").setInputFiles([
    { name: "photo-a.png", mimeType: "image/png", buffer: readFileSync(join(FIX, "photo-a.png")) },
    { name: "sample-a.pdf", mimeType: "application/pdf", buffer: readFileSync(join(TOOLS, "sample-a.pdf")) },
    { name: "notes.xyz", mimeType: "application/octet-stream", buffer: Buffer.from("hello") },
  ]);
  await expect(page.getByTestId("convert-file")).toHaveCount(3);
  await expect(page.getByText("Multies can't convert this kind of file yet.")).toBeVisible();
  await expect(page.getByTestId("convert-to-jpg")).toBeVisible();
  await expect(page.getByTestId("convert-to-html")).toHaveCount(0); // nothing turns a photo into a web page
  await expect(page.getByTestId("convert-to-xlsx")).toBeVisible(); // via PDF and the engine
});

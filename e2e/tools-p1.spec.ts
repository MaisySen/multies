import { test, expect, type Page } from "@playwright/test";
import { readFileSync, statSync, mkdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";

/**
 * Tools P1 end to end: all 13 tools from the Tools page, against a real document engine.
 * Local: a server started with TOOLS_ENABLED and a local engine (TOOLS_E2E=1, E2E_BASE_URL=http://localhost:PORT).
 * Staging: E2E_ALLOW_REMOTE=1 E2E_BASE_URL=https://preview.multies.si with the staging test session cookie in
 * TOOLS_E2E_SESSION_FILE (scripts/staging-session.mjs writes it). Thirteen tool runs, two D1 writes each.
 */
const FIX = "e2e/fixtures/tools";
const SHOTS = process.env.TOOLS_SHOTS;
test.skip(process.env.TOOLS_E2E !== "1", "needs a server with Tools on and a document engine");
test.describe.configure({ mode: "serial" });

/** Pages in a PDF: the largest /Count of a /Pages node, looking inside compressed object streams too. */
function pageCount(buf: Buffer): number {
  const texts = [buf.toString("latin1")];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  const s = texts[0];
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    try { texts.push(inflateSync(buf.subarray(start, end)).toString("latin1")); } catch { /* not flate */ }
    re.lastIndex = end;
  }
  let n = 0;
  for (const t of texts) for (const x of t.matchAll(/\/Type\s*\/Pages\b[^]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^]*?\/Type\s*\/Pages\b/g)) n = Math.max(n, Number(x[1] ?? x[2]));
  return n;
}

async function signIn(page: Page) {
  const sessionFile = process.env.TOOLS_E2E_SESSION_FILE;
  if (sessionFile) {
    // scripts/staging-session.mjs writes { cookie_name, cookie_value }.
    const { cookie_name: name, cookie_value: value } = JSON.parse(readFileSync(sessionFile, "utf8")) as { cookie_name: string; cookie_value: string };
    const base = new URL(test.info().project.use.baseURL ?? "http://localhost");
    await page.context().addCookies([{ name, value, domain: base.hostname, path: "/", secure: base.protocol === "https:", httpOnly: true, sameSite: "Lax" }]);
    const me = await (await page.request.get("/api/account/me")).json() as { user?: { onboarded?: boolean; onboardedAt?: string | null } };
    if (!me.user?.onboarded && !me.user?.onboardedAt) {
      const done = await page.request.post("/api/account/onboarding", { data: { name: "Staging Test", timezone: "Australia/Sydney", locale: "en-AU", company: "Multies QA", workspaceTimezone: "Australia/Sydney" }, headers: { origin: base.origin } });
      expect(done.status()).toBeLessThan(300);
    }
    return;
  }
  const email = `tools${Date.now()}@example.com`;
  const r = await page.request.post("/api/auth/sign-up/email", { data: { name: "Tess Tools", email, password: "a-strong-password" } });
  expect(r.status()).toBe(200);
  const done = await page.request.post("/api/account/onboarding", { data: { name: "Tess Tools", timezone: "Australia/Sydney", locale: "en-AU", company: "Tools Test Co", workspaceTimezone: "Australia/Sydney" } });
  expect(done.status()).toBeLessThan(300);
}

type Op = "compress" | "merge" | "convert" | "to-jpeg" | "images-to-pdf" | "split" | "rotate" | "scrub" | "ocr" | "redact" | "watermark" | "unlock" | "pdf-to-docx";

async function runTool(page: Page, op: Op, files: string[], shot: string, options: Record<string, string> = {}) {
  await page.goto(`/app/tools?op=${op}`);
  await expect(page.getByTestId("tools-page")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId(`tool-${op}`).click();
  await page.getByTestId("tools-input").setInputFiles(files.map((f) => join(FIX, f)));
  for (const [name, value] of Object.entries(options)) {
    const field = page.getByTestId(`tools-opt-${name}`);
    if ((await field.getAttribute("role")) === "radiogroup") await field.getByRole("radio", { name: value }).click();
    else await field.fill(value);
  }
  await expect(page.getByTestId("tools-run")).toBeEnabled();
  if (SHOTS && (op === "merge" || op === "redact")) await page.screenshot({ path: join(SHOTS, `tools-${op}-options-desktop-light.png`) });
  await page.getByTestId("tools-run").click();
  await expect(page.getByTestId("tools-download")).toBeVisible({ timeout: 240_000 });
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${shot}-desktop-light.png`) });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("tools-download").click()]);
  const path = await dl.path();
  return { buf: readFileSync(path), name: dl.suggestedFilename() };
}

/** Entries in a ZIP: its local file headers. */
const zipEntries = (buf: Buffer) => buf.toString("latin1").split("PK\x03\x04").length - 1;
/** Every stream inflated, for looking at what a PDF holds. */
function pdfText(buf: Buffer): string {
  const s = buf.toString("latin1");
  const out = [s];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    try { out.push(inflateSync(buf.subarray(start, end)).toString("latin1")); } catch { /* not flate */ }
    re.lastIndex = end;
  }
  return out.join("\n");
}

test.beforeEach(async ({ page }) => {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
});

test("compress a PDF: the result is a smaller PDF", async ({ page }) => {
  const { buf, name } = await runTool(page, "compress", ["sample-a.pdf"], "tools-compress-done");
  expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(buf.byteLength).toBeLessThan(statSync(join(FIX, "sample-a.pdf")).size);
  expect(name).toBe("sample-a-compressed.pdf");
});

test("merge 2 PDFs: the pages add up", async ({ page }) => {
  const { buf, name } = await runTool(page, "merge", ["sample-a.pdf", "sample-b.pdf"], "tools-merge-done");
  expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pageCount(buf)).toBe(pageCount(readFileSync(join(FIX, "sample-a.pdf"))) + pageCount(readFileSync(join(FIX, "sample-b.pdf"))));
  expect(name).toBe("sample-a-merged.pdf");
});

test("PDF to images: one JPEG per page in a ZIP", async ({ page }) => {
  const { buf, name } = await runTool(page, "to-jpeg", ["sample-a.pdf"], "tools-to-jpeg-done", { dpi: "Small" });
  expect(buf.subarray(0, 2).toString()).toBe("PK");
  expect(zipEntries(buf)).toBe(pageCount(readFileSync(join(FIX, "sample-a.pdf"))));
  expect(name).toBe("sample-a-pages.zip");
});

test("images to PDF: one page per image", async ({ page }) => {
  const { buf, name } = await runTool(page, "images-to-pdf", ["photo-1.png", "photo-2.jpg"], "tools-images-to-pdf-done");
  expect(pageCount(buf)).toBe(2);
  expect(name).toBe("photo-1.pdf");
});

test("split by ranges: one PDF per range in a ZIP", async ({ page }) => {
  const { buf, name } = await runTool(page, "split", ["sample-a.pdf"], "tools-split-done", { ranges: "1, 2-3" });
  expect(zipEntries(buf)).toBe(2);
  expect(name).toBe("sample-a-split.zip");
});

test("rotate the second page upside down", async ({ page }) => {
  const { buf, name } = await runTool(page, "rotate", ["redact-me.pdf"], "tools-rotate-done", { angle: "Upside down", ranges: "2" });
  expect(pdfText(buf)).toMatch(/\/Rotate\s+180/);
  expect(name).toBe("redact-me-rotated.pdf");
});

test("remove metadata: the title and author are gone", async ({ page }) => {
  expect(pdfText(readFileSync(join(FIX, "redact-me.pdf")))).toContain("Secret Title QA");
  const { buf, name } = await runTool(page, "scrub", ["redact-me.pdf"], "tools-scrub-done");
  const text = pdfText(buf);
  expect(text).not.toContain("Secret Title QA");
  expect(text).not.toContain("Quiet Author QA");
  expect(name).toBe("redact-me-clean.pdf");
});

test("OCR a scan: progress shows, the result is a searchable PDF", async ({ page }) => {
  const { buf, name } = await runTool(page, "ocr", ["scan.pdf"], "tools-ocr-done");
  expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdfText(buf)).toContain("GlyphLessFont");
  await expect(page.getByTestId("tools-facts")).toHaveText("1 page.");
  expect(name).toBe("scan-searchable.pdf");
});

test("redact two phrases: every match covered and checked", async ({ page }) => {
  const { buf, name } = await runTool(page, "redact", ["redact-me.pdf"], "tools-redact-done", { phrases: "Jane Citizen\n123 456 782" });
  await expect(page.getByTestId("tools-facts")).toContainText("Blacked out 3 matches");
  await expect(page.getByTestId("tools-facts")).toContainText("none of the text can be found");
  const text = pdfText(buf);
  expect(text).not.toContain("Jane Citizen");
  expect(text).not.toContain("123 456 782");
  expect(name).toBe("redact-me-redacted.pdf");
});

test("watermark every page", async ({ page }) => {
  const { buf, name } = await runTool(page, "watermark", ["sample-b.pdf"], "tools-watermark-done", { text: "CONFIDENTIAL" });
  expect(pdfText(buf)).toContain("CONFIDENTIAL");
  expect(name).toBe("sample-b-watermarked.pdf");
});

test("remove a password the user knows", async ({ page }) => {
  expect(pdfText(readFileSync(join(FIX, "locked.pdf")))).toContain("/Encrypt");
  const { buf, name } = await runTool(page, "unlock", ["locked.pdf"], "tools-unlock-done", { password: "open-sesame" });
  expect(pdfText(buf)).not.toContain("/Encrypt");
  expect(name).toBe("locked-unlocked.pdf");
});

test("PDF to Word: a DOCX, with the text and basic layout note", async ({ page }) => {
  await page.goto("/app/tools?op=pdf-to-docx");
  await expect(page.getByTestId("tools-note")).toContainText("Text and basic layout only");
  const { buf, name } = await runTool(page, "pdf-to-docx", ["redact-me.pdf"], "tools-pdf-to-docx-done");
  expect(buf.subarray(0, 2).toString()).toBe("PK");
  expect(buf.toString("latin1")).toContain("word/document.xml");
  expect(name).toBe("redact-me.docx");
});

test("convert a Word document to PDF", async ({ page }) => {
  const { buf, name } = await runTool(page, "convert", ["sample.docx"], "tools-convert-done");
  expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pageCount(buf)).toBeGreaterThanOrEqual(1);
  expect(name).toBe("sample.pdf");
  if (SHOTS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(SHOTS, "tools-convert-done-phone-light.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app/tools");
    await expect(page.getByTestId("tool-ocr")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "tools-grid-desktop-dark.png"), fullPage: true });
  }
});

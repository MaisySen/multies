import { test, expect, type Page } from "@playwright/test";
import { readFileSync, statSync, mkdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";

/**
 * Tools P1 end to end: compress, merge and Word to PDF from the Tools page, against a real document engine.
 * Local: a server started with TOOLS_ENABLED and a local engine (TOOLS_E2E=1, E2E_BASE_URL=http://localhost:PORT).
 * Staging: E2E_ALLOW_REMOTE=1 E2E_BASE_URL=https://preview.multies.si with the staging test session cookie in
 * TOOLS_E2E_SESSION_FILE (scripts/staging-session.mjs writes it). Three tool runs, a handful of D1 writes.
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
    const { cookie } = JSON.parse(readFileSync(sessionFile, "utf8")) as { cookie: string };
    const base = new URL(test.info().project.use.baseURL ?? "http://localhost");
    const eq = cookie.indexOf("=");
    await page.context().addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1).split(";")[0], domain: base.hostname, path: "/", secure: base.protocol === "https:", httpOnly: true, sameSite: "Lax" }]);
    return;
  }
  const email = `tools${Date.now()}@example.com`;
  const r = await page.request.post("/api/auth/sign-up/email", { data: { name: "Tess Tools", email, password: "a-strong-password" } });
  expect(r.status()).toBe(200);
  const done = await page.request.post("/api/account/onboarding", { data: { name: "Tess Tools", timezone: "Australia/Sydney", locale: "en-AU", company: "Tools Test Co", workspaceTimezone: "Australia/Sydney" } });
  expect(done.status()).toBeLessThan(300);
}

async function runTool(page: Page, op: "compress" | "merge" | "convert", files: string[], shot: string) {
  await page.goto(`/app/tools?op=${op}`);
  await expect(page.getByTestId("tools-page")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId(`tool-${op}`).click();
  await page.getByTestId("tools-input").setInputFiles(files.map((f) => join(FIX, f)));
  await expect(page.getByTestId("tools-run")).toBeEnabled();
  if (SHOTS && op === "merge") await page.screenshot({ path: join(SHOTS, "tools-merge-order-desktop-light.png") });
  await page.getByTestId("tools-run").click();
  await expect(page.getByTestId("tools-download")).toBeVisible({ timeout: 120_000 });
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${shot}-desktop-light.png`) });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("tools-download").click()]);
  const path = await dl.path();
  return { buf: readFileSync(path), name: dl.suggestedFilename() };
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
    await expect(page.getByTestId("tools-page")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "tools-empty-desktop-dark.png") });
  }
});

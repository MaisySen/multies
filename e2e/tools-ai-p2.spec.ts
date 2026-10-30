import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Tools P2, H3: the AI document helpers end to end in a browser, local only, against a server with Tools on
 * (TOOLS_FEATURES=all), the stand in engine e2e/support/ai-engine.mjs (AI_E2E=1, E2E_BASE_URL=http://localhost:PORT).
 * The AI answers for ask and translate are stubbed in the browser (the meter and prompts are covered by unit
 * tests); invoices and contracts run the server's rules for real. AI_SHOTS=<dir> also writes screenshots.
 */
const SHOTS = process.env.AI_SHOTS;
test.skip(process.env.AI_E2E !== "1", "needs a server with the AI helpers on and the stand in engine");
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  const email = `aidocs${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  const r = await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Lovelace", email, password: "a-strong-password" } });
  expect(r.status()).toBe(200);
  const done = await page.request.post("/api/account/onboarding", { data: { name: "Ada Lovelace", timezone: "Australia/Sydney", locale: "en-AU", company: "Blue Cafe", workspaceTimezone: "Australia/Sydney" } });
  expect(done.status()).toBeLessThan(300);
}

async function shots(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const [vp, w, h] of [["desktop", 1280, 900], ["phone", 390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, `ai-${name}-${vp}-${scheme}.png`), fullPage: vp === "desktop", type: "png" });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

const pdf = (name: string) => ({ name, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% sample\n") });

test("ask a document: summary and a question with pages", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/tools/ai/ask", async (route) => {
    const body = route.request().postDataJSON() as { question?: string };
    await route.fulfill({ json: body.question
      ? { name: "lease.pdf", question: body.question, answer: "The bond is $12,600, held by the landlord (p. 2).", bullets: null, pages: [2], partial: false, pagesRead: 3, source: "free" }
      : { name: "lease.pdf", question: null, answer: null, bullets: ["Blue Cafe leases Shop 4, 12 King Street, Sydney from Harbour Properties (p. 1)", "Rent is $4,200 a month plus GST, paid in advance (p. 2)", "The bond is $12,600 (p. 2)", "Either party can end it with 60 days written notice (p. 3)"], pages: [1, 2, 3], partial: false, pagesRead: 3, source: "free" } });
  });
  await page.goto("/app/tools/ai?feature=ask");
  await expect(page.getByTestId("tools-ai")).toBeVisible();
  await expect(page.getByTestId("ai-usage")).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(pdf("lease.pdf"));
  await page.getByRole("button", { name: "Summarise" }).click();
  await expect(page.getByTestId("ai-summary")).toContainText("60 days");
  await page.getByLabel("Ask a question about the document").fill("How much is the bond?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByTestId("ai-answer")).toContainText("Pages: 2");
  await shots(page, "ask");
});

test("contract dates: facts by rules and reminders into My Work", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/tools/ai?feature=contracts");
  await page.locator('input[type=file]').setInputFiles(pdf("linen contract.pdf"));
  await page.getByRole("button", { name: "Find key facts" }).click();
  const card = page.getByTestId("ai-contract");
  await expect(card).toContainText("Fresh Linen Co");
  await expect(card).toContainText("2027-11-30");
  await expect(card).toContainText("30 days");
  await shots(page, "contract");
  await page.getByRole("button", { name: "Add reminders" }).click();
  await expect(card).toContainText("Added 2 tasks");
});

test("invoices to a sheet: review table and Excel download", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/tools/ai?feature=extract");
  await page.locator('input[type=file]').setInputFiles([pdf("acme invoice.pdf"), pdf("office receipt.pdf")]);
  await page.getByRole("button", { name: "Read details" }).click();
  const table = page.getByTestId("ai-review");
  await expect(table).toBeVisible();
  await expect(page.getByLabel("Supplier for acme invoice.pdf")).toHaveValue("Acme Plumbing Pty Ltd");
  await expect(page.getByLabel("Total for office receipt.pdf")).toHaveValue("40.00");
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Excel" }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.xlsx$/);
  await shots(page, "invoices");
});

test("translate keeping layout: progress and download", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/tools/ai/translate", async (route) => {
    await route.fulfill({ json: { translations: { p1s0: "व्यावसायिक लिज।", p2s0: "भाडा मासिक $4,200 हो।" }, total: 8, done: 8, next: null } });
  });
  await page.goto("/app/tools/ai?feature=translate");
  await page.locator('input[type=file]').setInputFiles(pdf("lease.pdf"));
  await page.getByLabel("Translate into").selectOption("ne");
  await page.getByRole("button", { name: "Translate" }).click();
  await expect(page.getByTestId("ai-translate-done")).toContainText("lease (Nepali).pdf");
  await expect(page.getByText("Machine translation can be wrong.")).toBeVisible();
  await shots(page, "translate");
});

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * R102 Smart document inbox (DOC_INBOX_R102 with FILES_PLUS_R101) in a demo workspace, made up documents only.
 * Flows: empty Documents, upload a PDF and a picture (the stand in engine reads them), the text is found and searchable,
 * a rule tags and types it, Unpaid bills lists it, a detected field is corrected, Mark as checked, the daily cap
 * shows as waiting, a member sees rules read only. Axe at 1280 and 390, light and dark; Forest shots.
 * Local only: DOC_E2E=1 with the server env DOC_INBOX_R102=on FILES_PLUS_R101=on TOOLS_ENABLED=true TOOLS_FEATURES=all
 * DOC_ENGINE_URL=http://localhost:<port of e2e/support/index-engine.mjs> DOC_ENGINE_KEY_ID DOC_ENGINE_KEY TOOLS_TOKEN_KEY.
 */
test.skip(process.env.DOC_E2E !== "1", "needs the stand in engine and the R102 server env");
const SHOTS = process.env.SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDEwMDAwAAAhEgEC0Z3yWQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");

async function demo(page: Page) {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  return { origin };
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
async function check(page: Page, name: string) {
  for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await noSeriousAxe(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} ${vp} horizontal scroll`).toBeLessThanOrEqual(1);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `r102-${name}-${vp}-${scheme}.png`), fullPage: false });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
}
async function forest(page: Page, name: string) {
  if (!SHOTS) return;
  await page.evaluate(() => { document.documentElement.dataset.theme = "forest"; });
  await page.screenshot({ path: join(SHOTS, `r102-${name}-1280-forest.png`) });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
}
const rows = (page: Page) => page.getByTestId("docs-row");

test("documents: empty, upload, read, rule, saved view, correct a field, check", async ({ page }) => {
  test.setTimeout(240_000);
  const { origin } = await demo(page);
  await page.goto("/app/files?view=docs&dv=all");
  await expect(page.getByTestId("docs-view")).toBeVisible();
  await expect(page.getByTestId("docs-empty")).toBeVisible();
  await check(page, "empty");

  // An admin rule: anything from Harbour is a bill tagged supplier.
  await page.getByTestId("docs-rules").click();
  await expect(page.getByTestId("docs-rules-empty")).toBeVisible();
  await page.getByTestId("docs-rule-add").click();
  await page.getByTestId("docs-rule-name").fill("Harbour bills");
  await page.getByTestId("docs-rule-match").selectOption("fuzzy");
  await page.getByTestId("docs-rule-pattern").fill("harbor supplies");
  await page.getByTestId("docs-rule-tags").fill("supplier");
  await page.getByTestId("docs-rule-type").selectOption("bill");
  await page.getByTestId("docs-rule-save").click();
  await expect(page.getByTestId("docs-rule")).toHaveCount(1);
  await check(page, "rules");
  await page.keyboard.press("Escape");

  // A bad pattern is refused in plain words.
  const bad = await page.request.post("/api/doc-inbox/rules", { headers: { origin }, data: { name: "Bad", match: "regex", pattern: "(a+)+", setTags: ["x"] } });
  expect(bad.status()).toBe(422);

  // Upload a PDF to Team files and a picture to My files.
  await page.getByTestId("docs-space").selectOption("team");
  await page.getByTestId("docs-file-input").setInputFiles([{ name: "harbour-2207.pdf", mimeType: "application/pdf", buffer: PDF }]);
  await page.getByTestId("docs-space").selectOption("private");
  await page.getByTestId("docs-file-input").setInputFiles([{ name: "deskgear-receipt.png", mimeType: "image/png", buffer: PNG }]);
  await expect(rows(page)).toHaveCount(2, { timeout: 30_000 });
  await expect(rows(page).filter({ hasText: "harbour-2207.pdf" })).toContainText("Harbour Supplies Pty Ltd", { timeout: 40_000 });
  await expect(rows(page).filter({ hasText: "deskgear-receipt.png" })).toContainText("$64.90", { timeout: 40_000 });
  await check(page, "list");
  await forest(page, "list");

  // Unpaid bills is the saved view: the PDF bill is there, the paid receipt is not.
  await page.getByTestId("docs-tab-unpaid").click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("harbour-2207.pdf");
  await page.getByTestId("docs-tab-receipts").click();
  await expect(rows(page)).toHaveCount(1);

  // Search inside documents.
  await page.getByTestId("docs-search").fill("office chairs");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("harbour-2207.pdf");
  await page.getByTestId("docs-search").fill("");

  // Open the bill: the rule tagged it, the text is there; correct the amount and mark it paid, then checked.
  await page.getByTestId("docs-tab-all").click();
  await rows(page).filter({ hasText: "harbour-2207.pdf" }).click();
  const panel = page.getByTestId("docs-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("docs-rules-applied")).toContainText("Harbour bills");
  await expect(panel).toContainText("supplier");
  await expect(panel.getByTestId("docs-field-amount")).toHaveValue("1980.00");
  await panel.getByTestId("docs-text").locator("summary").click();
  await expect(panel.getByTestId("docs-text")).toContainText("TAX INVOICE");
  await check(page, "detail");
  await forest(page, "detail");
  await panel.getByTestId("docs-field-amount").fill("2,000.00");
  await panel.getByRole("switch", { name: "Paid" }).click();
  await panel.getByTestId("docs-save").click();
  await expect(panel).toContainText("Edited by you");
  await panel.getByTestId("docs-check").click();
  await expect(panel.getByTestId("docs-uncheck")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("docs-tab-unpaid").click();
  await expect(rows(page)).toHaveCount(0);
  await check(page, "unpaid-empty");
  // The field stays corrected after reading again.
  const id = (await (await page.request.get("/api/doc-inbox/list?view=all")).json()).items.find((x: { name: string }) => x.name === "harbour-2207.pdf").id as string;
  const again = await (await page.request.post(`/api/doc-inbox/items/${id}/read`, { headers: { origin } })).json();
  expect(again.fields.amount).toBe(200000);
});

test("documents: the daily cap shows as waiting", async ({ page }) => {
  const { origin } = await demo(page);
  // Sixty plain text uploads use up today's reading for this workspace; the next one waits.
  for (let i = 0; i < 60; i++) {
    const r = await page.request.put(`/api/drive/upload?space=private&name=${encodeURIComponent(`note-${i}.txt`)}`, { headers: { origin, "x-multies-upload": "1", "content-type": "text/plain" }, data: Buffer.from(`Receipt ${i}\nTotal paid $${i}.00`) });
    expect(r.ok()).toBe(true);
    if (i % 10 === 9) await page.request.get("/api/doc-inbox/list?view=all");
  }
  for (let k = 0; k < 40; k++) { const l = await (await page.request.get("/api/doc-inbox/list?view=all")).json(); if (!l.counts.waiting) break; }
  await page.request.put(`/api/drive/upload?space=private&name=late.txt`, { headers: { origin, "x-multies-upload": "1", "content-type": "text/plain" }, data: Buffer.from("Late receipt\nTotal paid $5.00") });
  await page.goto("/app/files?view=docs&dv=all");
  await expect(page.getByTestId("docs-capped")).toBeVisible();
  await expect(rows(page).filter({ hasText: "late.txt" })).toContainText("Waiting for tomorrow");
  await check(page, "capped");
});

test("documents: a member reads rules but cannot change them; the nav item is there", async ({ browser, page }) => {
  const { origin } = await demo(page);
  await page.request.post("/api/doc-inbox/rules", { headers: { origin }, data: { name: "Phone bills", match: "any", pattern: "telstra", setTags: ["phone"] } });
  const res = await page.request.post("/api/team/invites", { data: { email: `m-${Date.now()}@example.com`, role: "member" }, headers: { origin } });
  const invite = (await res.json().catch(() => ({}))) as { link?: string };
  test.skip(!res.ok() || !invite.link, `invites are not open in this workspace (${res.status()} ${JSON.stringify(invite).slice(0, 120)})`);
  if (!invite.link) return;
  const base = new URL(page.url()).origin;
  const mctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 } });
  const mp = await mctx.newPage();
  const email = new URL(invite.link).searchParams.get("email") ?? `mm-${Date.now()}@example.com`;
  await mp.request.post("/api/auth/sign-up/email", { data: { name: "Max Member", email, password: "a-strong-password" }, headers: { origin } });
  const acc = await mp.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: { origin } });
  test.skip(acc.status() !== 200, "invite acceptance needs a verified address on this server");
  await mp.goto("/app/files?view=docs");
  await expect(mp.getByTestId("drive-nav-docs")).toBeVisible();
  await mp.getByTestId("docs-rules").click();
  await expect(mp.getByTestId("docs-rule")).toHaveCount(1);
  await expect(mp.getByText("Only owners and admins can change rules.")).toBeVisible();
  await expect(mp.getByTestId("docs-rule-add")).toHaveCount(0);
  const denied = await mp.request.post("/api/doc-inbox/rules", { headers: { origin }, data: { name: "Mine", match: "any", pattern: "x", setTags: ["x"] } });
  expect(denied.status()).toBe(403);
  await mctx.close();
});

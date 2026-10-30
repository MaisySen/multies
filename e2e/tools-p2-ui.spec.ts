import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sign } from "../email-worker/src/index";

/**
 * Tools P2, H2: the Tools page with P2 tools (password, stamps, convert anything, Excel, scan to PDF with the camera,
 * more OCR languages), Find and hide sensitive info, and Run on all attachments in a thread. Local only, against a
 * server with TOOLS_FEATURES=all and the stand in engine e2e/support/tools-p2-engine.mjs
 * (TOOLS_P2_E2E=1, E2E_BASE_URL=http://localhost:PORT). TOOLS_P2_SHOTS=<dir> writes ui-*.png (1280 and 390, light and dark).
 */
const FIX = "e2e/fixtures/tools";
const SHOTS = process.env.TOOLS_P2_SHOTS;
test.skip(process.env.TOOLS_P2_E2E !== "1", "needs a server with Tools P2 on and the stand in engine");
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  const email = `toolsp2${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  const r = await page.request.post("/api/auth/sign-up/email", { data: { name: "Tess Tools", email, password: "a-strong-password" } });
  expect(r.status()).toBe(200);
  const done = await page.request.post("/api/account/onboarding", { data: { name: "Tess Tools", timezone: "Australia/Sydney", locale: "en-AU", company: "Tools Test Co", workspaceTimezone: "Australia/Sydney" } });
  expect(done.status()).toBeLessThan(300);
}

async function shots(page: Page, name: string, setup?: () => Promise<void>) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const [vp, w, h] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      if (setup) await setup();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, `ui-${name}-${vp}-${scheme}.png`), type: "png" });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 860 });
}

const panel = (page: Page) => page.getByTestId("tools-panel");
const toPanel = async (page: Page) => { await panel(page).scrollIntoViewIfNeeded(); };

test("P2 cards show by flag; password, stamp and OCR languages; PDF to Excel downloads as xlsx with Attach to a new email", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/tools");
  await expect(page.getByTestId("tools-page")).toBeVisible({ timeout: 20_000 });
  for (const op of ["protect", "stamp", "to-pdf", "pdf-to", "pdf-tables", "excel-merge", "excel-clean", "scan-clean", "pii-find"]) await expect(page.getByTestId(`tool-${op}`)).toBeVisible();
  await shots(page, "grid", async () => { await page.evaluate(() => window.scrollTo(0, 0)); });

  // Password: needs 4 characters, the permissions are choices.
  await page.getByTestId("tool-protect").click();
  await page.getByTestId("tools-input").setInputFiles(join(FIX, "sample-a.pdf"));
  await page.getByTestId("tools-opt-password").fill("abc");
  await expect(page.getByTestId("tools-run")).toBeDisabled();
  await page.getByTestId("tools-opt-password").fill("abcd1234");
  await expect(page.getByTestId("tools-run")).toBeEnabled();
  await shots(page, "protect", () => toPanel(page));

  // Stamp: the words show only for Your own words, the number position only with page numbers.
  await page.getByTestId("tool-stamp").click();
  await page.getByTestId("tools-input").setInputFiles(join(FIX, "sample-a.pdf"));
  await expect(page.getByTestId("tools-opt-stamp_text")).toHaveCount(0);
  await page.getByTestId("tools-opt-stamp").selectOption({ label: "Your own words" });
  await page.getByTestId("tools-opt-stamp_text").fill("RECEIVED 30 OCT");
  await page.getByTestId("tools-opt-page_numbers").getByRole("radio", { name: "Page 1 of 9" }).click();
  await expect(page.getByTestId("tools-opt-number_position")).toBeVisible();
  await shots(page, "stamp", () => toPanel(page));

  // OCR: Nepali and Hindi are offered (ocr_langs on).
  await page.getByTestId("tool-ocr").click();
  const langs = await page.getByTestId("tools-opt-language").locator("option").allTextContents();
  expect(langs).toEqual(expect.arrayContaining(["English", "Nepali", "Hindi", "English and Nepali"]));

  // PDF to Excel: the result is named .xlsx and offers Attach to a new email.
  await page.getByTestId("tool-pdf-to").click();
  await page.getByTestId("tools-input").setInputFiles(join(FIX, "sample-a.pdf"));
  await page.getByTestId("tools-opt-target").getByRole("radio", { name: "Excel (tables)" }).click();
  await page.getByTestId("tools-run").click();
  await expect(page.getByTestId("tools-download")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tools-result")).toContainText("sample-a.xlsx");
  await expect(page.getByTestId("tools-attach")).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("tools-download").click()]);
  expect(dl.suggestedFilename()).toBe("sample-a.xlsx");
  await shots(page, "pdfto-done", async () => { await page.getByTestId("tools-result").scrollIntoViewIfNeeded(); });

  // Attach to a new email goes to Mail with the result (this workspace has no mailbox; the batch test sees the chips).
  await page.getByTestId("tools-attach").click();
  await expect(page).toHaveURL(/\/app\/mail/);
});

test("scan to PDF offers Take photo on a phone, and photos keep their order", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/tools?op=scan-clean");
  await expect(page.getByTestId("tools-camera")).toBeVisible({ timeout: 20_000 });
  expect(await page.getByTestId("tools-camera-input").getAttribute("capture")).toBe("environment");
  await page.getByTestId("tools-camera-input").setInputFiles(join(FIX, "photo-1.png"));
  await page.getByTestId("tools-camera-input").setInputFiles(join(FIX, "photo-2.jpg"));
  await expect(page.getByRole("list", { name: "Files to use" }).getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("tools-opt-language")).toHaveCount(0);
  await page.getByTestId("tools-opt-ocr").getByRole("radio", { name: "Yes" }).click();
  await expect(page.getByTestId("tools-opt-language")).toBeVisible();
  await shots(page, "scan", () => toPanel(page));
  await page.setViewportSize({ width: 1280, height: 860 });
  await expect(page.getByTestId("tools-camera")).toBeHidden();
});

test("find and hide sensitive info: grouped review, untick one, black out the rest", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/tools?op=pii-find");
  await expect(page.getByTestId("autoredact")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("tools-input").setInputFiles(join(FIX, "redact-me.pdf"));
  await shots(page, "autoredact-start", () => toPanel(page));
  await page.getByTestId("autoredact-find").click();
  await expect(page.getByTestId("autoredact-review")).toBeVisible({ timeout: 30_000 });
  for (const k of ["tfn", "abn", "bsb_account", "card", "medicare", "phone", "email"]) await expect(page.getByTestId(`autoredact-group-${k}`)).toBeVisible();
  await expect(page.getByTestId("autoredact-burn")).toHaveText("Black out 8 items");
  await page.getByTestId("autoredact-group-email").getByRole("checkbox").nth(1).uncheck();
  await expect(page.getByTestId("autoredact-burn")).toHaveText("Black out 7 items");
  await shots(page, "autoredact-review", async () => { await page.getByTestId("autoredact-review").scrollIntoViewIfNeeded(); });
  await page.getByTestId("autoredact-burn").click();
  // R67: the shared result screen (Download, Attach, Use in another tool, Start over).
  await expect(page.getByTestId("tools-result")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tools-facts")).toContainText("Blacked out 5 matches");
  await expect(page.getByTestId("tools-chain")).toBeVisible();
  await shots(page, "autoredact-done", () => toPanel(page));
});

test("run on all attachments: one job per PDF, Download all as one ZIP, attach to a new email", async ({ page, context }) => {
  test.setTimeout(150_000);
  const base = test.info().project.use.baseURL!;
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.128.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  const headers = { origin: new URL(base).origin };
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  const boxes = (await (await page.request.get("/api/mailboxes")).json()).mailboxes as { id: string; address: string; status: string }[];
  const key = (await (await page.request.post("/api/inbound-keys", { headers })).json()).key as { id: string; secret: string };
  const tag = Math.random().toString(36).slice(2, 6);
  const b64 = (f: string) => readFileSync(join(FIX, f)).toString("base64").replace(/.{76}/g, "$&\r\n");
  const part = (name: string, f: string) => ["--b1", `Content-Type: application/pdf; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", b64(f)];
  let box: { id: string; address: string } | undefined;
  for (const b of boxes.filter((x) => x.status === "active")) {
    const raw = [
      "From: Pat Lee <pat.lee@example.org>", `To: ${b.address}`, `Subject: Three invoices ${tag}`,
      `Message-ID: <inv.${tag}.${b.id}@example.org>`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "",
      "Hi, the three invoices for October are attached.", "",
      ...part("Invoice 1041.pdf", "sample-a.pdf"), ...part("Invoice 1042.pdf", "sample-b.pdf"), ...part("Invoice 1043.pdf", "redact-me.pdf"), "--b1--", "",
    ].join("\r\n");
    const body = new TextEncoder().encode(raw);
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = await sign(key.secret, ts, "pat.lee@example.org", b.address, body.buffer as ArrayBuffer);
    const posted = await page.request.post("/api/inbound/cloudflare", {
      headers: { "content-type": "message/rfc822", "x-mymail-key": key.id, "x-mymail-timestamp": ts, "x-mymail-envelope-from": "pat.lee@example.org", "x-mymail-envelope-to": b.address, "x-mymail-signature": signature },
      data: Buffer.from(body),
    });
    if ((await posted.json()).action === "accept") { box = b; break; }
  }
  expect(box, "a mailbox that takes inbound mail").toBeTruthy();
  let msg: { id: string; threadId: string; subject: string } | undefined;
  for (const folder of ["inbox", "spam"]) {
    const list = (await (await page.request.get(`/api/mail/messages?mailboxId=${box!.id}&folder=${folder}`)).json()).messages as { id: string; subject: string; threadId: string }[];
    msg ??= list.find((m) => m.subject === `Three invoices ${tag}`);
  }
  expect(msg).toBeTruthy();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/app/inbox?thread=${encodeURIComponent(msg!.threadId)}`);
  await expect(page.getByTestId("batch-bar")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("batch-bar")).toContainText("3 attachments");
  await shots(page, "batch-bar", async () => { await page.getByTestId("batch-bar").scrollIntoViewIfNeeded(); });
  await page.getByTestId("batch-open").click();
  await page.getByTestId("batch-tool-stamp").click();
  await page.getByTestId("batch-opt-stamp").selectOption({ label: "Paid" });
  await expect(page.getByTestId("batch-run")).toHaveText("Run on 3 files");
  await shots(page, "batch-pick");
  await page.getByTestId("batch-run").click();
  await expect(page.getByTestId("batch-row").and(page.locator("[data-state=done]"))).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByTestId("batch-results")).toContainText("Invoice 1041-stamped.pdf");
  await shots(page, "batch-done");
  const [zip] = await Promise.all([page.waitForEvent("download"), page.getByTestId("batch-download-all").click()]);
  const buf = readFileSync(await zip.path());
  expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  expect(buf.toString("latin1").split("PK\x03\x04").length - 1).toBe(3);
  await page.getByTestId("batch-attach").click();
  await expect(page).toHaveURL(/\/app\/mail/);
  await expect(page.getByTestId("compose-attachments").getByTestId("compose-tool-file")).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByTestId("compose-attachments")).toContainText("Invoice 1042-stamped.pdf");
  await shots(page, "compose-attached");
});

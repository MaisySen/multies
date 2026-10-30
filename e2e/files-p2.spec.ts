import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sign } from "../email-worker/src/index";

/**
 * Tools P2 (16, 17): mail with attachments arrives through the signed inbound webhook, the index pass reads
 * them (a stand in engine answers extract-text), then the Files view shows them in smart folders, the search
 * box and the command menu find words inside them, and Settings has the switch.
 * Local only: INDEX_E2E=1 E2E_BASE_URL=http://localhost:PORT, the server started with Tools on, TOOLS_FEATURES=all,
 * DOC_ENGINE_URL at e2e/support/index-engine.mjs, and E2E_DATABASE_PATH naming the server's DATABASE_PATH (its
 * attachment text index database sits next to it, as src/entry/node.ts opens it).
 */
const SHOTS = process.env.INDEX_SHOTS;
test.skip(process.env.INDEX_E2E !== "1", "needs a local server with Tools on and the stand in engine");

const FILES: { name: string; type: string; body: string | Buffer; subject: string; from: string }[] = [
  { name: "INV-2207.pdf", type: "application/pdf", body: readFileSync("e2e/fixtures/tools/sample-a.pdf"), subject: "Invoice 2207 for October", from: "accounts@harbour-supplies.com.au" },
  { name: "receipt-8841.txt", type: "text/plain", body: "Receipt\nThank you for your purchase\nAmount paid $64.90\nCard ending 4242\nOrder 8841, two ergonomic keyboards", subject: "Your receipt", from: "orders@deskgear.com.au" },
  { name: "quote-Q118.txt", type: "text/plain", body: "QUOTATION\nQuote number Q-118\nFit out of meeting room, glass partition\nThis quote is valid until 30 November\nTotal $7,450.00", subject: "Quote for the meeting room", from: "sam@fitouts.com.au" },
  { name: "service-agreement.txt", type: "text/plain", body: "SERVICE AGREEMENT\nThis agreement is made between the parties below for cleaning services.\nGoverning law New South Wales. Termination with 30 days notice.\nSigned by ____________ Witness ____________", subject: "Cleaning contract to sign", from: "legal@sparkleclean.com.au" },
  { name: "statement-sep.txt", type: "text/plain", body: "Statement of account\nStatement period 1 September to 30 September\nOpening balance $1,200.00\nClosing balance $640.00", subject: "September statement", from: "billing@harbour-supplies.com.au" },
  { name: "payslip-oct.txt", type: "text/plain", body: "Payslip\nGross pay $4,200.00\nNet pay $3,310.00\nSuperannuation $483.00\nPay period October", subject: "Payslip October", from: "payroll@acme-payroll.com.au" },
];

async function deliver(page: Page, base: string, boxes: { id: string; address: string; status: string }[]) {
  const headers = { origin: new URL(base).origin };
  const key = (await (await page.request.post("/api/inbound-keys", { headers })).json()).key as { id: string; secret: string };
  // The first of the workspace's own mailboxes that takes inbound mail (connected ones do not).
  let b: { id: string; address: string } | undefined;
  for (const [i, f] of FILES.entries()) {
    const bytes = typeof f.body === "string" ? Buffer.from(f.body) : f.body;
    const raw = (to: string) => [
      `From: ${f.from}`, `To: ${to}`, `Subject: ${f.subject}`, `Message-ID: <idx.${i}.${Date.now()}@example.org>`, `Date: ${new Date(Date.now() - (FILES.length - i) * 3600_000).toUTCString()}`,
      "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "", "Please see the attached file.", "",
      "--b1", `Content-Type: ${f.type}; name="${f.name}"`, `Content-Disposition: attachment; filename="${f.name}"`, "Content-Transfer-Encoding: base64", "",
      bytes.toString("base64").replace(/.{76}/g, "$&\r\n"), "--b1--", "",
    ].join("\r\n");
    let ok = false;
    for (const box of b ? [b] : boxes.filter((x) => x.status === "active")) {
      const body = new TextEncoder().encode(raw(box.address));
      const ts = Math.floor(Date.now() / 1000).toString();
      const signature = await sign(key.secret, ts, f.from, box.address, body.buffer as ArrayBuffer);
      const r = await page.request.post("/api/inbound/cloudflare", {
        headers: { "content-type": "message/rfc822", "x-mymail-key": key.id, "x-mymail-timestamp": ts, "x-mymail-envelope-from": f.from, "x-mymail-envelope-to": box.address, "x-mymail-signature": signature },
        data: Buffer.from(body),
      });
      if ((await r.json()).action === "accept") { b = box; ok = true; break; }
    }
    expect(ok, `delivered ${f.name}`).toBe(true);
  }
}

test("attachments are read, filed into smart folders and found by words inside them", async ({ page, context }) => {
  test.setTimeout(180_000);
  const base = test.info().project.use.baseURL!;
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.128.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  const boxes = (await (await page.request.get("/api/mailboxes")).json()).mailboxes;
  await deliver(page, base, boxes);
  // The cron pass, run here the way the scheduled handler runs it.
  const out = execFileSync("npx", ["tsx", "e2e/support/index-pass.ts"], { env: { ...process.env, DATABASE_PATH: process.env.E2E_DATABASE_PATH! }, encoding: "utf8", timeout: 90_000 });
  expect(out).toContain('"stop":null');

  const shot = async (name: string) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: join(SHOTS, name) }); } };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto("/app/files?folder=invoice");
    await expect(page.getByTestId("files-row").first()).toContainText("INV-2207.pdf", { timeout: 15_000 });
    await expect(page.getByTestId("files-folder-invoice")).toContainText(/[1-9]/);
    await shot(`files-after-invoices-desktop-${scheme}.png`);
    await page.getByTestId("files-search").fill("keyboards");
    await expect(page.getByTestId("files-row").first()).toContainText("receipt-8841.txt");
    await shot(`files-after-search-desktop-${scheme}.png`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/app/files?folder=contract");
    await expect(page.getByTestId("files-row").first()).toContainText("service-agreement.txt");
    await shot(`files-after-contracts-phone-${scheme}.png`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  // Move to another folder: kept there.
  await page.goto("/app/files?folder=statement");
  await page.getByTestId("files-row").first().getByText("Move to", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Invoices" }).click();
  await expect(page.getByText("Moved to Invoices")).toBeVisible();
  // The command menu groups attachment hits.
  const s = await (await page.request.get("/api/search?q=partition")).json();
  expect(s.groups.find((g: { type: string }) => g.type === "attachments").items[0].title).toBe("quote-Q118.txt");
  await page.goto("/app");
  await expect(page.getByRole("button", { name: /^Search (Ctrl|⌘)/ })).toBeVisible({ timeout: 15_000 });
  const dialog = page.getByRole("dialog");
  // The shortcut, once the app's key handler is in place.
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await dialog.getByRole("combobox").fill("partition");
  await expect(dialog.getByTestId("search-group-attachments")).toContainText("quote-Q118.txt", { timeout: 10_000 });
  await shot("files-after-command-menu-desktop-light.png");
  // Settings, General: the switch beside Tools.
  await page.goto("/app/settings");
  await expect(page.locator("#attachment-search")).toBeVisible({ timeout: 15_000 });
  await page.locator("#attachment-search").scrollIntoViewIfNeeded();
  await shot("files-after-settings-desktop-light.png");
});

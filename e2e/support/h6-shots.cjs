/**
 * Tools P2, H6: screenshots of the automation features against a local server on 8871 with the stand in engine
 * (node e2e/support/auto-engine.mjs 8873; server env TOOLS_ENABLED=true TOOLS_FEATURES=all DOC_ENGINE_URL=http://127.0.0.1:8873
 * plus engine keys, TOOL_FILES=memory, DATABASE_PATH=.data/e2e-auto.db). Local only: it marks its test domain verified in that DB.
 * Usage: node e2e/support/h6-shots.cjs
 */
const { chromium } = require("@playwright/test");
const fs = require("fs");
const B = "http://localhost:8871", OUT = "/home/user/tab/files/multies-tools/p2";
const log = (...a) => console.log("[shots]", ...a);
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("pageerror", e.message));
  await page.goto(B + "/signup");
  await page.getByLabel("Your name").fill("Mia Chen");
  await page.getByLabel("Work email").fill(`mia${Date.now()}@harbour-h6.test`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/app\//, { timeout: 30000 });
  const r = page.request, H = { origin: B };
  const d = await (await r.post(B + "/api/domains", { headers: H, data: { name: `h6${Date.now()}.test` } })).json();
  const mb = await (await r.post(B + "/api/mailboxes", { headers: H, data: { domainId: d.domain.id, localPart: "mia", displayName: "Mia Chen" } })).json();
  log("mailbox", !!mb.mailbox);
  // Local screenshots only: mark the new domain verified so sends go to the local outbox.
  { const D = require("better-sqlite3"); const db = new D(".data/e2e-auto.db"); db.prepare("update domains set status = 'verified' where id = ?").run(d.domain.id); db.close(); }
  const rr = await r.put(B + "/api/tools/rules/workspace", { headers: H, data: { compress: "on", compressOverMb: 2, wordPdf: "on" } });
  log("rules", rr.status());

  // 1. Settings: Before sending
  await page.goto(B + "/app/settings");
  const sec = page.locator("#send-rules");
  await sec.waitFor({ timeout: 20000 });
  await sec.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await sec.screenshot({ path: OUT + "/h6-rules-settings.png" });
  log("rules shot");

  // 2. Composer with a rule chip
  await page.goto(B + "/app/mail?compose=1");
  const dlg = page.getByRole("dialog", { name: "New message" });
  await dlg.waitFor({ timeout: 20000 });
  await dlg.getByLabel("To").fill("jordan@client.test");
  await dlg.getByLabel("Subject").fill("Site report for Pier 4");
  await dlg.getByLabel("Message").fill("Hi Jordan,\n\nThe site report is attached.\n\nMia");
  const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(4_300_000, 32)]);
  await page.getByTestId("compose-file-input").setInputFiles([{ name: "Site report Pier 4.pdf", mimeType: "application/pdf", buffer: big }, { name: "Scope of works.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.alloc(60_000, 65) }]);
  await page.getByTestId("rule-chip").first().waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="rule-chip"]').length >= 2, null, { timeout: 60000 }).catch(() => log("only one chip"));
  await page.waitForTimeout(400);
  await dlg.screenshot({ path: OUT + "/h6-composer-rule-chip.png" });
  log("chip shot", await page.getByTestId("rule-chip").allInnerTexts());
  // send it, through the hold
  await dlg.getByRole("button", { name: "Send" }).last().click().catch(() => {});
  await page.waitForTimeout(9000);

  // 3. Workflows
  await page.goto(B + "/app/tools/workflows");
  await page.getByTestId("workflow-card").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + "/h6-workflows.png", fullPage: true });
  const card = page.getByTestId("workflow-card").filter({ hasText: "Shrink and protect" });
  await card.getByRole("button", { name: "Run" }).click();
  await page.getByTestId("workflow-files").setInputFiles([{ name: "Lease Unit 7.pdf", mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2_000_000, 32)]) }]);
  await page.getByLabel("Password for this run").fill("harbour7");
  await page.getByTestId("workflow-runner").getByRole("button", { name: "Run" }).click();
  await page.getByTestId("auto-result").waitFor({ timeout: 60000 });
  await page.getByTestId("workflow-runner").screenshot({ path: OUT + "/h6-workflow-run.png" });
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByTestId("workflow-builder").getByLabel("Name").fill("Client scan pack");
  await page.getByTestId("workflow-builder").screenshot({ path: OUT + "/h6-workflow-builder.png" });
  log("workflows shots");

  // 4. Templates: invoice
  await page.goto(B + "/app/tools/templates");
  await page.getByTestId("template-preview").waitFor({ timeout: 20000 });
  const fill = async (label, v) => { const l = page.getByLabel(label, { exact: false }).first(); if (await l.count()) await l.fill(v).catch(() => {}); };
  await fill("Client name", "Pier 4 Holdings");
  await fill("Client email", "accounts@pier4.test");
  await fill("Your business name", "Harbour Surveys");
  await fill("Your ABN", "51 824 753 556");
  await fill("Invoice number", "1042");
  await fill("Payment details", "BSB 062 000, account 1234 5678");
  const items = page.getByTestId("lines-editor");
  if (!(await items.getByLabel("Item 1").count())) await items.getByRole("button", { name: "Add an item" }).click();
  await items.getByLabel("Item 1").fill("Site inspection");
  await items.getByLabel("Quantity").first().fill("2");
  await items.getByLabel("Unit price").first().fill("450");
  await items.getByRole("button", { name: "Add an item" }).click();
  await items.getByLabel("Item 2").fill("Written report");
  await items.getByLabel("Quantity").nth(1).fill("1");
  await items.getByLabel("Unit price").nth(1).fill("380");
  await page.waitForTimeout(600);
  log("missing", await page.getByText(/^Fill in/).allInnerTexts());
  await page.getByRole("button", { name: "Make PDF" }).click();
  await page.getByTestId("auto-result").waitFor({ timeout: 60000 }).catch(async () => log("no template result", await page.locator('[role=alert]').allInnerTexts()));
  await page.getByTestId("auto-result").scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + "/h6-template-invoice.png" });
  log("template shot", await page.getByTestId("lines-totals").innerText());

  // 5. Mail merge
  await page.goto(B + "/app/tools/merge");
  await page.getByTestId("merge-cap").waitFor({ timeout: 20000 });
  await page.getByLabel("Template").selectOption("builtin-invoice").catch(() => {});
  const csv = "Name,Email,Invoice number,Item,Qty,Unit price\nJordan Lee,jordan@pier4.test,1051,October berth fees,1,1450\nPriya Shah,priya@harbourcafe.test,1052,Outdoor seating licence,2,320\nTom Nguyen,tom@dockworks.test,1053,Crane hire (hours),6,185\n";
  await page.getByTestId("merge-csv").setInputFiles([{ name: "tenants.csv", mimeType: "text/csv", buffer: Buffer.from(csv) }]);
  await page.getByTestId("merge-preview").waitFor({ timeout: 20000 });
  await page.getByRole("textbox", { name: "Subject" }).fill("Invoice {{invoice_number}} from Harbour Surveys");
  await page.waitForTimeout(800);
  await page.getByTestId("merge-map").screenshot({ path: OUT + "/h6-merge-map.png" });
  await page.getByTestId("merge-preview").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + "/h6-merge-preview.png" });
  await page.getByTestId("merge-consent").check();
  await page.getByTestId("merge-send").click();
  await page.getByTestId("merge-progress").waitFor({ timeout: 30000 });
  await page.waitForTimeout(15000);
  await page.getByTestId("merge-progress").screenshot({ path: OUT + "/h6-merge-progress.png" });
  log("merge", await page.getByTestId("merge-progress").innerText());

  // 6. Tools page links and developer tile
  await page.goto(B + "/app/tools");
  await page.getByTestId("automation-links").waitFor({ timeout: 20000 }).catch(() => log("no links"));
  await page.getByTestId("automation-links").screenshot({ path: OUT + "/h6-tools-automate.png" }).catch(() => {});
  await page.goto(B + "/app/settings/developers");
  await page.getByTestId("developer-tiles").waitFor({ timeout: 20000 }).catch(() => log("no dev tiles"));
  await page.getByTestId("developer-tiles").screenshot({ path: OUT + "/h6-developer-tile.png" }).catch(() => {});
  // phone composer
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await ctx.storageState(), isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  await pp.goto(B + "/app/mail?compose=1");
  await pp.getByRole("dialog", { name: "New message" }).waitFor({ timeout: 20000 });
  await pp.getByTestId("compose-file-input").setInputFiles([{ name: "Site report Pier 4.pdf", mimeType: "application/pdf", buffer: big }]);
  await pp.getByTestId("rule-chip").first().waitFor({ timeout: 60000 }).catch(() => log("phone no chip"));
  await pp.screenshot({ path: OUT + "/h6-composer-phone.png" });
  await browser.close();
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });

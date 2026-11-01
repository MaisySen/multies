import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * R105 invoices and quotes (INVOICES_ENABLED=true in the e2e server). Flows: first time empty state, settings with an ABN
 * check, a draft invoice typed by hand, issued as a tax invoice with a number, a part payment, the logged out view with
 * bank details and the PDF, a quote accepted online and turned into an invoice, sending from a demo workspace (which sends
 * no email: the error says so plainly), long search. Member vs admin is covered in tests/invoices-deliver-r105.test.ts.
 * SHOTS_DIR writes shots at 1280 and 390, light, dark and Forest; axe runs on every screen (serious or critical fails).
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.205.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function axe(page: Page, label: string) {
  await page.waitForTimeout(400);
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string, full = false) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: full });
}
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
async function settings(page: Page) {
  const r = await page.request.put("/api/invoices/settings", { data: { businessName: "Harbour Design", abn: "51 824 753 556", bsb: "062000", accountNumber: "12345678", accountName: "Harbour Design Pty Ltd" } });
  expect(r.status()).toBe(200);
}
async function issuedInvoice(page: Page, buyerName = "Sam Lee") {
  const d = (await (await page.request.post("/api/invoices/docs", { data: { kind: "invoice", buyerName, buyerEmail: "sam@harbour.com.au", lines: [{ description: "Logo design", quantityMilli: 1000, unitCents: 120000 }, { description: "Printing", quantityMilli: 2500, unitCents: 4000, gstFree: true }] } })).json()) as { doc: { id: string } };
  return ((await (await page.request.post(`/api/invoices/docs/${d.doc.id}/issue`, { data: {} })).json()) as { doc: { id: string; number: string; viewUrl: string } }).doc;
}

test("first time: empty state, settings with an ABN check, and the Contacts entry", async ({ page }) => {
  await demo(page);
  await page.goto("/app/contacts");
  await page.getByRole("link", { name: "Invoices" }).click();
  await expect(page).toHaveURL(/\/app\/contacts\/invoices$/);
  await expect(page.getByRole("heading", { name: "Invoices and quotes" })).toBeVisible();
  await expect(page.getByText("No invoices yet")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "business name and ABN" })).toBeVisible();
  await axe(page, "empty");
  await page.getByRole("button", { name: "Set up invoicing" }).click();
  const dlg = page.getByRole("dialog", { name: "Invoice settings" });
  await dlg.getByLabel("Business name").fill("Harbour Design");
  await dlg.getByLabel("ABN").fill("51 824 753 557");
  await expect(dlg.getByText("That ABN does not look right")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Save settings" })).toBeDisabled();
  await dlg.getByLabel("ABN").fill("51 824 753 556");
  await dlg.getByLabel("BSB").fill("062 000");
  await dlg.getByLabel("Account number").fill("12345678");
  await axe(page, "settings");
  await dlg.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Invoice settings saved")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "business name and ABN" })).toHaveCount(0);
  for (const tab of ["Quotes", "Credit notes", "Bills", "Items", "Reports"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    await axe(page, `tab ${tab}`);
  }
});

test("draft to tax invoice: lines, totals, issue with a number, part payment, PDF", async ({ page }) => {
  await demo(page);
  await settings(page);
  await page.goto("/app/contacts/invoices");
  await page.getByRole("button", { name: "New invoice" }).first().click();
  await expect(page.getByRole("heading", { name: "New invoice" })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Name", { exact: true }).fill("Sam Lee");
  await page.getByLabel("Email").fill("sam@harbour.com.au");
  await page.getByLabel("Description, line 1").fill("Logo design");
  await page.getByLabel("Price").first().fill("1200");
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByLabel("Description, line 2").fill("Printing");
  await page.getByLabel("Qty").nth(1).fill("2.5");
  await page.getByLabel("Price").nth(1).fill("40");
  await page.getByLabel("GST free").nth(1).check();
  await expect(page.getByText("$1,420.00").first()).toBeVisible(); // 1200 + 100 net, GST 120 on the first line only
  await axe(page, "editor");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved")).toBeVisible();
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.getByRole("heading", { name: /Tax invoice INV/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Unpaid").first()).toBeVisible();
  await axe(page, "issued");
  await page.getByRole("button", { name: "Record payment" }).click();
  const pay = page.getByRole("dialog", { name: "Record a payment" });
  await pay.getByLabel("Amount").fill("2000");
  await expect(pay.getByText("more than the amount owing")).toBeVisible();
  await pay.getByLabel("Amount").fill("420");
  await pay.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Part paid").first()).toBeVisible();
  const href = await page.getByRole("link", { name: "PDF" }).getAttribute("href");
  const pdf = await page.request.get(href!);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  // issued documents cannot be deleted: void keeps the number
  await page.getByRole("button", { name: "Void" }).click();
  await expect(page.getByRole("dialog", { name: /Void INV/ })).toContainText("numbering has no gaps");
  await page.keyboard.press("Escape");
  await page.goto("/app/contacts/invoices");
  await expect(page.getByRole("link", { name: /INV-/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Overdue", exact: true }).click();
  await expect(page.getByText("Nothing matches")).toBeVisible();
  await page.getByLabel("Search invoices").fill("x".repeat(60));
  await expect(page.getByText("Nothing matches")).toBeVisible();
});

test("logged out view: that one invoice with bank details and the PDF; a bad link says so", async ({ page, browser }) => {
  await demo(page);
  await settings(page);
  const inv = await issuedInvoice(page);
  const path = new URL(inv.viewUrl).pathname;
  const ctx = await browser.newContext();
  const anon = await ctx.newPage();
  await anon.goto(path);
  await expect(anon.getByRole("heading", { name: `Tax invoice ${inv.number}` })).toBeVisible({ timeout: 15_000 });
  await expect(anon.getByText("Harbour Design").first()).toBeVisible();
  await expect(anon.getByText("ABN 51 824 753 556")).toBeVisible();
  await expect(anon.getByRole("heading", { name: "How to pay" })).toBeVisible();
  await expect(anon.getByText("062 000")).toBeVisible();
  await expect(anon.getByRole("link", { name: "Download PDF" })).toBeVisible();
  await axe(anon, "public invoice");
  await anon.setViewportSize({ width: 390, height: 844 });
  await noHScroll(anon);
  await anon.goto("/i/aaaaaaaaaaaaaaaaaaaaaaaa");
  await expect(anon.getByText("This link is not valid")).toBeVisible({ timeout: 15_000 });
  await ctx.close();
});

test("quote accepted online, then turned into an invoice; sending from a demo says plainly that no email left", async ({ page, browser }) => {
  await demo(page);
  await settings(page);
  const q = (await (await page.request.post("/api/invoices/docs", { data: { kind: "quote", buyerName: "Ola Park", buyerEmail: "ola@park.au", lines: [{ description: "Website", quantityMilli: 1000, unitCents: 300000 }] } })).json()) as { doc: { id: string } };
  const issued = ((await (await page.request.post(`/api/invoices/docs/${q.doc.id}/issue`, { data: {} })).json()) as { doc: { number: string; viewUrl: string } }).doc;
  const ctx = await browser.newContext();
  const anon = await ctx.newPage();
  await anon.goto(new URL(issued.viewUrl).pathname);
  await anon.getByRole("button", { name: "Accept quote" }).click();
  await expect(anon.getByText("You accepted this quote")).toBeVisible();
  await ctx.close();
  await page.goto(`/app/contacts/invoices/${q.doc.id}`);
  await expect(page.getByText("Accepted").first()).toBeVisible();
  await page.getByRole("button", { name: "Send again" }).or(page.getByRole("button", { name: "Send" })).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/could not be sent/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Make invoice" }).click();
  await expect(page.getByRole("heading", { name: "New invoice" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Ola Park");
});

test("shots: list, editor, issued, items, reports and the public view at 1280 and 390, light, dark and Forest", async ({ page, browser }) => {
  test.skip(!DIR, "SHOTS_DIR not set");
  test.setTimeout(300_000);
  await demo(page);
  await settings(page);
  const inv = await issuedInvoice(page, "Harbour Supplies with a rather long trading name for wrapping");
  await issuedInvoice(page, "Bob Builder");
  await page.request.post("/api/invoices/items", { data: { name: "Logo design", description: "Three concepts and two rounds of changes", unitCents: 120000 } });
  const draft = (await (await page.request.post("/api/invoices/docs", { data: { kind: "invoice", buyerName: "Ola Park", lines: [{ description: "Website build", quantityMilli: 1000, unitCents: 300000 }] } })).json()) as { doc: { id: string } };
  const pages: [string, string][] = [["list", "/app/contacts/invoices"], ["editor", `/app/contacts/invoices/${draft.doc.id}`], ["issued", `/app/contacts/invoices/${inv.id}`], ["items", "/app/contacts/invoices?tab=items"], ["reports", "/app/contacts/invoices?tab=reports"], ["public", new URL(inv.viewUrl).pathname]];
  const run = async (theme: string) => {
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const [name, url] of pages) {
        await page.goto(url);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        await noHScroll(page);
        await shot(page, `${name}-${w}-${theme}`, w === 1280);
        await axe(page, `${name} ${w} ${theme}`);
      }
    }
  };
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await run(scheme); }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  await run("forest");
  void browser;
});

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * R106 expenses and receipts (EXPENSES_R106=on, EXPENSES_FAKE_READ=1 in the e2e server: a receipt's own text is read,
 * no engine). Flows: empty state, a wrong file refused, add a receipt and see its fields filled, edit and submit,
 * approve, send back with a reason, re bill onto an invoice draft, split, CSV export, subscriptions, settings with the
 * receipts address. Members vs approvers vs admins are covered in tests/expenses-r106.test.ts (a demo workspace has one
 * person). SHOTS_DIR writes shots at 1280 and 390, light, dark and Forest; axe runs on every screen.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.206.${test.info().workerIndex % 200}.${++visitor}`;
const RECEIPT = "Officeworks Pty Ltd\nTAX INVOICE\nABN 51 824 753 556\nDate 03/10/2026\nPrinter paper 2 boxes\nTotal $132.00\nGST included $12.00\n";
const URL = "/app/contacts/invoices?tab=expenses";

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
const seen = (page: Page, text: string | RegExp) => page.getByText(text).and(page.locator(":visible")).first();
const file = (text: string, name = "receipt.pdf", mimeType = "application/pdf") => ({ name, mimeType, buffer: Buffer.from(text) });
async function addReceipt(page: Page, text = RECEIPT) {
  await page.locator('input[type="file"][multiple]').setInputFiles(file(text));
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Supplier", { exact: true })).toHaveValue(/Officeworks|Bunnings|Cafe/, { timeout: 15_000 });
  return dialog;
}
async function apiExpense(page: Page, patch: Record<string, unknown>) {
  const e = (await (await page.request.post("/api/expenses", { data: {} })).json()) as { expense: { id: string } };
  const r = await page.request.patch(`/api/expenses/${e.expense.id}`, { data: patch });
  expect(r.status()).toBe(200);
  return e.expense.id;
}

test("first time: empty state, the tab sits beside Bills, a wrong file is refused in plain words", async ({ page }) => {
  await demo(page);
  await page.goto("/app/contacts/invoices");
  await expect(page.getByRole("tab", { name: "Expenses" })).toBeVisible();
  await page.getByRole("tab", { name: "Expenses" }).click();
  await expect(page).toHaveURL(/tab=expenses/);
  await expect(page.getByText("No expenses yet")).toBeVisible();
  await axe(page, "empty");
  await page.locator('input[type="file"][multiple]').setInputFiles(file("<b>not a receipt</b>", "page.html", "text/html"));
  await expect(page.getByText("Add a photo or a PDF of the receipt.")).toBeVisible();
  await expect(page.getByText("No expenses yet")).toBeVisible();
});

test("add a receipt: fields are read, edited, submitted and approved", async ({ page }) => {
  await demo(page);
  await page.goto(URL);
  const dialog = await addReceipt(page);
  await expect(dialog.getByLabel("Supplier ABN")).toHaveValue("51 824 753 556");
  await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue("03/10/2026");
  await expect(dialog.getByLabel("Total including GST")).toHaveValue("132.00");
  await expect(dialog.getByLabel("GST", { exact: true })).toHaveValue("12.00");
  await expect(dialog.getByRole("switch", { name: "GST can be claimed" })).toBeChecked();
  await axe(page, "dialog");
  // Over $82.50 without an ABN: warned, and GST cannot be claimed.
  await dialog.getByLabel("Supplier ABN").fill("");
  await expect(dialog.getByText(/need a tax invoice that shows the supplier ABN/)).toBeVisible();
  await expect(dialog.getByRole("switch", { name: "GST can be claimed" })).toBeDisabled();
  await dialog.getByLabel("Supplier ABN").fill("51 824 753 556");
  await dialog.getByLabel("Note").fill("Paper for the client pack");
  await dialog.getByRole("button", { name: "Submit for approval" }).click();
  await expect(dialog.getByText("Waiting for approval").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog.getByText("Approved", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Officeworks Pty Ltd" }).first()).toBeVisible();
});

test("send back needs a reason; a split must add up; re bill onto an invoice draft", async ({ page }) => {
  await demo(page);
  const id = await apiExpense(page, { supplier: "Qantas", spentOn: "2026-10-10", totalCents: 33000, gstCents: 3000, category: "Travel" });
  const draft = (await (await page.request.post("/api/invoices/docs", { data: { kind: "invoice", buyerName: "Ola Park", lines: [{ description: "Website build", quantityMilli: 1000, unitCents: 300000 }] } })).json()) as { doc: { id: string } };
  await page.goto(URL);
  await page.getByRole("button", { name: "Qantas" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Split across categories" }).click();
  await dialog.getByLabel("Part 1 amount").fill("200.00");
  await expect(dialog.getByText("$130.00 left to split")).toBeVisible();
  await dialog.getByLabel("Part 2 category").selectOption("Meals");
  await dialog.getByLabel("Part 2 amount").fill("130.00");
  await expect(dialog.getByText("Adds up to the total")).toBeVisible();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await dialog.getByLabel("Invoice draft").selectOption(draft.doc.id);
  await dialog.getByRole("button", { name: "Add to invoice" }).click();
  await expect(dialog.getByRole("link", { name: "Open the invoice" })).toBeVisible();
  const doc = (await (await page.request.get(`/api/invoices/docs/${draft.doc.id}`)).json()) as { doc: { lines: { description: string; unitCents: number }[] } };
  expect(doc.doc.lines[1]).toMatchObject({ description: "Re billed: Qantas, 10/10/2026", unitCents: 30000 });
  await dialog.getByRole("button", { name: "Submit for approval" }).click();
  await dialog.getByRole("button", { name: "Send back" }).click();
  await expect(dialog.getByRole("button", { name: "Send back" }).last()).toBeDisabled();
  await dialog.getByLabel("Why are you sending it back?").fill("Add the client name");
  await dialog.getByRole("button", { name: "Send back" }).last().click();
  await expect(dialog.getByText("Add the client name")).toBeVisible();
  expect((await (await page.request.get(`/api/expenses/${id}`)).json()).expense.status).toBe("rejected");
});

test("export CSV, subscriptions and settings with the receipts address", async ({ page }) => {
  await demo(page);
  for (const d of ["2026-08-02", "2026-09-02", "2026-10-02"]) await apiExpense(page, { supplier: "Netflix", spentOn: d, totalCents: 2299, category: "Software" });
  await page.goto(URL);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export CSV" }).click()]);
  const text = await (await dl.createReadStream()).toArray().then((b) => Buffer.concat(b as Buffer[]).toString("utf8"));
  expect(text).toContain("Supplier ABN");
  expect(text.match(/Netflix/g)?.length).toBe(3);
  await page.getByRole("button", { name: "Subscriptions" }).click();
  await expect(page.getByText("Looks like it repeats")).toBeVisible();
  await expect(page.getByText("Next 02/11/2026")).toBeVisible();
  await axe(page, "subscriptions");
  await page.getByRole("button", { name: "Expense settings" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Receipts address" })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Approvers" })).toBeVisible();
  await axe(page, "settings");
});

test("long names and search, at 390 wide with no sideways scroll", async ({ page }) => {
  await demo(page);
  await apiExpense(page, { supplier: "Harbour Supplies with a rather long trading name that keeps going for wrapping", spentOn: "2026-10-01", totalCents: 12345, category: "Office supplies" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(URL);
  await expect(seen(page, /Harbour Supplies/)).toBeVisible();
  await noHScroll(page);
  await page.getByLabel("Search expenses").fill("x".repeat(60));
  await expect(page.getByText("Nothing matches. Try another filter or search.")).toBeVisible();
  await axe(page, "phone");
});

test("shots: list, dialog, subscriptions at 1280 and 390, light, dark and Forest", async ({ page }) => {
  test.skip(!DIR, "SHOTS_DIR not set");
  test.setTimeout(300_000);
  await demo(page);
  await apiExpense(page, { supplier: "Qantas", spentOn: "2026-10-10", totalCents: 33000, gstCents: 3000, category: "Travel", supplierAbn: "51 824 753 556" });
  await apiExpense(page, { supplier: "Corner Cafe", spentOn: "2026-10-12", totalCents: 2200, gstCents: 200, category: "Meals" });
  const big = await apiExpense(page, { supplier: "Harbour Supplies", spentOn: "2026-10-14", totalCents: 18000, gstCents: 1636, category: "Office supplies", note: "Desk chairs" });
  for (const d of ["2026-08-02", "2026-09-02"]) await apiExpense(page, { supplier: "Netflix", spentOn: d, totalCents: 2299, category: "Software" });
  const run = async (theme: string) => {
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(URL);
      await expect(seen(page, "Qantas")).toBeVisible();
      await noHScroll(page);
      await shot(page, `list-${w}-${theme}`, w === 1280);
      await axe(page, `list ${w} ${theme}`);
      await seen(page, "Harbour Supplies").click();
      await expect(page.getByRole("dialog").getByText(/need a tax invoice/)).toBeVisible();
      await shot(page, `dialog-${w}-${theme}`);
      await axe(page, `dialog ${w} ${theme}`);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Subscriptions" }).click();
      await expect(seen(page, "Netflix")).toBeVisible();
      await shot(page, `subs-${w}-${theme}`);
    }
  };
  void big;
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await run(scheme); }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.waitForTimeout(800);
  await run("forest");
});

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * R125 tables (TABLES_R125=on in the e2e server). Flows: Docs > New table from a template; grid typing, paste and undo;
 * CSV import with the column check, then export; kanban with the phone move control; form view sent and the row seen in
 * the calendar; row sheet comments and history. Axe on every screen, 390 has no sideways scroll on the page itself.
 * Permissions and leaks (guest, portal, excluded workspace, linked rows) are in tests/tables-r125.test.ts.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.225.${test.info().workerIndex % 200}.${++visitor}`;

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
async function shot(page: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
interface Detail { table: { id: string }; fields: { id: string; name: string; type: string; config: { options?: { id: string; label: string }[] } }[]; views: { id: string; name: string; type: string }[] }
async function blank(page: Page, title = "Leads") {
  const r = await page.request.post("/api/tables", { data: { title } });
  expect(r.status()).toBeLessThan(300);
  const id = ((await r.json()) as { table: { id: string } }).table.id;
  return { id, detail: (await (await page.request.get(`/api/tables/${id}`)).json()) as Detail };
}

test("new table from a template in Docs, then type, paste and undo in the grid", async ({ page }) => {
  await demo(page);
  await page.goto("/app/docs");
  await page.getByTestId("new-table").click();
  await expect(page.getByRole("dialog", { name: "New table" })).toBeVisible();
  await axe(page, "new table dialog");
  await shot(page, "new-table-1280");
  await page.getByTestId("table-templates").getByRole("button", { name: /Clients/ }).click();
  await expect(page.getByTestId("table-doc")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("table-grid")).toBeVisible();
  await axe(page, "clients grid");
  await shot(page, "grid-clients-1280");

  const { id } = await blank(page, "Paste test");
  await page.goto(`/app/docs/${id}`);
  await page.getByRole("button", { name: "Add a row" }).click();
  const first = page.locator("#cell-0-0");
  await expect(first).toBeVisible();
  await first.click();
  await page.keyboard.type("Acme");
  await page.keyboard.press("Enter");
  await expect(first).toContainText("Acme");
  // Paste a 2 by 1 block under it: the extra row is added.
  await first.click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "Birch\tTwo\nCedar\tThree");
    document.querySelector('[data-testid="table-grid"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await expect(page.getByTestId("table-grid")).toContainText("Cedar", { timeout: 10_000 });
  await expect(page.getByTestId("table-grid")).toContainText("Birch");
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("table-grid")).not.toContainText("Cedar", { timeout: 10_000 });
  await expect(first).toContainText("Acme");
  await expect(page.getByTestId("table-grid")).not.toContainText("Birch");
});

test("CSV import checks the columns, then export gives the rows back", async ({ page }) => {
  await demo(page);
  await page.goto("/app/docs?new=table");
  await page.getByRole("button", { name: /Import a CSV file/ }).click();
  const csv = "Name,Price,Due,Paid\nRam,$12.50,02/11/2026,yes\n\"Hari, Jr\",3,,no\nSita,oops,,\n";
  await page.getByTestId("csv-file").setInputFiles({ name: "Suppliers.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  // One bad price keeps the guess at text; the person picks Currency and sees what did not fit.
  await expect(page.getByRole("combobox", { name: "Type for Name" })).toHaveValue("text");
  await page.getByRole("combobox", { name: "Type for Price" }).selectOption("currency");
  await page.getByRole("combobox", { name: "Type for Due" }).selectOption("date");
  await page.getByRole("combobox", { name: "Type for Paid" }).selectOption("checkbox");
  await axe(page, "csv check");
  await shot(page, "csv-check-1280");
  await page.getByTestId("csv-import-go").click();
  await expect(page.getByTestId("csv-import-result")).toContainText("3");
  await expect(page.getByTestId("csv-import-result")).toContainText("did not fit");
  await page.getByRole("button", { name: "Open the table" }).click();
  await expect(page.getByTestId("table-grid")).toContainText("Hari, Jr");
  await expect(page.getByTestId("table-grid")).toContainText("$12.50");
  const href = await page.getByTestId("export-csv").getAttribute("href");
  const out = await (await page.request.get(href!)).text();
  expect(out).toContain("Name,Price,Due,Paid");
  expect(out).toContain('"Hari, Jr"');
  await page.getByRole("searchbox", { name: "Search this table" }).or(page.getByRole("textbox", { name: "Search this table" })).fill("sita");
  await expect(page.getByTestId("table-grid")).not.toContainText("Ram", { timeout: 10_000 });
  await expect(page.getByTestId("table-grid")).toContainText("Sita");
});

test("kanban moves a card, and at 390 the move control and the grid fit", async ({ page }) => {
  await demo(page);
  const { id, detail } = await blank(page, "Board");
  const status = detail.fields.find((f) => f.type === "select")!;
  const name = detail.fields[0];
  await page.request.post(`/api/tables/${id}/rows`, { data: { rows: [{ [name.id]: "Fix the gate" }] } });
  await page.request.post(`/api/tables/${id}/views`, { data: { name: "Board", type: "kanban", config: { by: status.id } } });
  await page.goto(`/app/docs/${id}`);
  await page.getByRole("tab", { name: "Board" }).click();
  await expect(page.getByTestId("kanban-card")).toContainText("Fix the gate");
  await axe(page, "kanban");
  await shot(page, "kanban-1280");
  await page.setViewportSize({ width: 390, height: 844 });
  const target = status.config.options![1];
  await page.getByTestId("kanban-card").getByRole("combobox", { name: "Move to" }).selectOption(target.id);
  await expect(page.getByTestId(`kanban-col-${target.label}`).getByTestId("kanban-card")).toContainText("Fix the gate", { timeout: 10_000 });
  await noHScroll(page);
  await shot(page, "kanban-390");
  await page.getByRole("tab", { name: "Grid" }).first().click();
  await expect(page.getByTestId("table-grid")).toBeVisible();
  await noHScroll(page);
  await axe(page, "grid 390");
  await shot(page, "grid-390");
});

test("a form view adds a row that the calendar shows", async ({ page }) => {
  await demo(page);
  const { id, detail } = await blank(page, "Visits");
  const name = detail.fields[0];
  const f = await (await page.request.post(`/api/tables/${id}/fields`, { data: { name: "Visit date", type: "date" } })).json() as { field: { id: string } };
  await page.request.post(`/api/tables/${id}/views`, { data: { name: "Booking form", type: "form", config: { formFields: [name.id, f.field.id], formTitle: "Book a visit" } } });
  await page.request.post(`/api/tables/${id}/views`, { data: { name: "Month", type: "calendar", config: { by: f.field.id } } });
  await page.goto(`/app/docs/${id}`);
  await page.getByRole("tab", { name: "Booking form" }).click();
  await expect(page.getByTestId("table-form")).toContainText("Book a visit");
  await axe(page, "form");
  const today = new Date();
  const dmy = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}/${today.getFullYear()}`;
  await page.getByLabel(name.name, { exact: true }).fill("Mrs Lee");
  await page.getByLabel("Visit date").fill(dmy);
  await page.getByTestId("form-submit").click();
  await expect(page.getByTestId("table-form").getByRole("status")).toContainText("your answer is in");
  await shot(page, "form-sent-1280");
  await page.getByRole("tab", { name: "Month" }).click();
  await expect(page.getByTestId("calendar-item").filter({ hasText: "Mrs Lee" }).first()).toBeVisible({ timeout: 10_000 });
  await axe(page, "calendar");
  await shot(page, "calendar-1280");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("calendar-item").filter({ hasText: "Mrs Lee" }).last()).toBeVisible();
  await noHScroll(page);
  await shot(page, "calendar-390");
});

test("row sheet: edit a field, comment, see the history, Escape closes", async ({ page }) => {
  await demo(page);
  const { id, detail } = await blank(page, "Sheet");
  const name = detail.fields[0];
  await page.request.post(`/api/tables/${id}/rows`, { data: { rows: [{ [name.id]: "Ocean View" }] } });
  await page.goto(`/app/docs/${id}`);
  await page.getByRole("button", { name: "Open row 1" }).click();
  const sheet = page.getByTestId("row-sheet");
  await expect(sheet).toBeVisible();
  await axe(page, "row sheet");
  const input = sheet.getByLabel(name.name, { exact: true });
  await input.fill("Ocean View Cafe");
  await input.blur();
  await expect(page.locator("#cell-0-0")).toContainText("Ocean View Cafe", { timeout: 10_000 });
  await sheet.getByRole("tab", { name: "Comments" }).click();
  await sheet.getByLabel("Add a comment").fill("Call them on Monday");
  await sheet.getByRole("button", { name: "Post" }).click();
  await expect(sheet.getByTestId("row-comments")).toContainText("Call them on Monday");
  await sheet.getByRole("tab", { name: "History" }).click();
  await expect(sheet.getByTestId("row-history")).toContainText("Ocean View Cafe");
  await shot(page, "row-sheet-1280");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open row 1" }).click();
  await noHScroll(page);
  await axe(page, "row sheet 390");
  await shot(page, "row-sheet-390");
});

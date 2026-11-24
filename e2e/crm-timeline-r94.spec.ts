import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * R94 CRM timeline (CRM_TIMELINE=on in the e2e server): log a note and a call, filter, next step, delete with undo,
 * company by hand with its own timeline, CSV import with dedupe and a saved segment, deal chance and forecast, the
 * error state. SHOTS_DIR writes shots at 1280 and 390, light, dark and Forest, and runs axe.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.194.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string, full = false) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: full });
}
async function firstContact(page: Page) {
  await page.goto("/app/contacts");
  await expect(page.getByTestId("contact-list")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("contact-list").locator("a").first().click();
  await expect(page.getByTestId("crm-timeline")).toBeVisible({ timeout: 20_000 });
  return page.url();
}
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

test("contact timeline: log a note and a call, filter, set a next step, delete with undo", async ({ page }) => {
  await demo(page);
  await firstContact(page);
  const composer = page.getByTestId("crm-composer");
  await composer.getByRole("textbox").fill("Asked for the spring price list");
  await page.getByTestId("crm-save").click();
  await expect(page.getByTestId("crm-entry").filter({ hasText: "Asked for the spring price list" })).toBeVisible();
  await composer.getByRole("tab", { name: "Call" }).click();
  await composer.getByLabel("Call outcome").selectOption("voicemail");
  await composer.getByLabel("Minutes").fill("3");
  await page.getByTestId("crm-save").click();
  await expect(page.getByTestId("crm-entry").filter({ hasText: "Left a voicemail" })).toBeVisible();
  // Filter to calls only.
  await page.getByRole("tab", { name: "Calls", exact: true }).click();
  await expect(page.getByTestId("crm-entry")).toHaveCount(1);
  await expect(page.getByTestId("crm-entry").first()).toContainText("3 min");
  await page.getByRole("tab", { name: "All", exact: true }).click();
  // Next step.
  await page.getByTestId("set-next-step").or(page.getByTestId("next-step").getByRole("button", { name: "New step" })).click();
  await page.getByLabel("What happens next").fill("Send the spring quote");
  // The card shows the soonest open step, so date this one before any demo task.
  await page.getByLabel("Due").fill("2026-01-02");
  await page.getByRole("button", { name: "Set next step" }).click();
  await expect(page.getByTestId("next-step")).toContainText("Send the spring quote");
  // Delete the note, then undo.
  const note = page.getByTestId("crm-entry").filter({ hasText: "Asked for the spring price list" });
  await note.hover();
  await note.getByRole("button", { name: "Delete note" }).click();
  await expect(note).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("crm-entry").filter({ hasText: "Asked for the spring price list" })).toBeVisible();
});

test("timeline error shows plain words and Try again works", async ({ page }) => {
  await demo(page);
  let fail = true;
  await page.route("**/api/crm/timeline**", (r) => (fail ? r.fulfill({ status: 500, body: "{}" }) : r.continue()));
  await page.goto("/app/contacts");
  await page.getByTestId("contact-list").locator("a").first().click();
  await expect(page.getByTestId("load-error-inline")).toBeVisible({ timeout: 20_000 });
  fail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("crm-composer")).toBeVisible();
  await expect(page.getByTestId("load-error-inline")).toHaveCount(0);
});

test("company by hand: its own page, timeline and a contact joined to it", async ({ page }) => {
  await demo(page);
  await page.goto("/app/contacts?tab=companies");
  await page.getByTestId("new-company").click();
  await page.getByLabel("Name").fill("Bondi Beans");
  await page.getByLabel("Website").fill("https://www.bondibeans-e2e.com.au/");
  await page.getByRole("button", { name: "Add company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText("Bondi Beans", { timeout: 20_000 });
  await expect(page.getByText("bondibeans-e2e.com.au")).toBeVisible();
  await page.getByTestId("crm-composer").getByRole("textbox").fill("Head office moved to Bondi Junction");
  await page.getByTestId("crm-save").click();
  await expect(page.getByTestId("crm-entry").filter({ hasText: "Head office moved" })).toBeVisible();
  const companyUrl = page.url();
  // Join a contact to it from the contact page.
  // Each demo is its own workspace, so pick a contact here.
  await firstContact(page);
  await page.getByTestId("company-picker").selectOption({ label: "Bondi Beans" });
  await expect(page.getByRole("link", { name: "Bondi Beans" })).toBeVisible();
  await page.goto(companyUrl);
  await expect(page.getByRole("complementary").getByRole("link").filter({ hasText: /./ }).first()).toBeVisible();
});

const CSV = "First Name,Last Name,E-mail Address,Organisation\nIvy,Nguyen,ivy@e2e-import.io,Import Labs\nJon,Park,jon@e2e-import.io,Import Labs\nBad,Row,not-an-email,\nIvy,Again,IVY@e2e-import.io,\n";

test("CSV import: preview counts, dedupe, import, then a saved segment of imported people", async ({ page }) => {
  await demo(page);
  await page.goto("/app/contacts");
  await page.getByTestId("import-contacts").click();
  await page.getByTestId("import-file").setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  const summary = page.getByTestId("import-summary");
  await expect(summary).toContainText("2 ready to import");
  await expect(summary).toContainText("1 repeated in the file");
  await expect(summary).toContainText("line 4");
  await page.getByTestId("import-run").click();
  await expect(page.getByTestId("import-result")).toContainText("2 added");
  await page.getByRole("dialog", { name: "Import contacts" }).getByRole("button", { name: "Done" }).click();
  // Import the same file again: nobody is added twice.
  await page.getByTestId("import-contacts").click();
  await page.getByTestId("import-file").setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await expect(page.getByTestId("import-summary")).toContainText("2 already in your contacts");
  await page.getByTestId("import-run").click();
  await expect(page.getByTestId("import-result")).toContainText("0 added");
  await page.getByRole("dialog", { name: "Import contacts" }).getByRole("button", { name: "Done" }).click();
  // Segment of imported people.
  await page.getByTestId("filters-toggle").click();
  await page.getByTestId("filters-panel").getByLabel("Added").selectOption("import");
  await expect(page.getByTestId("contact-list").locator("a")).toHaveCount(2);
  await page.getByTestId("save-segment").click();
  await page.getByLabel("Name").fill("From the import");
  await page.getByRole("button", { name: "Save segment" }).click();
  await expect(page.getByTestId("segment-bar").getByRole("button", { name: "From the import", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("segment-bar").getByRole("button", { name: "Everyone" }).click();
  await page.getByTestId("segment-bar").getByRole("button", { name: "From the import", exact: true }).click();
  await expect(page.getByTestId("contact-list")).toContainText("ivy@e2e-import.io");
});

test("deals: forecast shows, a deal's chance can be set by hand", async ({ page }) => {
  await demo(page);
  await page.goto("/app/deals");
  const board = page.getByTestId("deals-board");
  if (!(await board.isVisible({ timeout: 15_000 }).catch(() => false))) {
    await page.getByRole("button", { name: "New deal" }).first().click();
    await page.getByLabel("Name").fill("E2E fit out");
    await page.getByLabel("Value (A$, ex GST)").fill("12000");
    await page.getByRole("button", { name: "Add deal" }).click();
  }
  await expect(page.getByTestId("forecast")).toBeVisible({ timeout: 20_000 });
  const card = page.getByTestId("deal-card").filter({ has: page.getByTestId("deal-chance") }).first();
  const title = (await card.getByTestId("deal-open").textContent()) ?? "";
  await card.getByTestId("deal-open").click();
  await page.getByTestId("deal-probability").fill("85");
  await page.getByTestId("deal-save").click();
  await expect(page.getByTestId("deal-card").filter({ hasText: title }).getByTestId("deal-chance")).toContainText("85% chance");
});

test("shots and axe", async ({ page }) => {
  test.skip(!DIR, "screenshots only with SHOTS_DIR");
  test.setTimeout(300_000);
  await demo(page);
  const contactUrl = await firstContact(page);
  await page.goto("/app/contacts?tab=companies");
  await page.getByTestId("new-company").click();
  await page.getByLabel("Name").fill("Shots Company");
  await page.getByRole("button", { name: "Add company" }).click();
  await expect(page.getByTestId("company-name")).toBeVisible({ timeout: 20_000 });
  const companyUrl = page.url();
  await page.getByTestId("crm-composer").getByRole("textbox").fill("A long note to check wrapping on phones. ".repeat(6));
  await page.getByTestId("crm-save").click();
  const pages: [string, string, string][] = [["contact", contactUrl, "crm-timeline"], ["company", companyUrl, "crm-timeline"], ["contacts", "/app/contacts", "segment-bar"], ["deals", "/app/deals", "forecast"]];
  const run = async (theme: string) => {
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const [name, url, id] of pages) {
        await page.goto(url);
        await expect(page.getByTestId(id)).toBeVisible({ timeout: 20_000 });
        if (name === "contacts") await page.getByTestId("filters-toggle").click();
        await noHScroll(page);
        await shot(page, `${name}-${w}-${theme}`, true);
        await axe(page, `${name} ${w} ${theme}`);
      }
      await page.goto("/app/contacts");
      await page.getByTestId("import-contacts").click();
      await page.getByTestId("import-file").setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
      await expect(page.getByTestId("import-summary")).toBeVisible();
      await shot(page, `import-${w}-${theme}`);
      await axe(page, `import ${w} ${theme}`);
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
});

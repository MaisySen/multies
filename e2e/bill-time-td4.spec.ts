import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * TD4 time to invoice (BILL_TD4=on in the e2e server; E2E_BILL_TD4=off runs the flag off check). Flows: a billing run
 * by keyboard (rates, client, rounding, untick, create draft), the time is then locked and the run listed; the Home
 * card; error with Retry; offline; shots at 1280 and 390 in light, dark and Forest with axe on each. Roles, other
 * workspaces and two runs at once are covered in tests/bill-time-td4.test.ts (a demo workspace has one person).
 */
const OFF = process.env.E2E_BILL_TD4 === "off";
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.214.${test.info().workerIndex % 200}.${++visitor}`;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

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

/** A project with a task, a client contact and three time entries (one not billable). */
async function seed(page: Page, name = "Harbour site") {
  const post = async (path: string, data: unknown) => { const r = await page.request.post(path, { data }); expect(r.status(), path).toBeLessThan(300); return r.json(); };
  const proj = (await post("/api/projects", { name })).project as { id: string };
  const task = (await post("/api/tasks", { projectId: proj.id, title: "Landing page" })).task as { id: string };
  const contact = (await post("/api/contacts", { email: `accounts.${Date.now()}@harbour.example`, name: "Harbour Traders" })).contact as { id: string };
  const a = (await post("/api/time", { taskId: task.id, minutes: 60, date: daysAgo(2), note: "Hero section" })).entry as { id: string };
  const b = (await post("/api/time", { taskId: task.id, minutes: 7, date: daysAgo(1), note: "Fix a typo" })).entry as { id: string };
  await post("/api/time", { taskId: task.id, minutes: 20, date: daysAgo(1), note: "Internal call", billable: false });
  return { proj, task, contact, a, b };
}

test.describe("flag off", () => {
  test.skip(!OFF, "flag on run");
  test("no tab, no card, the API is not there", async ({ page }) => {
    await demo(page);
    await page.goto("/app/contacts/invoices");
    await expect(page.getByRole("tab", { name: "Invoices" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Bill time" })).toHaveCount(0);
    expect((await page.request.get("/api/bill-time/summary")).status()).toBe(404);
    const hw = await (await page.request.get("/api/home-widgets")).json() as { available: string[] };
    expect(hw.available).not.toContain("billing");
  });
});

test.describe("bill time", () => {
  test.skip(OFF, "flag off run");

  test("billing run by keyboard: rate, client, rounding, untick, draft invoice, time locked", async ({ page }) => {
    await demo(page);
    const s = await seed(page);
    await page.goto(`/app/contacts/invoices?tab=time&project=${s.proj.id}`);
    await expect(page.getByRole("tab", { name: "Bill time" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("bill-line")).toHaveCount(1);
    await expect(page.getByText("Internal call")).toHaveCount(0); // not billable
    await expect(page.getByTestId("bill-total")).toContainText("Pick the client to bill.");
    await axe(page, "first look");

    // Rates by keyboard.
    await page.getByRole("button", { name: "Rates" }).focus();
    await page.keyboard.press("Enter");
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Project rate").fill("150");
    await axe(page, "rates");
    await dlg.getByRole("button", { name: "Save rates" }).focus();
    await page.keyboard.press("Enter");
    await expect(dlg).toHaveCount(0);

    // Client.
    await page.getByLabel("Find a contact").fill("Harbour");
    await page.getByRole("option").filter({ hasText: "Harbour Traders" }).first().getByRole("button").click();
    await expect(page.getByTestId("bill-to")).toHaveText("Harbour Traders");

    // Rounding up to 15 minutes: 60 + 7 becomes 60 + 15.
    await page.getByLabel("Round each entry up to").selectOption("15");
    await expect(page.getByTestId("bill-total")).toContainText("1.25 h");
    await expect(page.getByTestId("bill-total")).toContainText("187.50");

    // Untick all by keyboard, then tick again.
    await page.getByLabel("Tick all", { exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("bill-total")).toContainText("Tick at least one entry.");
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Create draft invoice" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Draft invoice made. Its time is now locked.")).toBeVisible();
    await expect(page.getByText("No time waiting to be billed")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Past billing runs" })).toBeVisible();
    await axe(page, "after run");

    // Locked: the API refuses edits; the Time page would show Billed.
    const r = await page.request.patch(`/api/time/${s.a.id}`, { data: { minutes: 90 } });
    expect(r.status()).toBe(409);
    const runs = await (await page.request.get("/api/bill-time/runs")).json() as { runs: { id: string; docId: string; amountCents: number }[] };
    expect(runs.runs[0].amountCents).toBe(18750);
    const csv = await page.request.get(`/api/bill-time/runs/${runs.runs[0].id}/export.csv`);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain("Hero section");

    // Delete the draft: the time comes back.
    expect((await page.request.delete(`/api/invoices/docs/${runs.runs[0].docId}`)).status()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("bill-line")).toHaveCount(1);
    await expect(page.getByText("Draft deleted, time released").first()).toBeVisible();
  });

  test("Home card shows hours still to bill and opens a prefilled run", async ({ page }) => {
    await demo(page);
    const s = await seed(page, "Card project");
    await page.request.put("/api/bill-time/setup", { data: { projectId: s.proj.id, rateCents: 10000, contactId: s.contact.id } });
    await page.goto("/app");
    await page.getByRole("region", { name: "Time to bill" }).scrollIntoViewIfNeeded(); // widgets below the fold read when near
    const card = page.getByTestId("bill-widget");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText("Harbour Traders").first()).toBeVisible();
    await axe(page, "home");
    await card.getByRole("link").filter({ hasText: "Harbour Traders" }).first().click();
    await expect(page).toHaveURL(/tab=time&project=/);
    await expect(page.getByTestId("bill-to")).toHaveText("Harbour Traders");
  });

  test("error with Retry, and offline", async ({ page, context }) => {
    await demo(page);
    await seed(page, "Error project");
    let fail = true;
    await page.route("**/api/bill-time/preview**", (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "error", message: "Boom" } }) }) : route.continue()));
    await page.goto("/app/contacts/invoices?tab=time");
    const retry = page.getByRole("button", { name: /Retry|Try again/ }).first();
    await expect(retry).toBeVisible({ timeout: 20_000 });
    await axe(page, "error");
    fail = false;
    await retry.click();
    await expect(page.getByRole("button", { name: "Rates" })).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText("You are offline. Billing runs need a connection.")).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText("You are offline. Billing runs need a connection.")).toHaveCount(0);
  });

  test("shots at 1280 and 390, light, dark and Forest", async ({ page }) => {
    test.setTimeout(300_000);
    await demo(page);
    const s = await seed(page, "Shots project");
    await page.request.put("/api/bill-time/setup", { data: { projectId: s.proj.id, rateCents: 15000, contactId: s.contact.id, rounding: 6 } });
    const run = async (theme: string) => {
      for (const [w, h] of [[1280, 860], [390, 844]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(`/app/contacts/invoices?tab=time&project=${s.proj.id}`);
        await expect(page.getByTestId("bill-line")).toHaveCount(1);
        await noHScroll(page);
        await shot(page, `run-${w}-${theme}`, w === 1280);
        await axe(page, `run ${w} ${theme}`);
        await page.getByRole("button", { name: "Rates" }).click();
        await shot(page, `rates-${w}-${theme}`);
        await axe(page, `rates ${w} ${theme}`);
        await page.keyboard.press("Escape");
        await page.goto("/app");
        await page.getByRole("region", { name: "Time to bill" }).scrollIntoViewIfNeeded();
        await expect(page.getByTestId("bill-widget")).toBeVisible({ timeout: 20_000 });
        await page.getByTestId("bill-widget").scrollIntoViewIfNeeded();
        await noHScroll(page);
        await shot(page, `home-${w}-${theme}`);
      }
    };
    for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await run(scheme); }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto("/app/settings/branding");
    await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Forest", exact: true }).click();
    await page.waitForTimeout(800);
    await run("forest");
  });
});

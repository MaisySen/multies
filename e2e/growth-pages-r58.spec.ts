import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SWITCH_SOURCES, importPathFor } from "../src/shared/switch-sources";
import { PLANS } from "../src/shared/plans";
import { freeHeadline } from "../src/shared/free-plan";

/**
 * R58 (MB-237): the free plan page and the switch pages. Each page loads with a 200, the sample file downloads
 * with the same bytes as public/samples, and the import button lands on the import screen with the tool picked
 * (through sign up when signed out). Shots at 1280 and 390, light and dark, when SHOTS_DIR is set.
 */
const SHOTS = process.env.SHOTS_DIR;

async function open(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: "networkidle" });
  expect(res?.status(), `${path} status`).toBe(200);
  await expect(page.locator("h1").first()).toBeVisible();
}

async function shots(page: Page, path: string, name: string) {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"] as const) {
    for (const [w, h, kind] of [[1280, 900, "desktop"], [390, 844, "phone"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path, { waitUntil: "networkidle" });
      await page.evaluate(() => { try { localStorage.setItem("multies.cookie-notice", "ok"); } catch { /* private mode */ } });
      await page.reload({ waitUntil: "networkidle" });
      await page.screenshot({ path: `${SHOTS}/${name}-${kind}-${scheme}.png`, fullPage: false, type: "png" });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

test("the free plan page shows the plan's own numbers and one sign up button", async ({ page }) => {
  await open(page, "/startups");
  await expect(page.getByTestId("free-headline")).toHaveText(freeHeadline(PLANS.starter));
  const l = PLANS.starter.limits;
  await expect(page.getByTestId("free-limit-seats")).toContainText(`${l.seats} people`);
  await expect(page.getByTestId("free-limit-dailySends")).toContainText(`${l.dailySends} a day`);
  await expect(page.getByTestId("free-limit-mailboxes")).toContainText(`${l.mailboxes} mailboxes`);
  await expect(page.getByTestId("free-cta")).toHaveAttribute("href", "/signup");
  await expect(page.getByRole("link", { name: "Free for small teams" })).toBeVisible(); // footer
  await shots(page, "/startups", "growth-after-free-plan");
});

test("pricing links to the free plan page and the switch pages", async ({ page }) => {
  await open(page, "/pricing");
  await page.getByRole("link", { name: "What Free includes for small teams" }).click();
  await expect(page).toHaveURL(/\/startups$/);
  await open(page, "/switch");
  for (const s of SWITCH_SOURCES) await expect(page.getByTestId(`switch-link-${s.slug}`)).toBeVisible();
});

test("an unknown tool is a real 404", async ({ page }) => {
  const res = await page.goto("/switch/no-such-tool");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This page bounced." })).toBeVisible();
});

for (const s of SWITCH_SOURCES) {
  test(`switch page for ${s.slug}: loads, the sample downloads, the button goes through sign up to the import`, async ({ page }) => {
    await open(page, `/switch/${s.slug}`);
    await expect(page.locator("h1")).toContainText(s.label);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("switch-sample").click()]);
    const saved = await download.path();
    expect(readFileSync(saved!, "utf8")).toBe(readFileSync(`public${s.sample}`, "utf8"));
    const start = page.getByTestId("switch-start");
    await expect(start).toHaveAttribute("href", `/signup?next=${encodeURIComponent(importPathFor(s.slug))}`);
    await start.click();
    await expect(page).toHaveURL(/\/signup\?next=/);
    expect(new URL(page.url()).searchParams.get("next")).toBe(importPathFor(s.slug));
    await expect(page.locator('a[href^="/login?next="]').first()).toHaveAttribute("href", `/login?next=${encodeURIComponent(importPathFor(s.slug))}`);
  });
}

test("signed in, the button opens the import screen with the tool picked and the sample imports", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.58.${test.info().workerIndex % 200}.7` });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await open(page, "/switch/trello");
  const start = page.getByTestId("switch-start");
  await expect(start).toHaveAttribute("href", importPathFor("trello"));
  await expect(start).toContainText("Import from Trello");
  await start.click();
  await expect(page).toHaveURL(/\/app\/settings\/import\?source=trello$/);
  const wizard = page.getByTestId("move-wizard");
  await expect(wizard).toBeVisible();
  await expect(page.getByTestId("move-source-trello")).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("File to import").setInputFiles("public/samples/trello-board.json");
  await expect(wizard.getByText(/^\d+ tasks?\b.*found\./)).toBeVisible({ timeout: 20_000 });
  await shots(page, "/switch/trello", "growth-after-switch-trello-signed-in");
  await ctx.close();
});

test("shots of a signed out switch page", async ({ page }) => {
  test.skip(!SHOTS, "shots only");
  await shots(page, "/switch/asana", "growth-after-switch-asana");
  await shots(page, "/switch", "growth-after-switch-list");
});

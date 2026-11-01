import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { readFileSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * R111 mail archive and retention (MAIL_ARCHIVE_R111=on). Runs in a demo workspace (sample mail only, no real
 * mailbox). Flows: set a policy with the dry run and turn it off, place and lift a hold, search and export a case,
 * filter the audit log, and the member's read only view. R111_SHOTS=<dir> writes r111-<state>-<1280|390>-<scheme>.png.
 */
const SHOTS = process.env.R111_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function demo(page: Page) {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  await page.goto("/app");
  await expect.poll(async () => ((await (await page.request.get("/api/mailboxes")).json()).mailboxes ?? []).length, { timeout: 20_000 }).toBeGreaterThan(0);
}
async function openPane(page: Page, tab = "") {
  await page.goto(`/app/settings/mail-archive${tab ? `?tab=${tab}` : ""}`);
  await expect(page.getByRole("tablist", { name: "Archive and retention" })).toBeVisible({ timeout: 20_000 });
}
async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(250);
}
async function noSeriousAxe(page: Page) {
  await page.mouse.move(0, 0); // no hover state under the check
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
/** Axe at 1280 and 390 in light and dark, plus shots when asked. */
async function check(page: Page, name: string) {
  for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await noSeriousAxe(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} ${vp} horizontal scroll`).toBeLessThanOrEqual(1);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `r111-${name}-${vp}-${scheme}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
}

test.describe.configure({ mode: "serial" });

test("1. retention: dry run first, turn on, then turn off", async ({ page }) => {
  await demo(page);
  await openPane(page);
  await expect(page.getByText("Keep forever").first()).toBeVisible();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();
  await check(page, "retention-off");
  await page.getByLabel("Keep mail").selectOption("1");
  await page.getByRole("button", { name: "Check what this deletes" }).click();
  const dry = page.getByTestId("retention-dry-run");
  await expect(dry).toContainText("Dry run:");
  await expect(dry).toContainText("Deletion starts");
  await check(page, "retention-dry-run");
  await dry.getByRole("button", { name: "Turn on policy" }).click();
  await expect(page.getByText("Keep for 1 year").first()).toBeVisible();
  await expect(page.getByText(/Deletion starts .* Until then nothing is deleted/)).toBeVisible();
  await check(page, "retention-on");
  await page.getByRole("button", { name: "Turn off" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();
  const audit = await (await page.request.get("/api/org/audit?area=mail_archive")).json();
  expect(audit.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["mail.retention.enabled", "mail.retention.disabled"]));
});

test("2. legal hold: place on a mailbox, see it, lift it", async ({ page }) => {
  await demo(page);
  await openPane(page, "holds");
  await expect(page.getByText("No active holds")).toBeVisible();
  await check(page, "holds-empty");
  await page.getByRole("button", { name: "Place a hold" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: "Place hold" }).isDisabled();
  await dlg.getByLabel("Mailbox").selectOption({ index: 1 });
  await dlg.getByLabel("Name").fill("Supplier dispute 2026 with a very long name that keeps going to test truncation in the list");
  await dlg.getByRole("button", { name: "Place hold" }).click();
  const list = page.getByTestId("holds-active");
  await expect(list).toContainText("Supplier dispute 2026");
  await expect(page.getByRole("tab", { name: /Legal holds\s*1/ })).toBeVisible();
  await check(page, "holds-active");
  // Another hold on the same mailbox is refused with a plain message.
  await page.getByRole("button", { name: "Place a hold" }).click();
  await dlg.getByLabel("Mailbox").selectOption({ index: 1 });
  await dlg.getByLabel("Name").fill("Again");
  await dlg.getByRole("button", { name: "Place hold" }).click();
  await expect(dlg.getByText("This mailbox is already on hold.")).toBeVisible();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await list.getByRole("button", { name: /Lift hold/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Lift hold" }).click();
  await expect(page.getByText("No active holds")).toBeVisible();
  await expect(page.getByText("Lifted holds (1)")).toBeVisible();
});

test("3. search all mail, save a case and export it as mbox in a ZIP", async ({ page }) => {
  await demo(page);
  await openPane(page, "search");
  await expect(page.getByText("No cases yet")).toBeVisible();
  await page.getByLabel("Words").fill("zzzz no such words");
  await page.getByLabel("Words").press("Enter");
  await expect(page.getByText("No mail matches")).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await page.getByRole("form", { name: "Search all mail" }).getByRole("button", { name: "Search", exact: true }).click();
  const results = page.getByTestId("archive-results");
  await expect(results.locator("li").first()).toBeVisible({ timeout: 15_000 });
  await check(page, "search-results");
  await results.getByRole("button", { name: "Save as case and export" }).click();
  await page.getByLabel("Case name").fill("Review November");
  const dl = page.waitForEvent("download");
  await page.getByRole("dialog").getByRole("button", { name: "Save and export" }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/^case-review-november-\d{4}-\d{2}-\d{2}\.zip$/);
  const files = unzipSync(new Uint8Array(readFileSync((await file.path())!)));
  expect(Object.keys(files).sort()).toEqual(["README.txt", "mail.mbox", "manifest.json", "messages.csv"]);
  expect(strFromU8(files["mail.mbox"]!).startsWith("From ")).toBe(true);
  expect(JSON.parse(strFromU8(files["manifest.json"]!)).exported).toBeGreaterThan(0);
  await expect(page.getByTestId("cases-list")).toContainText("Review November");
  await check(page, "search-cases");
});

test("4. audit log filters by area", async ({ page }) => {
  await demo(page);
  await page.request.post("/api/mail-archive/search", { data: { filters: { q: "hello" } }, headers: { origin: new URL(page.url()).origin } });
  await page.goto("/app/activity?tab=audit");
  await page.getByLabel("Area").selectOption("mail_archive");
  await expect(page.getByText(/searched|mail\.archive/).first()).toBeVisible({ timeout: 15_000 });
  await check(page, "audit-filter");
  await page.getByLabel("From date").fill("2035-01-01");
  await expect(page.getByText("Nothing matches these filters")).toBeVisible();
});

async function memberPage(browser: Browser, owner: Page) {
  const origin = new URL(owner.url()).origin;
  const email = `r111m${Date.now()}@example.com`;
  const inv = await owner.request.post("/api/team/invites", { data: { email, role: "member" }, headers: { origin } });
  expect(inv.ok()).toBe(true);
  const link = (await inv.json()).link as string;
  const ctx = await browser.newContext({ baseURL: origin });
  const page = await ctx.newPage();
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Mia Member", email, password: "a-strong-password" }, headers: { origin } })).ok()).toBe(true);
  await confirmEmail(page.request, email).catch(() => undefined);
  const acc = await page.request.post(`/api/invites/${link.split("/invite/")[1]}/accept`, { headers: { origin } });
  await page.request.post("/api/account/onboarding", { data: { name: "Mia Member", timezone: "Australia/Sydney", locale: "en-AU" }, headers: { origin } });
  // A pending invite is joined on first sign in (410 then means it was already used by that sign in).
  const me = await (await page.request.get("/api/account/me")).json();
  return { page, ok: (acc.ok() || acc.status() === 410) && me.organization?.role === "member", status: `${acc.status()} ${me.organization?.role}` };
}

test("5. a member sees a read only notice and cannot open admin parts", async ({ page, browser }) => {
  const email = `r111o${Date.now()}@example.com`;
  await page.goto("/login");
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Olive Owner", email, password: "a-strong-password" } })).status()).toBe(200);
  await page.request.post("/api/account/onboarding", { data: { name: "Olive Owner", timezone: "Australia/Sydney", locale: "en-AU", company: "Owner Co", workspaceTimezone: "Australia/Sydney" } });
  await page.goto("/app/settings/mail-archive");
  await expect(page.getByRole("tablist", { name: "Archive and retention" })).toBeVisible({ timeout: 20_000 });
  const m = await memberPage(browser, page);
  expect(m.ok, `invite accept answered ${m.status}`).toBe(true);
  await m.page.goto("/app/settings/mail-archive");
  const notice = m.page.getByTestId("retention-member-notice");
  await expect(notice).toContainText("Keep forever");
  await expect(notice).toContainText("Workspace owners and admins manage this setting.");
  await expect(m.page.getByRole("tablist", { name: "Archive and retention" })).toHaveCount(0);
  expect((await m.page.request.get("/api/mail-archive/holds")).status()).toBe(403);
  await check(m.page, "member-notice");
  await m.page.context().close();
});

test("6. Forest theme shots", async ({ page }) => {
  test.skip(!SHOTS, "screenshots only with R111_SHOTS");
  await demo(page);
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const tab of ["", "holds", "search"]) {
      await openPane(page, tab);
      if (tab === "search") { await page.getByRole("form", { name: "Search all mail" }).getByRole("button", { name: "Search", exact: true }).click(); await page.getByTestId("archive-results").locator("li").first().waitFor({ timeout: 15_000 }); }
      await noSeriousAxe(page);
      await page.screenshot({ path: join(SHOTS!, `r111-${tab || "retention"}-${vp}-forest.png`), fullPage: true });
    }
  }
});

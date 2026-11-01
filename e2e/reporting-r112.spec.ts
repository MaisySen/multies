import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { confirmEmail } from "./support/confirm-email";

/**
 * R112 anonymous reporting channel and data requests (REPORTING_R112=on). Demo workspace only.
 * Flows: an admin turns the reporting page on; a logged out reporter sends a report, keeps the case number and passphrase,
 * signs back in and reads the handler's reply (internal notes stay hidden); wrong passphrase and empty states; a member sees
 * no reports; a data request is confirmed by email and the admin downloads and deletes. R112_SHOTS=<dir> writes shots.
 */
const SHOTS = process.env.R112_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OUTBOX = ".data/e2e-outbox";

async function demo(page: Page) {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  await page.goto("/app");
  return origin;
}
async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(250);
}
async function noSeriousAxe(page: Page, label: string) {
  await page.mouse.move(0, 0);
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).exclude("[data-sonner-toaster]").analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
/** Axe and no sideways scroll at 1280 and 390 in light and dark, plus shots when asked. */
async function check(page: Page, name: string) {
  for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await noSeriousAxe(page, `${name} ${vp} ${scheme}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} ${vp} horizontal scroll`).toBeLessThanOrEqual(1);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `r112-${name}-${vp}-${scheme}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
}
async function turnOn(page: Page): Promise<string> {
  await page.goto("/app/forms?tab=reports");
  const card = page.getByTestId("report-channel");
  await expect(card).toBeVisible({ timeout: 20_000 });
  const sw = card.getByRole("switch");
  if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
  const link = page.getByTestId("report-link");
  await expect(link).toContainText("/report/");
  return new URL((await link.textContent())!.trim()).pathname;
}
async function visitor(browser: Browser, origin: string, width = 390) {
  const ctx = await browser.newContext({ baseURL: origin, viewport: { width, height: width === 390 ? 844 : 900 } });
  return { ctx, page: await ctx.newPage() };
}
function latestMail(to: string, re: RegExp): string | null {
  try {
    for (const f of readdirSync(OUTBOX).sort().reverse()) {
      const m = JSON.parse(readFileSync(join(OUTBOX, f), "utf8")) as { to: string[]; text: string };
      if (!m.to.some((t) => t.toLowerCase() === to.toLowerCase())) continue;
      const hit = m.text.match(re);
      if (hit) return hit[0];
    }
  } catch { /* no outbox yet */ }
  return null;
}
async function memberPage(browser: Browser, owner: Page) {
  const origin = new URL(owner.url()).origin;
  const email = `r112m${Date.now()}@example.com`;
  const inv = await owner.request.post("/api/team/invites", { data: { email, role: "member" }, headers: { origin } });
  expect(inv.ok()).toBe(true);
  const link = (await inv.json()).link as string;
  const ctx = await browser.newContext({ baseURL: origin });
  const page = await ctx.newPage();
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Mia Member", email, password: "a-strong-password" }, headers: { origin } })).ok()).toBe(true);
  await confirmEmail(page.request, email).catch(() => undefined);
  const acc = await page.request.post(`/api/invites/${link.split("/invite/")[1]}/accept`, { headers: { origin } });
  await page.request.post("/api/account/onboarding", { data: { name: "Mia Member", timezone: "Australia/Sydney", locale: "en-AU" }, headers: { origin } });
  const me = await (await page.request.get("/api/account/me")).json();
  return { page, ok: (acc.ok() || acc.status() === 410) && me.organization?.role === "member", status: `${acc.status()} ${me.organization?.role}` };
}

test("1. reporter sends a report, comes back with the passphrase and reads the handler's reply", async ({ page, browser }) => {
  const origin = await demo(page);
  const path = await turnOn(page);
  await expect(page.getByText("No reports yet")).toBeVisible();
  await check(page, "reports-empty");

  const v = await visitor(browser, origin);
  await v.page.goto(path);
  await expect(v.page).toHaveTitle(/report/i);
  await expect(v.page.getByText("Corporations Act 2001")).toBeVisible();
  await check(v.page, "public-start");
  expect((await v.ctx.cookies()).length).toBe(0);
  await v.page.getByTestId("report-start").click();
  await expect(v.page.getByTestId("report-send")).toBeDisabled();
  await v.page.getByTestId("report-what").fill("The stock count for the loading dock was changed after the audit, twice this month.");
  await check(v.page, "public-write");
  const sent = v.page.waitForResponse((r) => r.url().includes("/api/pub/report/") && r.url().endsWith("/cases"));
  await v.page.getByTestId("report-send").click();
  const res = await sent;
  expect(res.status()).toBe(201);
  expect(res.headers()["set-cookie"]).toBeUndefined();
  const caseNo = (await v.page.getByTestId("receipt-case").textContent())!.trim();
  const pass = (await v.page.getByTestId("receipt-pass").textContent())!.trim();
  expect(caseNo).toMatch(/^RC-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(pass.split("-").length).toBeGreaterThanOrEqual(5);
  await expect(v.page.getByTestId("receipt-done")).toBeDisabled();
  await check(v.page, "public-receipt");
  await v.page.getByTestId("receipt-kept").check();
  await v.page.getByTestId("receipt-done").click();

  // Wrong passphrase: a plain error, nothing shown.
  await v.page.getByTestId("check-case").fill(caseNo);
  await v.page.getByTestId("check-pass").fill("wrong-words-here-and-there");
  await v.page.getByTestId("check-go").click();
  await expect(v.page.getByTestId("check-error")).toBeVisible();
  await check(v.page, "public-check-error");

  // Handler: acknowledge, write an internal note and a reply.
  await page.reload();
  await page.getByTestId("case-row").first().click();
  await expect(page.getByTestId("case-no")).toHaveText(caseNo);
  await page.getByTestId("case-status").selectOption("acknowledged");
  await expect(page.getByTestId("case-view").getByText("Acknowledged").first()).toBeVisible();
  await page.getByTestId("internal-toggle").check();
  await page.getByTestId("handler-reply-text").fill("Internal: check the dock camera roster first.");
  await page.getByTestId("handler-reply-send").click();
  await expect(page.getByText("Internal: check the dock camera roster first.")).toBeVisible();
  await page.getByTestId("internal-toggle").uncheck();
  await page.getByTestId("handler-reply-text").fill("Thank you. We have started looking into this and will update you here.");
  await page.getByTestId("handler-reply-send").click();
  await expect(page.getByText("We have started looking into this")).toBeVisible();
  await check(page, "case-open");

  // Reporter signs in and reads the reply, but never the note.
  await v.page.getByTestId("check-pass").fill(pass);
  await v.page.getByTestId("check-go").click();
  await expect(v.page.getByTestId("reporter-case")).toHaveText(caseNo);
  await expect(v.page.getByTestId("reporter-status")).toHaveText("Acknowledged");
  await expect(v.page.getByText("We have started looking into this")).toBeVisible();
  await expect(v.page.getByText("dock camera roster")).toHaveCount(0);
  await v.page.getByTestId("reply-text").fill("One more thing: it happened on the Friday night shift.");
  await v.page.getByTestId("reply-send").click();
  await expect(v.page.getByText("Friday night shift")).toBeVisible();
  await check(v.page, "public-thread");
  await v.page.getByTestId("reporter-leave").click();
  await expect(v.page.getByTestId("report-start")).toBeVisible();
  expect((await v.ctx.cookies()).length).toBe(0);
  await v.ctx.close();
});

test("2. a member sees no reports and the API says no", async ({ page, browser }) => {
  await demo(page);
  await turnOn(page);
  const m = await memberPage(browser, page);
  expect(m.ok, `invite accept answered ${m.status}`).toBe(true);
  await m.page.goto("/app/forms?tab=reports");
  await expect(m.page.getByRole("tab", { name: "Reports" })).toHaveCount(0);
  expect((await m.page.request.get("/api/reporting/cases?view=all")).status()).toBe(403);
  expect((await m.page.request.get("/api/data-requests")).status()).toBe(403);
  await m.page.goto("/app/settings/data-requests");
  await expect(m.page.getByText("Only owners and admins")).toBeVisible();
  await m.page.context().close();
});

test("3. a data request is confirmed by email, then exported and deleted", async ({ page, browser }) => {
  const origin = await demo(page);
  const email = `r112p${Date.now()}@example.com`;
  expect((await page.request.post("/api/contacts", { headers: { origin }, data: { name: "Pat Person", email } })).ok()).toBe(true);
  await page.goto("/app/settings/data-requests");
  await expect(page.getByText("No data requests")).toBeVisible({ timeout: 20_000 });
  await check(page, "dr-empty");
  await page.getByRole("switch").click();
  const link = page.getByTestId("dr-link");
  await expect(link).toContainText("/data-request/");
  const path = new URL((await link.textContent())!.trim()).pathname;

  const v = await visitor(browser, origin);
  await v.page.goto(path);
  await check(v.page, "dr-public");
  await v.page.getByTestId("dr-email").fill(email);
  await v.page.getByTestId("dr-type").selectOption("delete");
  await v.page.getByTestId("dr-send").click();
  await expect(v.page.getByTestId("dr-sent")).toBeVisible();

  // Before the email is confirmed nothing about the person shows.
  await page.reload();
  await page.getByTestId("dr-row").first().click();
  await expect(page.getByText("Waiting for the person to confirm their email.")).toBeVisible();
  await page.keyboard.press("Escape");

  let verify: string | null = null;
  await expect.poll(() => (verify = latestMail(email, /\/data-request\/verify\/[A-Za-z0-9_-]+/)), { timeout: 15_000 }).not.toBeNull();
  await v.page.goto(verify!);
  await expect(v.page.getByTestId("dr-verify")).toContainText("Request confirmed");
  await v.ctx.close();

  await page.reload();
  await page.getByTestId("dr-row").first().click();
  await expect(page.getByTestId("dr-count-contacts")).toHaveText("1");
  await check(page, "dr-detail");
  const dl = page.waitForEvent("download");
  await page.getByTestId("dr-zip").click();
  expect((await dl).suggestedFilename()).toMatch(/\.zip$/);
  await page.getByTestId("dr-delete").click();
  await expect(page.getByTestId("dr-delete-confirm")).toBeDisabled();
  await page.getByTestId("dr-delete-text").fill("DELETE");
  await page.getByTestId("dr-delete-confirm").click();
  await expect(page.getByText("This request is done.")).toBeVisible();
  await expect(page.getByTestId("dr-log")).toContainText("Data deleted");
  const left = await (await page.request.get(`/api/contacts?q=${encodeURIComponent(email)}`)).json();
  expect(JSON.stringify(left)).not.toContain(email);
});

test("4. Forest theme shots", async ({ page, browser }) => {
  test.skip(!SHOTS, "screenshots only with R112_SHOTS");
  const origin = await demo(page);
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  const path = await turnOn(page);
  const v = await visitor(browser, origin, 1280);
  for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/app/forms?tab=reports"); await settle(page);
    await page.screenshot({ path: join(SHOTS!, `r112-reports-${vp}-forest.png`), fullPage: true });
    await page.goto("/app/settings/data-requests"); await settle(page);
    await page.screenshot({ path: join(SHOTS!, `r112-data-requests-${vp}-forest.png`), fullPage: true });
    await v.page.setViewportSize({ width: w, height: h });
    await v.page.goto(path); await settle(v.page);
    await v.page.screenshot({ path: join(SHOTS!, `r112-public-${vp}-light.png`), fullPage: true });
  }
  await v.ctx.close();
});

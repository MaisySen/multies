import { test, expect } from "@playwright/test";

/**
 * R58 prod checks of R56 items (run only with E2E_BASE_URL and --grep r58-prod): MB-223 hosted sign in copy,
 * MB-247 My Work meeting tile in the same zone as the list (demo workspace, browser in another zone).
 */
const BASE = process.env.E2E_BASE_URL ?? "";
const SHOTS = "/home/user/tab/files/multies-r58";

test("r58-prod: MB-223 hosted sign in and sign up screens", async ({ page }) => {
  test.skip(!BASE, "prod only");
  for (const which of ["login", "signup"] as const) {
    await page.goto(`${BASE}/${which}`);
    await page.getByTestId("idp-primary").click();
    await page.waitForURL((u) => !u.toString().startsWith(BASE), { timeout: 45_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400);
    console.log(`R58_${which.toUpperCase()}_HOST`, new URL(page.url()).host);
    console.log(`R58_${which.toUpperCase()}_TEXT`, JSON.stringify(text));
    await page.screenshot({ path: `${SHOTS}/prod-verify-mb223-${which}-phone-light.png` });
  }
});

test("r58-prod: MB-247 meeting tile and list use the same zone", async ({ browser }) => {
  test.skip(!BASE, "prod only");
  const ctx = await browser.newContext({ timezoneId: "America/New_York", viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByRole("button", { name: /demo/i }).first().click();
  await page.waitForURL(/\/app/, { timeout: 45_000 });
  const mw = page.waitForResponse((r) => r.url().includes("/api/my-work"), { timeout: 30_000 });
  await page.goto(`${BASE}/app/my-work`);
  const body = await (await mw).json();
  console.log("R58_MYWORK_TZ", body.timeZone, "MEETINGS", JSON.stringify((body.meetings ?? []).map((m: { title?: string; at?: string }) => ({ title: m.title, at: m.at }))));
  if (!(body.meetings ?? []).length) {
    // The demo has no meeting today: schedule one in two hours (demo data only).
    const at = new Date(Date.now() + 2 * 3600_000).toISOString();
    const r = await page.request.post(`${BASE}/api/meetings`, { data: { title: "R58 zone check", startsAt: at, durationMin: 30 }, headers: { origin: BASE } });
    console.log("R58_MEETING_CREATE", r.status(), at);
  }
  const mw2 = page.waitForResponse((r) => r.url().includes("/api/my-work"), { timeout: 30_000 });
  await page.goto(`${BASE}/app/my-work`);
  const body2 = await (await mw2).json();
  console.log("R58_MYWORK2_MEETINGS", JSON.stringify((body2.meetings ?? []).map((m: { title?: string; at?: string }) => ({ title: m.title, at: m.at }))));
  const tile = page.getByTestId("today-meeting");
  await expect(tile).toBeVisible({ timeout: 20_000 });
  console.log("R58_TILE", JSON.stringify((await tile.innerText()).replace(/\s+/g, " ")));
  const main = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  console.log("R58_MAIN", JSON.stringify(main.slice(0, 900)));
  await page.screenshot({ path: `${SHOTS}/prod-verify-mb247-mywork-phone-light.png`, fullPage: false });
  await ctx.close();
});

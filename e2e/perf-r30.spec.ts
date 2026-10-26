import { test, expect } from "@playwright/test";

/**
 * R30 performance guards in a real browser: "/" arrives with the landing page already in the HTML and the
 * live page takes over without moving anything; sign in paints once (no layout shift on a phone).
 */
let visitor = 0;
const ip = () => `10.130.${test.info().workerIndex % 200}.${++visitor}`;

test("landing HTML is prerendered for / only, and the live page replaces it without layout shift", async ({ browser, request }) => {
  const home = await (await request.get("/")).text();
  expect(home).toContain('data-prerendered="landing"');
  expect(home).toContain('fetchpriority="low"');
  const login = await (await request.get("/login")).text();
  expect(login).toContain('<div id="root"></div>');
  expect(login).toMatch(/<link rel="modulepreload" crossorigin href="\/assets\/auth-[^"]+\.js">/);

  const ctx = await browser.newContext({ viewport: { width: 412, height: 823 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/");
  await expect(page.locator("main#main h1").first()).toBeVisible();
  // The live app has rendered over the prerendered markup (React clears the marker attribute's children and renders its own).
  await page.waitForFunction(() => !!document.querySelector("#root [data-hero-cta]") && document.readyState === "complete");
  await page.waitForTimeout(1200);
  // A production build measures 0 here. The E2E server runs in demo mode, whose demo button arrives with the
  // config read (as before R30), so this holds the line at Google's "good" bound instead.
  expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(0.1);
  await ctx.close();
});

test("sign in paints logo and card together: no layout shift on a phone", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 823 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(0.02);
  await ctx.close();
});

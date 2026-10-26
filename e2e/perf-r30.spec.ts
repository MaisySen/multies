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
  // R34 (perf2): /login now arrives with the sign in card drawn (see the spec below); the other auth pages keep the empty shell.
  expect(login).toContain('data-prerendered="auth"');
  const signup = await (await request.get("/signup")).text();
  expect(signup).toContain('<div id="root"></div>');
  expect(signup).toMatch(/<link rel="modulepreload" crossorigin href="\/assets\/auth-[^"]+\.js">/);
  // On the prerendered /login the same code starts one frame after the card paints (public/login-boot.js).
  expect(login).toMatch(/<script src="\/login-boot\.js" defer data-entry="\/assets\/index-[^"]+\.js" data-preload="[^"]*\/assets\/auth-[^"]+\.js/);

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

test("R34: /login shows the sign in card from the HTML alone (JS off), styled by its inline CSS", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 823 }, javaScriptEnabled: false, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.locator("#root[data-prerendered=auth] main")).toBeVisible();
  // Styled before any JS: the card is centred at its 400 px max width, not a raw stack of unstyled elements.
  const box = await page.locator("#root main").boundingBox();
  expect(box!.width).toBeLessThanOrEqual(400);
  expect(box!.x).toBeGreaterThan(0);
  expect(await page.locator("style[data-critical]").count()).toBe(1);
  expect(await page.locator("link[data-defer-css]").getAttribute("media")).toBe("print");
  await ctx.close();
});

test("R34: with JS on, the app takes over the prerendered card without layout shift", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 823 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/login");
  // React has rendered over the markup: the marker attribute is gone and the stylesheet is on.
  await page.waitForFunction(() => !document.getElementById("root")?.dataset.prerendered && document.readyState === "complete");
  expect(await page.locator("link[data-defer-css]").getAttribute("media")).toBe("all");
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(0.02);
  await ctx.close();
});

import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

/**
 * R40 (MB-203): the cold load of /app/my-work. The JS a phone downloads before My Work shows is held under
 * 300 KB gzip on the built app, and nothing heavy (editor, charts, calls, calendar, gantt, error tracking)
 * loads before it. PERF_R40_THROTTLE=1 also measures a slow 3G phone (500 kbps, 400 ms, cold cache) and writes
 * the numbers to PERF_R40_OUT.
 */
test.describe.configure({ mode: "serial" });
let visitor = 0;
const ip = () => `10.140.${test.info().workerIndex % 200}.${++visitor}`;
const HEAVY = /vendor-(editor|charts|calls|calendar|gantt|sentry)-/;

function gzipKb(urls: string[]): number {
  let total = 0;
  for (const u of urls) {
    const file = path.join("dist/web", new URL(u).pathname);
    if (existsSync(file)) total += gzipSync(readFileSync(file), { level: 9 }).length;
  }
  return Math.round(total / 1024);
}

async function signUp(page: Page): Promise<void> {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Perry Perf");
  await page.getByLabel("Work email").fill(`perf-r40-${Date.now()}-${visitor}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

async function coldMyWork(page: Page, throttle: boolean) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (throttle) await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: 62_500, uploadThroughput: 62_500 });
  const js: string[] = [];
  // Scripts the page runs; link rel=prefetch warm ups (resource type "other") download idle and run nothing.
  page.on("response", (r) => { if (/\/assets\/.+\.js$/.test(r.url()) && r.request().resourceType() === "script") js.push(r.url()); });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto("/app/my-work", { waitUntil: "commit" });
  await page.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 0, null, { timeout: 120_000, polling: 100 });
  const firstText = Date.now() - t0;
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Perry/ })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("main")).toBeVisible();
  const myWork = Date.now() - t0;
  const atMyWork = [...js];
  await page.waitForTimeout(throttle ? 3000 : 1500);
  return { firstText, myWork, atMyWork, all: [...js], errors };
}

test("R40: My Work cold load ships under 300 KB gzip of JS and no heavy library first", async ({ browser }) => {
  test.setTimeout(process.env.PERF_R40_THROTTLE === "1" ? 360_000 : 90_000);
  const headers: Record<string, string> = process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() };
  const setup = await browser.newContext({ extraHTTPHeaders: headers });
  await signUp(await setup.newPage());
  const state = await setup.storageState();
  await setup.close();

  const ctx = await browser.newContext({ storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: headers, serviceWorkers: "block" });
  const fast = await coldMyWork(await ctx.newPage(), false);
  await ctx.close();
  const initialKb = gzipKb(fast.atMyWork);
  const heavy = fast.atMyWork.filter((u) => HEAVY.test(u)).map((u) => new URL(u).pathname);
  const result: Record<string, unknown> = { initialJsGzipKb: initialKb, initialJsFiles: fast.atMyWork.length, heavyBeforeMyWork: heavy, jsAfterIdleGzipKb: gzipKb(fast.all) };

  if (process.env.PERF_R40_THROTTLE === "1") {
    const slow = await browser.newContext({ storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: headers, serviceWorkers: "block" });
    const s = await coldMyWork(await slow.newPage(), true);
    await slow.close();
    Object.assign(result, { slow3gFirstTextMs: s.firstText, slow3gMyWorkMs: s.myWork, slow3gJsGzipKb: gzipKb(s.atMyWork), slow3gJsFiles: s.atMyWork.length });
  }
  if (process.env.PERF_R40_OUT) writeFileSync(process.env.PERF_R40_OUT, JSON.stringify(result, null, 2));
  console.log("perf-r40", JSON.stringify(result));
  expect(fast.errors).toEqual([]);
  if (process.env.PERF_R40_MEASURE_ONLY !== "1") {
    expect(heavy).toEqual([]);
    expect(initialKb).toBeLessThan(300);
  }
});

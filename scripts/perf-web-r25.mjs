// Web page timing (R25): first contentful paint, largest contentful paint and JS transferred for the
// main pages at a desktop and a phone viewport, phone with 4x CPU throttling. Local server only.
// Usage: PERF_BASE_URL=http://localhost:8920 node scripts/perf-web-r25.mjs [runs]
// Start the local server first (npm run build:web, then the E2E server command on your port).
import { chromium } from "@playwright/test";

const base = process.env.PERF_BASE_URL ?? "http://localhost:8920";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) throw new Error("perf-web-r25 runs against a local server only");
const runs = Number(process.argv[2] ?? 3);
const routes = ["/", "/app", "/app/tasks", "/app/mail", "/app/chat"];
const profiles = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, cpu: 1, mobile: false },
  { name: "phone", viewport: { width: 390, height: 844 }, cpu: 4, mobile: true },
];

const browser = await chromium.launch();
// One signed-in account, reused through its cookies; every measured load starts with an empty cache.
const setup = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": "10.250.0.1" } });
const tag = Math.random().toString(36).slice(2, 8); // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator (a tag for a throwaway test account in a local measuring script)
const headers = { origin: new URL(base).origin };
const res = await setup.request.post("/api/auth/sign-up/email", { data: { name: "Perf Person", email: `perf-${tag}@example.com`, password: "a-strong-password" }, headers });
if (res.status() !== 200) throw new Error(`sign up failed: ${res.status()}`);
await setup.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
const state = await setup.storageState();
await setup.close();

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function measure(profile, route) {
  const ctx = await browser.newContext({ baseURL: base, viewport: profile.viewport, isMobile: profile.mobile, hasTouch: profile.mobile, storageState: route === "/" ? undefined : state, extraHTTPHeaders: { "x-forwarded-for": "10.250.0.2" } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  await page.addInitScript(() => {
    window.__lcp = 0;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__lcp = Math.max(window.__lcp, e.startTime); }).observe({ type: "largest-contentful-paint", buffered: true });
  });
  await page.goto(route, { waitUntil: "load" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
    const js = performance.getEntriesByType("resource").filter((e) => /\.m?js(\?|$)/.test(e.name));
    const size = (list) => list.reduce((a, e) => a + (e.transferSize || e.encodedBodySize || 0), 0) / 1024;
    // JS the page needed to show (fetched before the load event) apart from what idle prefetch added afterwards.
    const loadEnd = performance.getEntriesByType("navigation")[0]?.loadEventEnd ?? Infinity;
    const early = js.filter((e) => e.startTime <= loadEnd);
    return { fcp, lcp: window.__lcp, jsKb: size(js), jsFiles: js.length, jsAtLoadKb: size(early), jsAtLoadFiles: early.length };
  });
  await ctx.close();
  return m;
}

const rows = [];
for (const profile of profiles) {
  for (const route of routes) {
    const samples = [];
    for (let i = 0; i < runs; i++) samples.push(await measure(profile, route));
    rows.push({
      profile: profile.name,
      route,
      fcpMs: Math.round(median(samples.map((s) => s.fcp))),
      lcpMs: Math.round(median(samples.map((s) => s.lcp))),
      jsKb: Math.round(median(samples.map((s) => s.jsKb)) * 10) / 10,
      jsFiles: median(samples.map((s) => s.jsFiles)),
      jsAtLoadKb: Math.round(median(samples.map((s) => s.jsAtLoadKb)) * 10) / 10,
      jsAtLoadFiles: median(samples.map((s) => s.jsAtLoadFiles)),
    });
  }
}
await browser.close();
console.log(JSON.stringify(rows, null, 2));

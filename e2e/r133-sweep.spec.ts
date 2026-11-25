import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFileSync, mkdirSync } from "node:fs";

/** R133 audit sweep (not part of CI): every rail page at 1280 and 390, light, dark and Forest. */
const OUT = process.env.R133_OUT ?? "/tmp/r133";
const SHOTS = process.env.R133_SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
mkdirSync(OUT, { recursive: true }); // W4: the report folder may not exist yet on a fresh machine
let n = 0;
const ip = () => `10.133.${Math.floor(Math.random() * 200)}.${++n}`;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 20_000 }).toBeGreaterThan(5);
  await page.request.post("/api/account/demo/seed", { headers: { origin: new URL(page.url()).origin } }).catch(() => null);
}

const settle = async (page: Page) => { await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined); await page.waitForTimeout(400); };
const slug = (p: string) => p.replace(/^\/app\/?/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";

async function inspect(page: Page) {
  return page.evaluate(() => {
    const vis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); const s = getComputedStyle(el as HTMLElement); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const texts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) { const t = walker.currentNode.textContent?.trim() ?? ""; const p = walker.currentNode.parentElement; if (t && p && vis(p) && !p.closest("pre,code,[contenteditable=true],textarea,.cm-editor")) texts.push(t); }
    const dash = texts.filter((t) => /[\u2013\u2014]|\s-\s/.test(t)).slice(0, 8);
    const btns = [...document.querySelectorAll("button,a[role=button],[role=menuitem]")].filter(vis).map((b) => (b.textContent ?? "").trim()).filter(Boolean);
    const title = btns.filter((t) => /^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/.test(t) && t.split(/\s+/).length <= 4).slice(0, 8);
    const h1 = [...document.querySelectorAll("h1")].filter(vis).map((h) => h.textContent?.trim());
    const spinners = document.querySelectorAll("[role=progressbar],.animate-spin").length;
    const small = [...document.querySelectorAll("button,a,[role=button],input,select")].filter(vis).filter((b) => { const r = (b as HTMLElement).getBoundingClientRect(); return r.height < 32 || r.width < 32; }).length;
    return { overflow: document.documentElement.scrollWidth > window.innerWidth + 1, dash, title, h1, spinners, small, blank: texts.join(" ").length < 40 };
  });
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical" || v.impact === "moderate").map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, t: String(v.nodes[0]?.target ?? "").slice(0, 120) }));
}

test("R133 sweep", async ({ page, context }) => {
  test.setTimeout(1_500_000);
  await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const errors: Record<string, string[]> = {};
  let cur = "";
  page.on("console", (m) => { if (m.type() === "error") (errors[cur] ??= []).push(m.text().slice(0, 160)); });
  page.on("response", (r) => { if (r.status() >= 400 && !/sentry|beacon/.test(r.url())) (errors[cur] ??= []).push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
  page.on("pageerror", (e) => (errors[cur] ??= []).push("PAGEERROR " + e.message.slice(0, 160)));
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(page);
  await page.goto("/app/my-work"); await settle(page);
  const found = await page.evaluate(() => [...new Set([...document.querySelectorAll("nav a[href^='/app'], aside a[href^='/app']")].map((a) => new URL((a as HTMLAnchorElement).href).pathname))]);
  const extra = (process.env.R133_EXTRA ?? "").split(",").filter(Boolean);
  const pages = [...new Set(process.env.R133_ONLY ? extra : [...found, ...extra])].slice(0, Number(process.env.R133_MAX ?? 45));
  const res: Record<string, unknown>[] = [];
  const pass = async (label: string, w: number, h: number, scheme: "light" | "dark", doAxe: boolean) => {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    for (const p of pages) {
      cur = `${p} ${label}`;
      const t0 = Date.now();
      const cap = <T,>(x: Promise<T>, ms: number, d: T) => Promise.race([x, new Promise<T>((r) => setTimeout(() => r(d), ms))]);
      try { await page.goto(p, { timeout: 30_000 }); } catch (e) { res.push({ p, label, gotoError: String(e).slice(0, 120) }); continue; }
      await settle(page);
      const ms = Date.now() - t0;
      const ins = await cap(inspect(page).catch(() => null), 15_000, { hung: "inspect" } as never);
      const ax = doAxe ? await cap(axe(page).catch((e) => [{ id: "axe-error", impact: "x", n: 0, t: String(e).slice(0, 80) }]), 45_000, [{ id: "axe-timeout", impact: "x", n: 0, t: "" }]) : [];
      if (SHOTS) await cap(page.screenshot({ path: `${SHOTS}/${slug(p)}-${label}.png`, timeout: 15_000 }).catch(() => undefined), 20_000, undefined);
      res.push({ p, label, ms, ...ins, axe: ax, url: new URL(page.url()).pathname });
      writeFileSync(`${OUT}/${process.env.R133_NAME ?? "sweep"}.json`, JSON.stringify({ pages, res, errors }, null, 1));
    }
    writeFileSync(`${OUT}/${process.env.R133_NAME ?? "sweep"}.json`, JSON.stringify({ pages, res, errors }, null, 1));
  };
  await pass("1280-light", 1280, 800, "light", true);
  await pass("1280-dark", 1280, 800, "dark", true);
  await pass("390-light", 390, 844, "light", true);
  await pass("390-dark", 390, 844, "dark", true);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app/settings/branding"); await settle(page);
  const forest = page.getByRole("button", { name: "Forest", exact: true });
  if (await forest.count()) { await forest.click(); await page.getByRole("button", { name: "Save brand" }).click(); await page.waitForTimeout(800); await pass("1280-forest", 1280, 800, "light", true); }
  writeFileSync(`${OUT}/${process.env.R133_NAME ?? "sweep"}.json`, JSON.stringify({ pages, res, errors }, null, 1));
});

test("R133 throttled 4G cold loads and route changes", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await demo(page);
  const state = await ctx.storageState();
  const out: Record<string, unknown>[] = [];
  for (const p of (process.env.R133_PERF ?? "/app/my-work,/app/inbox,/app/tasks,/app/docs,/app/chat,/app/calendar,/app/files,/app/social,/app/tools,/app/settings").split(",")) {
    const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: state, extraHTTPHeaders: { "x-forwarded-for": ip() } });
    const pg = await c2.newPage();
    const cdp = await c2.newCDPSession(pg);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 70, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    let jsBytes = 0; let reqs = 0;
    pg.on("response", async (r) => { reqs++; if (/\.js$/.test(new URL(r.url()).pathname)) { const l = Number(r.headers()["content-length"] ?? 0); jsBytes += l; } });
    const t0 = Date.now();
    await pg.goto(p, { waitUntil: "commit", timeout: 60_000 });
    await pg.waitForSelector("main h1, main [role=heading], main", { timeout: 60_000 }).catch(() => undefined);
    await pg.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
    const idle = Date.now() - t0;
    const lcp = await pg.evaluate(() => new Promise<number>((res) => { let v = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) v = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); setTimeout(() => res(Math.round(v)), 300); }));
    const nav = await pg.evaluate(() => { const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming; return { ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd) }; });
    // A route change: click the first rail link that is not this page.
    let routeMs = -1;
    await pg.setViewportSize({ width: 1280, height: 800 });
    const link = pg.locator(`nav a[href^='/app']:not([href='${p}'])`).first();
    if (await link.count()) { const t1 = Date.now(); await link.click().catch(() => undefined); await pg.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined); routeMs = Date.now() - t1; }
    out.push({ p, idle, lcp, ...nav, routeMs, reqs, jsKbHeader: Math.round(jsBytes / 1024) });
    await c2.close();
    writeFileSync(`${OUT}/perf.json`, JSON.stringify(out, null, 1));
  }
  await ctx.close();
});

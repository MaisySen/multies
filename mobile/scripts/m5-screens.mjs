// M5 (1.10.13): the visual polish pass. Main screens at 375, 390 and 430 wide, light and dark, on the web build with the
// sample workspace, with fixtures for extremes (15,527 unread, zero counts, a long name) set through localStorage "m5-shots".
// Checks: no sideways scroll, the Today hero holds its actions and spans the content width, the tab badges stay short, axe at 390.
// Usage: node scripts/m5-screens.mjs <web-export-dir> <out-dir> [--only=390-light] [--prefix=before]
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const dir = process.argv[2] ?? "dist-web";
const out = process.argv[3] ?? "screens";
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
mkdirSync(out, { recursive: true });
const prefix = process.argv.find((a) => a.startsWith("--prefix="))?.slice(9) ?? "after";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let f = join(dir, p);
  if (!existsSync(f) || statSync(f).isDirectory()) f = existsSync(`${f}.html`) ? `${f}.html` : existsSync(join(f, "index.html")) ? join(f, "index.html") : join(dir, "index.html");
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const problems = [];
const BIG = { counts: { mail: { inbox: 15527 }, chat: { unread: 1234, mentions: 3 }, notifications: { unread: 87 }, tasks: { dueToday: 9, overdue: 133 } }, approvals: 2, name: "Bidurkumar Maharjan Khatri Chhetri" };
const ZERO = { counts: { mail: { inbox: 0 }, chat: { unread: 0, mentions: 0 }, notifications: { unread: 0 }, tasks: { dueToday: 0, overdue: 0 } }, approvals: 0 };
const heights = { 375: 812, 390: 844, 430: 932 };
const browser = await chromium.launch();
try {
  for (const width of [375, 390, 430]) for (const scheme of ["light", "dark"]) {
    const tag = `${width}-${scheme}`;
    if (only && tag !== only) continue;
    const ctx = await browser.newContext({ viewport: { width, height: heights[width] }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: scheme });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
    const shot = async (name) => {
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${out}/${prefix}-${name}-${tag}.png` });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push(`${name} ${tag}: scrolls sideways`);
      // Tab badges: never longer than "99+".
      const long = await page.evaluate(() => [...document.querySelectorAll('[role="tab"] *, [role="link"] *')].map((e) => e.childElementCount === 0 ? e.textContent ?? "" : "").filter((s) => /^[0-9][0-9,.+K…]*$/.test(s) && s.length > 3));
      if (long.length) problems.push(`${name} ${tag}: long tab badge ${long.slice(0, 3).join(" ")}`);
      if (width !== 390) return;
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      if (serious.length) problems.push(`${name} ${tag}: axe ${serious.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 90)).join(" | ")}`).join("; ")}`);
    };
    const step = async (name, fn) => { try { await fn(); } catch (e) { problems.push(`${name} ${tag}: ${String(e).split("\n")[0].slice(0, 200)}`); } };
    const fixture = async (f) => { await page.evaluate((v) => v ? localStorage.setItem("m5-shots", JSON.stringify(v)) : localStorage.removeItem("m5-shots"), f); };
    const heroCheck = async (name) => {
      const box = async (id) => (await tid(id).boundingBox());
      const hero = await box("today-hero"), mail = await box("today-mail");
      const fill = await page.getByTestId("today-hero-fill").first().boundingBox().catch(() => null);
      if (hero && mail && Math.abs(hero.x + hero.width - (mail.x + mail.width)) > 1.5 && Math.abs(hero.x + hero.width - (mail.x + mail.width)) < 400) {
        // mail tile is the left of a pair; compare with the right tile instead
        const tasks = await box("today-tasks");
        if (tasks && Math.abs(hero.x + hero.width - (tasks.x + tasks.width)) > 1.5) problems.push(`${name} ${tag}: hero right edge ${Math.round(hero.x + hero.width)} vs grid ${Math.round(tasks.x + tasks.width)}`);
      }
      if (fill && hero && (fill.width + 1 < hero.width || fill.height + 1 < hero.height)) problems.push(`${name} ${tag}: hero fill smaller than the card`);
      for (const id of ["today-compose", "today-mytasks", "today-search"]) {
        const b = await box(id).catch(() => null);
        if (b && hero && (b.y + b.height > hero.y + hero.height + 0.5 || b.x + b.width > hero.x + hero.width + 0.5)) problems.push(`${name} ${tag}: ${id} spills out of the hero`);
      }
    };
    await page.goto(base);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1200);
    await step("sign in", async () => { await shot("00-sign-in"); });
    if (await page.getByTestId("sample").first().isVisible().catch(() => false)) await tid("sample").click();
    await page.waitForTimeout(2500);
    const go = async (path, id) => { await page.goto(`${base}${path}`); await tid(id).waitFor(); };
    const wait = async (path) => { await page.goto(`${base}${path}`); await page.waitForTimeout(2500); };
    const pin = async (digits, id = "setup-pin") => { for (const d of digits) await tid(`${id}-${d}`).click(); await page.waitForTimeout(400); };
    await fixture(BIG);
    await step("today big", async () => { await go("/today", "today-hero"); await heroCheck("today big"); await shot("01-today-big"); });
    await step("today big scrolled", async () => { await page.getByTestId("today").first().evaluate((e) => { e.scrollTop = 99999; }); await page.mouse.wheel(0, 2000); await shot("02-today-big-scrolled"); });
    await step("inbox big", async () => { await wait("/inbox"); await shot("04-inbox"); });
    await step("chat", async () => { await wait("/chat"); await shot("05-chat"); });
    await step("tasks", async () => { await wait("/tasks"); await shot("06-tasks"); });
    await step("more", async () => { await wait("/more"); await shot("07-more"); });
    await step("settings", async () => { await go("/settings", "biometric-lock"); await shot("08-settings"); });
    await fixture(ZERO);
    await step("today zero", async () => { await go("/today", "today-hero"); await heroCheck("today zero"); await shot("03-today-zero"); });
    await fixture(null);
    await step("security off", async () => { await go("/security", "lock-turn-on"); await shot("09-security"); });
    await step("pin setup", async () => { await tid("lock-turn-on").click(); await tid("setup-pin").waitFor(); await pin("12"); await shot("10-pin-setup"); });
    await step("lock screen", async () => { await pin("34"); await pin("1234"); await tid("lock-hide").waitFor(); await page.evaluate(() => localStorage.setItem("m4-shots", "1")); await go("/today", "lock-pin"); await page.waitForTimeout(800); await shot("11-lock");
      await pin("0000", "lock-pin"); await shot("12-lock-wrong-pin"); await pin("1234", "lock-pin"); await tid("today-hero").waitFor(); });
    if (errors.length) problems.push(`${tag}: page errors ${errors.slice(0, 2).join(" | ").slice(0, 300)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? `PROBLEMS ${problems.length}\n${problems.join("\n")}` : "OK no problems");

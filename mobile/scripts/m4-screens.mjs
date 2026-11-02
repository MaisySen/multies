// M4: the design pass, app lock and the new native screens; previously M3 (1.10.11): the main screens after the native pass (Today, More, a More section, Goals, Forms, Time, Automations, Approvals, Settings, Inbox).
// M1 work: Mail merge (newsletters, lists, journeys, a newsletter, a journey), Mail archive (policy, holds, search), Sync
// (app passwords, a new one shown once), Contacts, a contact, Visits and the Tools entry, on the web build with the sample workspace (no server, no network), light and dark at 390,
// with layout checks (no sideways scroll) and axe.
// Usage: node scripts/m1-work-screens.mjs <web-export-dir> <out-dir> [--only=390-light]
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const dir = process.argv[2] ?? "dist-web";
const out = process.argv[3] ?? "screens";
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
mkdirSync(out, { recursive: true });
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
const browser = await chromium.launch();
try {
  for (const width of [390]) for (const scheme of ["light", "dark"]) {
    const tag = `${width}-${scheme}`;
    if (only && tag !== only) continue;
    const ctx = await browser.newContext({ viewport: { width, height: width === 375 ? 812 : 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: scheme });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
    const shot = async (name) => {
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${out}/${name}-${tag}.png` });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push(`${name} ${tag}: scrolls sideways`);
      if (width !== 390) return;
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      if (serious.length) problems.push(`${name} ${tag}: axe ${serious.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 90)).join(" | ")}`).join("; ")}`);
    };
    const step = async (name, fn) => { try { await fn(); } catch (e) { problems.push(`${name} ${tag}: ${String(e).split("\n")[0].slice(0, 200)}`); } };
    await page.goto(base);
    await page.waitForLoadState("networkidle");
    if (await page.getByTestId("sample").first().isVisible().catch(() => false)) await tid("sample").click();
    await page.waitForTimeout(2500);
    const go = async (path, id) => { await page.goto(`${base}${path}`); await tid(id).waitFor(); };
    const wait = async (path) => { await page.goto(`${base}${path}`); await page.waitForTimeout(2500); };
    const pin = async (digits, id = "setup-pin") => { for (const d of digits) await tid(`${id}-${d}`).click(); await page.waitForTimeout(400); };
    await step("today", async () => { await go("/today", "today-hero"); await shot("01-today"); });
    await step("inbox", async () => { await wait("/inbox"); await shot("02-inbox"); });
    await step("tasks", async () => { await wait("/tasks"); await shot("03-tasks"); });
    await step("more", async () => { await wait("/more"); await shot("04-more"); });
    await step("settings", async () => { await go("/settings", "biometric-lock"); await shot("05-settings"); });
    await step("invoices", async () => { await go("/invoices", "invoice-inv_1"); await shot("06-invoices"); });
    await step("invoice", async () => { await tid("invoice-inv_1").click(); await tid("invoice-amount").waitFor(); await shot("07-invoice"); });
    await step("scheduling", async () => { await go("/scheduling", "booking-bk_1"); await shot("08-scheduling"); });
    await step("links", async () => { await go("/links", "link-ln_1"); await shot("09-links"); });
    await step("security off", async () => { await go("/security", "lock-turn-on"); await shot("10-security-off"); });
    await step("pin setup", async () => { await tid("lock-turn-on").click(); await tid("setup-pin").waitFor(); await pin("12"); await shot("11-pin-setup"); });
    await step("security on", async () => { await pin("34"); await pin("1234"); await tid("lock-hide").waitFor(); await shot("12-security-on"); });
    await step("lock screen", async () => { await page.evaluate(() => localStorage.setItem("m4-shots", "1")); await go("/today", "lock-pin"); await page.waitForTimeout(800); await shot("13-lock-screen");
      await pin("0000", "lock-pin"); await shot("14-lock-wrong-pin"); await pin("1234", "lock-pin"); await tid("today-hero").waitFor(); });
    if (errors.length) problems.push(`${tag}: page errors ${errors.slice(0, 2).join(" | ").slice(0, 300)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? `PROBLEMS ${problems.length}\n${problems.join("\n")}` : "OK no problems");

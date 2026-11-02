// M3 (1.10.11): the main screens after the native pass (Today, More, a More section, Goals, Forms, Time, Automations, Approvals, Settings, Inbox).
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
    await step("today", async () => { await go("/today", "today-approvals"); await shot("01-today"); });
    await step("more", async () => { await go("/more", "more-tile-home").catch(async () => { await page.goto(`${base}/more`); await page.waitForTimeout(1500); }); await shot("02-more"); });
    await step("more tasks", async () => { await go("/more/tasks", "more-section-tasks"); await shot("03-more-tasks"); });
    await step("more settings", async () => { await go("/more/workspace", "more-section-workspace"); await shot("04-more-settings"); });
    // Reached the way a person does (More > section > page), so the header shows Back.
    const via = async (section, page, id) => { await go(`/more/${section}`, `more-section-${section}`); await tid(`more-page-${page}`).click(); await tid(id).waitFor(); };
    await step("goals", async () => { await via("tasks", "/app/goals", "goals-screen"); await shot("05-goals"); });
    await step("forms", async () => { await via("docs", "/app/forms", "form-fm_1"); await shot("06-forms"); });
    await step("form", async () => { await tid("form-fm_1").click(); await tid("response-rs_1").waitFor(); await shot("07-form-responses"); });
    await step("time", async () => { await via("tasks", "/app/time", "time-week"); await shot("08-time"); });
    await step("automations", async () => { await via("agents", "/app/automations", "automation-au_1"); await shot("09-automations"); });
    await step("cold open", async () => { await go("/goals", "goals-screen"); await shot("13-goals-cold-open"); });
    await step("approvals", async () => { await go("/today", "today-approvals"); await tid("today-approvals").click(); await tid("approvals-list").waitFor(); await shot("10-approvals"); });
    await step("settings", async () => { await go("/more/workspace", "more-section-workspace"); await tid("more-page-/app/settings").click(); await tid("workspaces-link").waitFor(); await shot("11-settings"); });
    await step("inbox", async () => { await page.goto(`${base}/inbox`); await page.waitForTimeout(2500); await shot("12-inbox"); });
    if (errors.length) problems.push(`${tag}: page errors ${errors.slice(0, 2).join(" | ").slice(0, 300)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? `PROBLEMS ${problems.length}\n${problems.join("\n")}` : "OK no problems");

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
    await step("mail merge", async () => { await go("/mail-merge", "newsletter-nl_s1"); await shot("01-mail-merge"); });
    await step("lists", async () => { await page.getByText("Lists", { exact: true }).first().click(); await tid("list-lst_s1").waitFor(); await shot("02-merge-lists"); });
    await step("journeys", async () => { await page.getByText("Journeys", { exact: true }).first().click(); await tid("journey-jr_s1").waitFor(); await shot("03-merge-journeys"); });
    await step("newsletter", async () => { await go("/newsletter/nl_s1", "newsletter-pause"); await shot("04-newsletter"); });
    await step("journey", async () => { await go("/journey/jr_s1", "journey-pause"); await shot("05-journey"); });
    await step("archive", async () => { await go("/mail-archive", "hold-hold_s1"); await shot("06-archive"); });
    await step("archive search", async () => { await tid("archive-search").fill("invoice"); await tid("archive-search-go").click(); await tid("hit-am_s1").waitFor(); await tid("hit-am_s1").scrollIntoViewIfNeeded(); await shot("07-archive-search"); });
    await step("sync", async () => { await go("/sync", "sync-server"); await shot("08-sync"); });
    await step("sync made", async () => { await tid("sync-name").fill("Pixel 8"); await tid("sync-make").click(); await tid("sync-made-password").waitFor(); await shot("09-sync-made"); });
    await step("contacts", async () => { await go("/contacts", "contact-con_s1"); await shot("10-contacts"); });
    await step("contact", async () => { await go("/contact/con_s1", "contact-directions"); await shot("11-contact"); });
    await step("visits", async () => { await go("/visits", "visit-pick-plc_s1"); await shot("12-visits"); });
    await step("tools entry", async () => { await go("/tools", "tools-mail-merge"); await shot("13-tools"); });
    if (errors.length) problems.push(`${tag}: page errors ${errors.slice(0, 2).join(" | ").slice(0, 300)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? `PROBLEMS ${problems.length}\n${problems.join("\n")}` : "OK no problems");

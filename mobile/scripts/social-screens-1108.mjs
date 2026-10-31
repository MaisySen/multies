// 1.10.8: Social inbox, a conversation (reply window open, closing soon, closed), Done, and Accounts with the broken
// account pinned, on the web build with the sample workspace (no server, no network), light and dark, with layout
// checks (no sideways scroll, the four Social parts fit) and axe at 390.
// Usage: node scripts/social-screens-1108.mjs <web-export-dir> <out-dir> [--only=390-light]
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
  for (const width of [375, 390]) for (const scheme of ["light", "dark"]) {
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
    await page.goto(`${base}/social?tab=inbox`);
    await step("inbox", async () => {
      await tid("inbox-row-si_1").waitFor();
      const seg = await page.getByRole("tablist", { name: "Social" }).first().boundingBox();
      if (!seg || seg.x + seg.width > width + 1) problems.push(`inbox ${tag}: Social parts do not fit`);
      await shot("01-inbox");
    });
    await step("done", async () => { await tid("inbox-filter-done").click(); await tid("inbox-row-si_6").waitFor(); await shot("02-inbox-done"); await tid("inbox-filter-all").click(); });
    for (const [id, name] of [["si_1", "03-conversation-open"], ["si_3", "04-conversation-closing-soon"], ["si_5", "05-conversation-closed"], ["si_2", "06-conversation-assigned"]]) {
      await step(name, async () => {
        await page.goto(`${base}/social?tab=inbox`);
        await tid(`inbox-row-${id}`).click();
        await tid("inbox-item-message").waitFor();
        await shot(name);
      });
    }
    await step("accounts", async () => {
      await page.goto(`${base}/social?tab=accounts`);
      await tid("social-accounts").waitFor();
      await shot("07-accounts");
    });
    if (errors.length) problems.push(`${tag}: page errors ${errors.slice(0, 2).join(" | ").slice(0, 300)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? `PROBLEMS ${problems.length}\n${problems.join("\n")}` : "OK no problems");

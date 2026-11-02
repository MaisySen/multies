// M1 searchdocs: global Search (results, a type chip) and Docs (tree, reader, comments, share) on the web build with the
// sample workspace (no server, no network), 390 wide, light and dark, with layout checks (no sideways scroll) and axe.
// Usage: node scripts/m1-searchdocs-screens.mjs <web-export-dir> <out-dir> [--only=390-light]
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
  for (const scheme of ["light", "dark"]) {
    const width = 390;
    const tag = `${width}-${scheme}`;
    if (only && tag !== only) continue;
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: scheme });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
    const shot = async (name) => {
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${out}/${name}-${tag}.png` });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push(`${name} ${tag}: scrolls sideways`);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      if (serious.length) problems.push(`${name} ${tag}: axe ${serious.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 90)).join(" | ")}`).join("; ")}`);
    };
    const step = async (name, fn) => { try { await fn(); } catch (e) { problems.push(`${name} ${tag}: ${String(e).split("\n")[0].slice(0, 200)}`); } };
    await page.goto(base);
    await page.waitForLoadState("networkidle");
    if (await page.getByTestId("sample").first().isVisible().catch(() => false)) await tid("sample").click();
    await page.waitForTimeout(2500);
    await step("search", async () => {
      await page.goto(`${base}/search`);
      await tid("search").fill("plan");
      await tid("search-docs-doc_plan").waitFor();
      await shot("01-search-all");
      await tid("search-chip-docs").click();
      await page.waitForTimeout(800);
      await shot("02-search-docs-chip");
    });
    await step("search-empty", async () => { await page.goto(`${base}/search`); await tid("search").waitFor(); await shot("03-search-start"); });
    await step("docs", async () => {
      await page.goto(`${base}/docs`);
      await tid("doc-row-doc_plan").waitFor();
      await tid("doc-toggle-doc_plan").click();
      await tid("doc-row-doc_board").waitFor();
      await shot("04-docs-tree");
    });
    await step("reader", async () => {
      await page.goto(`${base}/doc/doc_plan`);
      await tid("doc-reader").waitFor();
      await shot("05-doc-reader-top");
      await page.mouse.wheel(0, 700);
      await page.evaluate(() => { for (const el of document.querySelectorAll("div")) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== "visible") el.scrollTop = 750; });
      await shot("06-doc-reader-more");
      await page.evaluate(() => { for (const el of document.querySelectorAll("div")) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== "visible") el.scrollTop = 100000; });
      await shot("07-doc-reader-end");
    });
    await step("comments", async () => { await page.goto(`${base}/doc/comments/doc_plan`); await tid("comment-input").waitFor(); await shot("08-doc-comments"); });
    await step("share", async () => {
      await page.goto(`${base}/doc/share/doc_plan`);
      await tid("share-create").waitFor();
      await tid("share-create").click();
      await tid("share-fresh").waitFor();
      await shot("09-doc-share");
    });
    if (errors.length) problems.push(`${tag}: page errors ${errors.slice(0, 3).join(" | ").slice(0, 300)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? `PROBLEMS\n${problems.join("\n")}` : "OK no problems");
process.exit(problems.length ? 1 : 0);

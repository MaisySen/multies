// M5: form checks on the web build (sample workspace) at 390 light: each form with invalid then valid input.
// Usage: node scripts/m5-forms.mjs <web-export-dir> <out-dir>
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: "light" });
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).split("\n")[0].slice(0, 160)));
const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
const check = async (name, fn) => {
  const before = errors.length;
  try { const note = await fn(); results.push({ form: name, ok: errors.length === before, note: note ?? "", shot: `${out}/form-${name}.png` }); }
  catch (e) { results.push({ form: name, ok: false, note: String(e).split("\n")[0].slice(0, 160), shot: `${out}/form-${name}.png` }); }
  await page.screenshot({ path: `${out}/form-${name}.png` }).catch(() => {});
};
const body = () => page.evaluate(() => document.body.innerText);
try {
  await page.goto(base); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1200);
  await tid("sample").click(); await page.waitForTimeout(2500);
  await check("compose-invalid", async () => {
    await page.goto(`${base}/compose`); await tid("to").waitFor();
    await tid("to").fill("not an address"); await tid("subject").fill("Test"); await tid("body").fill("Hello");
    await tid("send").click(); await page.waitForTimeout(800);
    const t = await body();
    if (!/valid|check|address/i.test(t)) throw new Error("no message for a bad address");
    return "bad address refused with a message";
  });
  await check("compose-valid", async () => {
    await tid("to").fill("sam@bondibakehouse.com.au"); await tid("send").click(); await page.waitForTimeout(1500);
    return `after send: ${new URL(page.url()).pathname}`;
  });
  await check("task-new-empty", async () => {
    await page.goto(`${base}/task/new`); await tid("task-title").waitFor();
    const dis = await tid("save-task").evaluate((e) => e.getAttribute("aria-disabled") === "true" || e.hasAttribute("disabled"));
    if (!dis) { await tid("save-task").click(); await page.waitForTimeout(600); if (!/title|name|add/i.test(await body())) throw new Error("empty title not refused"); }
    return dis ? "Save disabled while the title is empty" : "empty title refused";
  });
  await check("task-new-valid", async () => {
    await tid("task-title").fill("Call Sam about the Saturday order tomorrow"); await tid("save-task").click(); await page.waitForTimeout(1500);
    return `after save: ${new URL(page.url()).pathname}`;
  });
  await check("search-hit", async () => {
    await page.goto(`${base}/search`); await tid("search").waitFor(); await tid("search").fill("invoice"); await page.waitForTimeout(1500);
    return (await body()).match(/INV-\d+/) ? "results shown" : "no visible result line";
  });
  await check("search-miss", async () => {
    await tid("search").fill("zzqqxx nothing"); await page.waitForTimeout(1500);
    const t = await body();
    if (!/No |nothing|no results/i.test(t)) throw new Error("no empty state for a search with no results");
    return "empty state shown";
  });
  await check("pin-mismatch", async () => {
    await page.goto(`${base}/security`); await tid("lock-turn-on").click(); await tid("setup-pin").waitFor();
    for (const d of "1234") await tid(`setup-pin-${d}`).click();
    await page.waitForTimeout(500);
    for (const d of "5678") await tid(`setup-pin-${d}`).click();
    await page.waitForTimeout(700);
    const t = await body();
    if (!/match|again|didn/i.test(t)) throw new Error("mismatched PIN not explained");
    return "mismatch explained";
  });
} finally {
  await browser.close(); server.close();
}
writeFileSync(`${out}/forms.json`, JSON.stringify(results, null, 1));
for (const r of results) console.log(`${r.ok ? "ok " : "BAD"} ${r.form}: ${r.note}`);
if (errors.length) console.log("page errors", errors.slice(0, 3).join(" | "));

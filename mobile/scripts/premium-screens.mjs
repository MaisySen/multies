// R34: before and after shots of the tab bar, a list and Settings from a web export.
// Usage: node scripts/premium-screens.mjs <dist dir> <out dir> <before|after> <port>
import { chromium } from "playwright";
import http from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
const [dist, out, prefix, port] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const types = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".ttf": "font/ttf", ".svg": "image/svg+xml" };
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  let f = join(dist, p);
  if (!existsSync(f) || p.endsWith("/")) f = existsSync(join(dist, p + ".html")) ? join(dist, p + ".html") : join(dist, "index.html");
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
}).listen(Number(port));
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: "light" });
  const page = await ctx.newPage();
  const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
  await page.goto(base); await page.waitForLoadState("networkidle");
  await tid("sample").waitFor({ timeout: 30000 }); await tid("sample").click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${prefix}-inbox.png` });
  for (const [route, name] of [["/tasks", "tasks"], ["/settings", "settings"], ["/chat", "chat"]]) {
    await page.goto(base + route); await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/${prefix}-${name}.png` });
  }
  if (prefix === "after") {
    await page.goto(base + "/inbox"); await page.waitForTimeout(2000);
    await page.mouse.move(200, 500); await page.mouse.wheel(0, 400); await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${prefix}-inbox-scrolled.png` });
  }
} finally { await browser.close(); srv.close(); }
console.log("shots done");

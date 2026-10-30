// R35: before and after shots of the chat screens (grouping, day lines), the DM menu, the report
// sheet, Settings, Privacy and safety and Blocked people, from a web export of the sample workspace.
// Usage: node scripts/r35-screens.mjs <dist dir> <out dir> <before|after> <port>
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
const shot = (page, name) => page.screenshot({ path: `${out}/mobile-${prefix}-${name}.png` });
try {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: "light" });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
  await page.goto(base); await page.waitForLoadState("networkidle");
  await tid("sample").waitFor({ timeout: 30000 }); await tid("sample").click();
  await page.waitForTimeout(2500);
  // Client side navigation keeps the sample session in memory.
  const go = async (path) => { await page.evaluate((p) => { window.history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path); await page.waitForTimeout(2200); };
  await go("/chat/chn_general"); await shot(page, "chat-channel");
  if (prefix === "after") {
    const row = tid("chat-msg-cmsg_1");
    const box = await row.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + 20); await page.mouse.down(); await page.waitForTimeout(900); await page.mouse.up(); await page.waitForTimeout(800);
      await shot(page, "message-menu");
      const rep = tid("menu-report");
      if (await rep.count()) { await rep.click(); await page.waitForTimeout(900); await tid("report-reason-harassment").click().catch(() => {}); await page.waitForTimeout(400); await shot(page, "report-sheet");
        await tid("report-send").click().catch(() => {}); await page.waitForTimeout(1200); await shot(page, "report-thanks"); await tid("report-done").click().catch(() => {}); await page.waitForTimeout(600); }
    }
  }
  await go("/chat/dm_josh"); await shot(page, "chat-dm");
  if (prefix === "after") {
    const more = tid("dm-more");
    if (await more.count()) { await more.click(); await page.waitForTimeout(900); await shot(page, "dm-menu"); await tid("sheet-block").click().catch(() => {}); await page.waitForTimeout(1500); await shot(page, "dm-blocked"); }
    await go("/blocked"); await shot(page, "blocked-people");
  }
  await go("/settings"); await page.waitForTimeout(500);
  await page.mouse.move(200, 500); await page.mouse.wheel(0, 1400); await page.waitForTimeout(900);
  await shot(page, "settings-privacy");
} finally { await browser.close(); srv.close(); }
console.log("shots done");

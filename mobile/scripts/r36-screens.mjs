// R36: before and after shots of the phone pass 2 screens (mail thread, task detail, meetings,
// search, sign in, two step, settings sub pages) from a web export of the sample workspace.
// Usage: node scripts/r36-screens.mjs <dist dir> <out dir> <before|after> <port>
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
const LIGHT = [["thread", "/thread/msg_3"], ["task", "/task/TASK"], ["meetings", "/meetings"], ["search", "/search"],
  ["notification-settings", "/notification-settings"], ["blocked", "/blocked"], ["delete-account", "/delete-account"],
  ["email-setup", "/email-setup"], ["free-address", "/free-address"], ["connect-mailbox", "/connect-mailbox"], ["people", "/people"], ["two-factor", "/two-factor"]];
const DARK = ["thread", "task", "search"];
async function run(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: scheme });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  const shot = (name) => page.screenshot({ path: `${out}/mobile-${prefix}-${name}${scheme === "dark" ? "-dark" : ""}.png` });
  const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
  await page.goto(base); await page.waitForLoadState("networkidle");
  await tid("sample").waitFor({ timeout: 30000 });
  if (scheme === "light") await shot("sign-in");
  await tid("sample").click();
  await page.waitForTimeout(2500);
  const go = async (path) => { await page.evaluate((p) => { window.history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path); await page.waitForTimeout(2200); };
  // The first task in the list is the detail we shoot.
  await go("/tasks");
  const href = await page.evaluate(() => { const a = [...document.querySelectorAll('[data-testid^="task-row-"]')][0]; return a ? a.getAttribute("data-testid").replace("task-row-", "") : null; });
  for (const [name, path0] of LIGHT) {
    if (scheme === "dark" && !DARK.includes(name)) continue;
    const path = path0.replace("TASK", href ?? "tsk_s1");
    await go(path);
    if (name === "search") { await page.keyboard.type("invoice").catch(() => {}); await page.waitForTimeout(1500); }
    await shot(name);
  }
  await ctx.close();
}
try { await run("light"); await run("dark"); } finally { await browser.close(); srv.close(); }
console.log("shots done");

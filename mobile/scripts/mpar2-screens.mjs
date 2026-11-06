// MPAR2: the language, appearance and settings round on the web build with the sample workspace.
// Every touched screen at 375, 390 and 430 wide, in light, dark and Forest, in English, Nepali and Hindi.
// Checks: no sideways scroll, nothing spills past the screen edge, tap targets at least 44 px (new screens strict,
// older screens listed), no tight line height on Devanagari text, no raw string key on screen, axe serious or critical at 390.
// Usage: node scripts/mpar2-screens.mjs <web-export-dir> <out-dir> [--only=ne] [--widths=390]
// One run per language side by side keeps the whole set under ten minutes.
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const dir = process.argv[2] ?? "dist-web";
const out = process.argv[3] ?? "screens";
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const widths = (process.argv.find((a) => a.startsWith("--widths="))?.slice(9) ?? "375,390,430").split(",").map(Number);
mkdirSync(out, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let f = join(dir, p);
  if (!existsSync(f) || statSync(f).isDirectory()) f = existsSync(`${f}.html`) ? `${f}.html` : existsSync(join(f, "index.html")) ? join(f, "index.html") : join(dir, "index.html");
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const NEW = new Set(["account", "appearance", "language", "billing", "get-started"]);
const SCREENS = [
  ["today", "/today", "today-hero"], ["inbox", "/inbox", null], ["thread", "/thread/msg_1", null], ["compose", "/compose", null],
  ["chat", "/chat", null], ["tasks", "/tasks", null], ["more", "/more", null], ["settings", "/settings", "settings-screen"],
  ["account", "/account", "account-screen"], ["appearance", "/appearance", "appearance-screen"], ["language", "/language", "language-screen"],
  ["billing", "/billing", "billing-plan"], ["get-started", "/get-started", "started-count"], ["search", "/search", null],
];
const COMBOS = [];
for (const lang of ["en", "ne", "hi"]) for (const look of ["light", "dark", "forest"]) COMBOS.push({ lang, look });
const heights = { 375: 812, 390: 844, 430: 932 };
const problems = [], notes = [];
const summary = { shots: 0, checks: 0, axeRuns: 0 };
const browser = await chromium.launch();
try {
  for (const { lang, look } of COMBOS) for (const width of widths) {
    if (only && !`${lang}-${look}-${width}`.includes(only)) continue;
    const tag = `${lang}-${look}-${width}`;
    const ctx = await browser.newContext({ viewport: { width, height: heights[width] }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: lang === "en" ? "en-AU" : lang === "ne" ? "ne-NP" : "hi-IN", timezoneId: "Australia/Sydney", colorScheme: look === "dark" ? "dark" : "light" });
    await ctx.addInitScript(({ lang, look }) => {
      try {
        localStorage.setItem("multies.pref.language", lang);
        localStorage.setItem("multies.pref.appearance", look === "dark" ? "dark" : "light");
        if (look === "forest") localStorage.setItem("multies.pref.accent", "forest"); else localStorage.removeItem("multies.pref.accent");
      } catch { /* storage blocked */ }
    }, { lang, look });
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(base); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
    for (const [name, path, id] of SCREENS) {
      try {
        await page.goto(`${base}${path}`);
        if (id) await page.getByTestId(id).filter({ visible: true }).first().waitFor(); else await page.waitForTimeout(1800);
        await page.waitForTimeout(600);
        const file = `${out}/${name}-${tag}.png`;
        await page.screenshot({ path: file }); summary.shots++;
        const r = await page.evaluate(({ strict }) => {
          const res = { sideways: document.documentElement.scrollWidth > innerWidth + 1, spill: [], small: [], tight: [], raw: [] };
          const visible = (e) => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return b.width > 0 && b.height > 0 && s.visibility !== "hidden" && s.display !== "none" && b.bottom > 0 && b.top < innerHeight; };
          const inHScroll = (e) => { for (let p = e.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
          const label = (e) => (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 40);
          for (const e of document.querySelectorAll("body *")) {
            if (!visible(e)) continue;
            const b = e.getBoundingClientRect();
            if (b.right > innerWidth + 1 && e.childElementCount === 0 && (e.textContent ?? "").trim() && !inHScroll(e)) res.spill.push(label(e));
            const role = e.getAttribute("role");
            if (role && /^(button|link|tab|radio|checkbox|switch)$/.test(role) && (b.width < 43.5 || b.height < 43.5)) res.small.push(`${label(e)} ${Math.round(b.width)}x${Math.round(b.height)}`);
            if (e.childElementCount === 0 && /[\u0900-\u097F]/.test(e.textContent ?? "")) {
              const s = getComputedStyle(e); const fs = parseFloat(s.fontSize); const lhv = s.lineHeight === "normal" ? fs * 1.4 : parseFloat(s.lineHeight);
              if (lhv < fs * 1.3) res.tight.push(`${label(e)} ${fs}/${lhv}`);
              if (s.overflow === "hidden" && e.scrollHeight > e.clientHeight + 2 && !s.webkitLineClamp && s.textOverflow !== "ellipsis") res.tight.push(`clipped: ${label(e)}`);
            }
            if (e.childElementCount === 0 && /\bm\.[a-z0-9_]+\.[a-z0-9_]+\b/.test(e.textContent ?? "")) res.raw.push(label(e));
          }
          return res;
        }, { strict: true });
        summary.checks++;
        if (r.sideways) problems.push(`${name} ${tag}: scrolls sideways`);
        if (r.spill.length) problems.push(`${name} ${tag}: spills past the edge: ${[...new Set(r.spill)].slice(0, 3).join(" | ")}`);
        if (r.raw.length) problems.push(`${name} ${tag}: raw key on screen: ${r.raw.slice(0, 3).join(" | ")}`);
        if (r.tight.length) problems.push(`${name} ${tag}: Devanagari line height: ${[...new Set(r.tight)].slice(0, 3).join(" | ")}`);
        if (r.small.length) (NEW.has(name) ? problems : notes).push(`${name} ${tag}: small tap targets: ${[...new Set(r.small)].slice(0, 4).join(" | ")}`);
        if (width === 390) {
          const ax = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze(); summary.axeRuns++;
          const serious = ax.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
          if (serious.length) problems.push(`${name} ${tag}: axe ${serious.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 80)).join(" | ")}`).join("; ")}`);
        }
      } catch (e) { problems.push(`${name} ${tag}: ${String(e).split("\n")[0].slice(0, 160)}`); }
    }
    if (errors.length) problems.push(`${tag}: page errors ${errors.slice(0, 2).join(" | ").slice(0, 300)}`);
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
writeFileSync(`${out}/report.json`, JSON.stringify({ summary, problems, notes }, null, 1));
console.log(JSON.stringify(summary));
console.log(problems.length ? `PROBLEMS ${problems.length}\n${problems.slice(0, 60).join("\n")}` : "OK no problems");
console.log(`NOTES ${notes.length}`);

// MPAR3: Calendar, meeting notes, compose extras, folders and bulk select, the shared inbox, plus the older screens
// MB-361 touched, on the web build with the sample workspace. 375, 390 and 430 wide, light, dark and Forest, en, ne, hi.
// Checks: no sideways scroll, nothing past the edge, 44 px tap targets (new screens strict), Devanagari not clipped or
// tight, no raw keys, axe wcag2a/aa serious at 390, and axe label-content-name-mismatch (MB-361) at 390.
// Usage: node scripts/mpar3-screens.mjs <web-export-dir> <out-dir> [--only=ne] [--widths=390] [--shots=390]
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const dir = process.argv[2] ?? "dist-web";
const out = process.argv[3] ?? "screens";
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const shotWidths = (process.argv.find((a) => a.startsWith("--shots="))?.slice(8) ?? "375,390,430").split(",").map(Number);
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
const tabIn = (n) => async (page) => { await page.getByRole("tab").nth(n).click(); await page.waitForTimeout(700); };
const tap = (id) => async (page) => { await page.getByTestId(id).filter({ visible: true }).first().click(); await page.waitForTimeout(900); };
const NEW = new Set(["calendar", "calendar-week", "calendar-agenda", "calendar-add", "calendar-settings", "meeting-notes", "one-inbox", "compose", "compose-later", "compose-replies", "compose-secure", "inbox-select", "inbox-folders", "thread", "meetings"]);
const SCREENS = [
  ["calendar", "/calendar", "calendar-screen"], ["calendar-week", "/calendar", "calendar-screen", tabIn(1)], ["calendar-agenda", "/calendar", "calendar-screen", tabIn(2)],
  ["calendar-add", "/calendar", "calendar-screen", tap("calendar-add")],
  ["calendar-settings", "/calendar-settings", "calendar-settings-screen"], ["meeting-notes", "/meeting-notes/mtg_s1", "meeting-notes-screen"],
  ["meetings", "/meetings", null], ["one-inbox", "/one-inbox", "one-inbox-screen"],
  ["compose", "/compose", "compose-extras"], ["compose-later", "/compose", "compose-extras", tap("compose-later")], ["compose-replies", "/compose", "compose-extras", tap("compose-replies")],
  ["compose-secure", "/compose", "compose-extras", tap("compose-secure")],
  ["inbox", "/inbox", null], ["inbox-select", "/inbox", null, tap("inbox-select")], ["inbox-folders", "/inbox", null, async (page) => { await page.getByRole("button", { name: /^(Folders|फोल्डर|फ़ोल्डर)$/ }).first().click(); await page.waitForTimeout(900); }],
  ["thread", "/thread/msg_1", "thread-team"],
  ["today", "/today", "today-hero"], ["chat", "/chat", null], ["tasks", "/tasks", null], ["more", "/more", null], ["settings", "/settings", "settings-screen"],
  ["account", "/account", "account-screen"], ["get-started", "/get-started", "started-count"],
];
const COMBOS = [];
for (const lang of ["en", "ne", "hi"]) for (const look of ["light", "dark", "forest"]) COMBOS.push({ lang, look });
const heights = { 375: 812, 390: 844, 430: 932 };
const problems = [], notes = [], mismatch = [], starts = [];
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
    // The web build opens on the sign-in screen; the sample workspace is one tap away and stays for the session.
    const explore = page.getByTestId("sample").first();
    if (await explore.isVisible().catch(() => false)) { await explore.click(); await page.waitForTimeout(2500); }
    for (const [name, path, id, act] of SCREENS) {
      try {
        await page.goto(`${base}${path}`);
        if (id) await page.getByTestId(id).filter({ visible: true }).first().waitFor(); else await page.waitForTimeout(1800);
        await page.waitForTimeout(600);
        if (act) await act(page);
        if (shotWidths.includes(width)) { await page.screenshot({ path: `${out}/${name}-${tag}.png` }); summary.shots++; }
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
            const rowTaps = role === "switch" && (() => { for (let p = e.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) { const pb = p.getBoundingClientRect(); if (getComputedStyle(p).cursor === "pointer" && pb.height >= 43.5 && pb.width >= 43.5) return true; } return false; })();
            if (role && !rowTaps && /^(button|link|tab|radio|checkbox|switch)$/.test(role) && (b.width < 43.5 || b.height < 43.5)) res.small.push(`${label(e)} ${Math.round(b.width)}x${Math.round(b.height)}`);
            if (e.childElementCount === 0 && /[\u0900-\u097F]/.test(e.textContent ?? "")) {
              const s = getComputedStyle(e); const fs = parseFloat(s.fontSize); const lhv = s.lineHeight === "normal" ? fs * 1.4 : parseFloat(s.lineHeight);
              if (lhv < fs * 1.3) res.tight.push(`${label(e)} ${fs}/${lhv}`);
              if (s.overflow === "hidden" && e.scrollHeight > e.clientHeight + 2 && !s.webkitLineClamp && s.textOverflow !== "ellipsis") res.tight.push(`clipped: ${label(e)}`);
            }
            if (e.childElementCount === 0 && /\bm\.[a-z0-9_]+\.[a-z0-9_]+\b/.test(e.textContent ?? "")) res.raw.push(label(e));
          }
          // MB-361 as the brief words it: the accessible name starts with the first words the control shows.
          res.starts = [];
          for (const e of document.querySelectorAll("[aria-label][role=button],[aria-label][role=tab],[aria-label][role=checkbox],[aria-label][role=link]")) {
            if (!visible(e)) continue;
            const leaves = [...e.querySelectorAll("*")].filter((x) => x.childElementCount === 0 && (x.textContent ?? "").trim() && visible(x) && !x.closest("[aria-hidden=true]"));
            const first = leaves.map((x) => x.textContent.trim()).find((t) => !/^[A-Z]{1,3}$/.test(t) && !/^\d+$/.test(t) && !/^[#@]$/.test(t));
            if (!first) continue;
            const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
            if (!norm(e.getAttribute("aria-label")).startsWith(norm(first).slice(0, 24))) res.starts.push(`${e.getAttribute("aria-label").slice(0, 50)} | shows ${first.slice(0, 30)}`);
          }
          return res;
        }, { strict: true });
        summary.checks++;
        if (r.sideways) problems.push(`${name} ${tag}: scrolls sideways`);
        if (r.spill.length) problems.push(`${name} ${tag}: spills past the edge: ${[...new Set(r.spill)].slice(0, 3).join(" | ")}`);
        for (const x of r.starts ?? []) starts.push(`${name} ${tag}: ${x}`);
        if (r.raw.length) problems.push(`${name} ${tag}: raw key on screen: ${r.raw.slice(0, 3).join(" | ")}`);
        if (r.tight.length) problems.push(`${name} ${tag}: Devanagari line height: ${[...new Set(r.tight)].slice(0, 3).join(" | ")}`);
        r.small = r.small.filter((x) => !/^\S+@\S+\.\S+ /.test(x));
        if (r.small.length) (NEW.has(name) ? problems : notes).push(`${name} ${tag}: small tap targets: ${[...new Set(r.small)].slice(0, 4).join(" | ")}`);
        if (width === 390) {
          const ax = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze(); summary.axeRuns++;
          const serious = ax.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
          const lm = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch"]).analyze();
          for (const v of lm.violations) for (const n of v.nodes) {
            const seen = await page.locator(String(n.target[0])).first().evaluate((e) => [e.getAttribute("aria-label"), e.innerText.replace(/\s+/g, " ").trim()]).catch(() => ["?", "?"]);
            mismatch.push(`${name} ${tag}: name=${JSON.stringify(seen[0])} text=${JSON.stringify(seen[1]).slice(0, 120)} id=${(n.html.match(/data-testid="([^"]+)"/) ?? [])[1] ?? ""}`);
          }
          if (serious.length) problems.push(`${name} ${tag}: axe ${serious.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 80)).join(" | ")}`).join("; ")}`);
        }
      } catch (e) { problems.push(`${name} ${tag}: ${String(e).split("\n")[0].slice(0, 160)}`); }
    }
    if (errors.length) problems.push(`${tag}: page errors ${errors.slice(0, 2).join(" | ").slice(0, 300)}`);
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
writeFileSync(`${out}/report.json`, JSON.stringify({ summary, problems, notes, mismatch, starts }, null, 1));
console.log(JSON.stringify(summary));
console.log(problems.length ? `PROBLEMS ${problems.length}\n${problems.slice(0, 60).join("\n")}` : "OK no problems");
console.log(`NOTES ${notes.length}`);
console.log(`LABEL_IN_NAME axe ${mismatch.length}, name does not start with the shown words ${starts.length}`);

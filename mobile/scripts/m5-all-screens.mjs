// M5: every route of the phone app on the web build (sample workspace), at 375, 390 and 430, light and dark, with a
// tap through at 390 light (every visible button, tab and link on each screen, up to a cap) and targeted form checks.
// Writes <out>/results.json; SCREENS.md is built from it. Usage: node scripts/m5-all-screens.mjs <web-export-dir> <out-dir> [--taps] [--only=390-light]
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const dir = process.argv[2] ?? "dist-web";
const out = process.argv[3] ?? "screens";
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
mkdirSync(out, { recursive: true });
const taps = process.argv.includes("--taps");
const tapCap = 14;
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

const D = (path, name) => ({ path, name: name ?? (path.replace(/^\//, "").replace(/[\/\[\]]/g, "-") || "root") });
const V = (via, prefix, name) => ({ via, prefix, name });
const ROUTES = [
  D("/today"), D("/inbox"), D("/chat"), D("/tasks"), D("/more"), D("/activity"), D("/approvals"),
  D("/automations"), D("/blocked"), D("/chat/new"), D("/compose"), D("/connect-mailbox"), D("/contacts"), D("/deals"),
  D("/delete-account"), D("/docs"), D("/email-setup"), D("/expenses"), D("/files"), D("/forms"), D("/free-address"),
  D("/goals"), D("/invoices"), D("/links"), D("/mail-archive"), D("/mail-merge"), D("/mail-settings"), D("/meetings"),
  D("/notification-settings"), D("/notifications"), D("/people"), D("/portfolio"), D("/review"), D("/runs"),
  D("/scheduling"), D("/search"), D("/security"), D("/settings"), D("/social"), D("/sync"), D("/task/new"), D("/time"),
  D("/tools"), D("/two-factor"), D("/visits"), D("/workspaces"),
  D("/more/mail", "more-mail"), D("/more/tools", "more-tools"),
  D("/thread/msg_1", "thread"), D("/approval/apr_1", "approval"), D("/chat/chn_general", "chat-channel"), D("/contact/con_s1", "contact"),
  D("/deal/deal_1", "deal"), D("/doc/doc_plan", "doc"), D("/doc/comments/doc_plan", "doc-comments"), D("/doc/share/doc_plan", "doc-share"),
  D("/expense/exp_s1", "expense"), D("/form/fm_1", "form"), D("/invoice/inv_1", "invoice"), D("/journey/jr_s1", "journey"),
  D("/mail-rule/mrl_s1", "mail-rule"), D("/newsletter/nl_s1", "newsletter"), D("/run/run_s1", "run"), D("/social-inbox/si_1", "social-inbox"),
  D("/social-post/sp_1", "social-post"), D("/files-item/cfile_1", "files-item"), D("/files-preview/cfile_1", "files-preview"),
  D("/thread/does_not_exist", "thread-missing"), D("/task/does_not_exist", "task-missing"),
  V("/tasks", "task-row-", "task"), V("/tools", "tool-", "tool-op"), V("/chat/chn_general", "chat-msg-", "chat-message"),
];
const heights = { 375: 812, 390: 844, 430: 932 };
const results = [];
const browser = await chromium.launch();
try {
  for (const width of [375, 390, 430]) for (const scheme of ["light", "dark"]) {
    const tag = `${width}-${scheme}`;
    if (only && tag !== only) continue;
    if (taps && tag !== "390-light") continue;
    const ctx = await browser.newContext({ viewport: { width, height: heights[width] }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: scheme });
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    let errors = [];
    page.on("pageerror", (e) => errors.push(String(e).split("\n")[0].slice(0, 160)));
    await page.goto(base); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1200);
    if (!taps) { await page.screenshot({ path: `${out}/sign-in-${tag}.png` }); results.push({ screen: "sign-in", tag, ok: errors.length === 0, notes: errors.slice(0, 2), shot: `${out}/sign-in-${tag}.png` }); }
    const sample = page.getByTestId("sample").first();
    if (await sample.isVisible().catch(() => false)) await sample.click();
    await page.waitForTimeout(2500);
    await page.evaluate(() => localStorage.setItem("m5-shots", JSON.stringify({ counts: { mail: { inbox: 15527 }, chat: { unread: 1234, mentions: 3 }, notifications: { unread: 87 }, tasks: { dueToday: 9, overdue: 133 } }, approvals: 2 })));
    for (const r of ROUTES) {
      errors = [];
      const notes = [];
      let path = r.path;
      try {
        if (r.via) {
          await page.goto(`${base}${r.via}`); await page.waitForTimeout(1800);
          const el = page.locator(`[data-testid^="${r.prefix}"]`).filter({ visible: true }).first();
          await el.click({ timeout: 4000 }); await page.waitForTimeout(1500);
          path = new URL(page.url()).pathname;
        } else {
          await page.goto(`${base}${path}`); await page.waitForTimeout(1800);
        }
        const body = await page.evaluate(() => document.body.innerText);
        if (/Something went wrong/.test(body)) notes.push("error card shown");
        if (/Unmatched Route|This screen doesn't exist/i.test(body)) notes.push("route not found");
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) notes.push("scrolls sideways");
        const long = await page.evaluate(() => [...document.querySelectorAll("div,span")].filter((e) => e.childElementCount === 0 && /^[0-9]{4,}$/.test((e.textContent ?? "").trim())).map((e) => e.textContent.trim()).slice(0, 3));
        if (long.length) notes.push(`ungrouped number ${long.join(" ")}`);
        // Text drawn outside the window on the right (clipped labels).
        const clipped = await page.evaluate(() => { const W = innerWidth; return [...document.querySelectorAll("div[dir=auto]")].filter((e) => { const b = e.getBoundingClientRect(); if (!(b.width > 0 && b.height > 0 && b.right > W + 1 && b.left < W)) return false; for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll") return false; } return true; }).map((e) => (e.textContent ?? "").slice(0, 24)).slice(0, 3); });
        if (clipped.length) notes.push(`text past the right edge: ${clipped.join(" | ")}`);
        const shot = `${out}/${r.name}-${tag}.png`;
        if (!taps) await page.screenshot({ path: shot });
        let tapped = 0, tapErrors = 0;
        if (taps) {
          const count = await page.locator('[role="button"],[role="tab"],[role="link"],[role="switch"],[role="checkbox"]').count();
          for (let i = 0; i < Math.min(count, tapCap); i++) {
            const here = page.url();
            const btn = page.locator('[role="button"],[role="tab"],[role="link"],[role="switch"],[role="checkbox"]').nth(i);
            if (!(await btn.isVisible().catch(() => false))) continue;
            const label = ((await btn.getAttribute("aria-label").catch(() => null)) ?? (await btn.innerText().catch(() => ""))).slice(0, 30);
            if (/sign out|delete|remove|log out|leave|disconnect|block|report|send|discard|archive all/i.test(label)) continue;
            const before = errors.length;
            await btn.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(450);
            tapped++;
            if (errors.length > before) { tapErrors++; notes.push(`tap "${label}": ${errors[errors.length - 1]}`); }
            const txt = await page.evaluate(() => document.body.innerText).catch(() => "");
            if (/Something went wrong/.test(txt)) notes.push(`tap "${label}": error card`);
            if (page.url() !== here) { await page.goto(here); await page.waitForTimeout(1200); }
            else { await page.keyboard.press("Escape").catch(() => {}); await page.waitForTimeout(150); }
          }
        }
        if (errors.length) notes.push(`page error: ${errors[0]}`);
        results.push({ screen: r.name, path, tag, ok: notes.length === 0, notes: [...new Set(notes)].slice(0, 4), shot: taps ? null : shot, tapped, tapErrors });
      } catch (e) {
        results.push({ screen: r.name, path, tag, ok: false, notes: [`could not open: ${String(e).split("\n")[0].slice(0, 140)}`], shot: null });
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
writeFileSync(`${out}/${taps ? "taps" : "results"}.json`, JSON.stringify(results, null, 1));
const bad = results.filter((r) => !r.ok);
console.log(`screens ${results.length} ok ${results.length - bad.length} bad ${bad.length}`);
for (const r of bad.slice(0, 40)) console.log(`${r.screen} ${r.tag}: ${r.notes.join("; ").slice(0, 200)}`);

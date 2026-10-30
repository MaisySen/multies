// Dogfood tour: signs in to the dogfood workspace and walks the main screens at desktop and phone
// widths in light and dark, recording console errors, failed requests, horizontal overflow and
// the page heading, plus a screenshot of each. Run against the local node server:
//   BASE=http://localhost:8796 EMAIL=... PASSWORD=... WORKSPACE="Example Startup HQ" OUT=/tmp/dogfood/tour node e2e/dogfood-tour.mjs
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:8796";
const OUT = process.env.OUT ?? "/tmp/dogfood/tour";
const PAGES = (process.env.PAGES ?? "inbox,mail,chat,tasks,goals,docs,meetings,team,settings,agents,templates,notifications,integrations,portfolio").split(",");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const report = [];
for (const [label, width, height, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, colorScheme: scheme });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
    page.on("response", (r) => { if (r.status() >= 400 && r.url().startsWith(BASE)) errors.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`); });
    await page.goto(`${BASE}/login`);
    const res = await page.evaluate(async ({ email, password, ws }) => {
      const j = (r) => r.json().catch(() => ({}));
      const h = { "content-type": "application/json" };
      await fetch("/api/auth/sign-in/email", { method: "POST", headers: h, body: JSON.stringify({ email, password }) });
      const list = await j(await fetch("/api/account/workspaces"));
      const w = (list.workspaces ?? []).find((x) => x.name === ws);
      if (w) await fetch(`/api/account/workspaces/${w.id}/switch`, { method: "POST", headers: h, body: "{}" });
      return { ok: !!w };
    }, { email: process.env.EMAIL, password: process.env.PASSWORD, ws: process.env.WORKSPACE });
    if (!res.ok) throw new Error("workspace not found");
    for (const p of PAGES) {
      errors.length = 0;
      const path = p === "settings" ? "/app/settings/account" : p === "team" ? "/app/settings/team" : `/app/${p}`;
      await page.goto(BASE + path);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(400);
      const info = await page.evaluate(() => ({
        h1: [...document.querySelectorAll("h1")].map((e) => e.textContent?.trim()).join(" | "),
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        url: location.pathname,
        title: document.title,
      }));
      const file = `${OUT}/${label}-${scheme}-${p}.png`;
      await page.screenshot({ path: file });
      report.push({ label, scheme, page: p, ...info, errors: [...new Set(errors)] });
    }
    await ctx.close();
  }
}
await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`${report.length} views, report at ${OUT}/report.json`);


import { chromium } from "@playwright/test";
// R38 premium pass 3: before and after shots of the screens that still look plain.
const [,, phase, only] = process.argv;
const OUT = (process.env.SHOTS_ROOT || "/home/user/tab/files") + "/multies-r38";
const base = process.env.BASE || "http://localhost:8976";
const PAGES = [
  ["settings", "/app/settings"], ["team", "/app/settings/team"], ["billing", "/app/settings/billing"], ["account", "/app/settings/account"],
  ["notifications", "/app/settings/notifications"], ["calendar-settings", "/app/settings/calendar"], ["import", "/app/settings/import"],
  ["signup-emails", "/app/settings/sign-up-emails"], ["developers", "/app/settings/developers"], ["domain", "DOMAIN"], ["operator", "/app/admin"], ["operator-reports", "/app/admin/reports"],
].filter(([n]) => !only || only.split(",").includes(n));
const browser = await chromium.launch();
try {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: w === 390 ? 2 : 1, hasTouch: w === 390, isMobile: w === 390 });
      await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.138.${w % 200}.${scheme === "light" ? 1 : 2}` });
      await ctx.addInitScript((s) => { try { localStorage.setItem("mymail-theme", s); } catch { /* blocked */ } }, scheme);
      const page = await ctx.newPage(); page.setDefaultTimeout(15000);
      await page.goto(base + "/login");
      await page.getByRole("button", { name: "Explore a demo workspace" }).click();
      await page.waitForURL(/\/app/, { timeout: 45000 });
      const tag = w === 390 ? "phone" : "desktop";
      let domainId = null;
      for (const [name, p0] of PAGES) {
        let p = p0;
        if (p === "DOMAIN") {
          if (!domainId) { const r = await page.request.get(base + "/api/domains"); const j = await r.json().catch(() => ({})); domainId = (j.domains ?? [])[0]?.id ?? null; }
          if (!domainId) continue; p = `/app/domains/${domainId}`;
        }
        await page.goto(base + p);
        await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${OUT}/web-${phase}-${name}-${tag}-${scheme}.png`, fullPage: w !== 390 });
      }
      await ctx.close();
    }
  }
} finally { await browser.close(); }
console.log("done", PAGES.length);

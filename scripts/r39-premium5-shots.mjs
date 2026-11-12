
import { chromium } from "@playwright/test";
// R39 premium pass 5: before and after shots of mailboxes, team, deliverability and connections.
const [,, phase, only] = process.argv;
const OUT = (process.env.SHOTS_ROOT || "/home/user/tab/files") + "/multies-r39";
const base = process.env.BASE || "http://localhost:8983";
const PAGES = [
  ["mailboxes", "/app/mailboxes"], ["team", "/app/settings/team"], ["deliverability", "/app/deliverability"], ["connections", "/app/settings/connections"],
].filter(([n]) => !only || only.split(",").includes(n));
const browser = await chromium.launch();
try {
  for (const [w, h] of [[1280, 800], [390, 844]]) {
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: w === 390 ? 2 : 1, hasTouch: w === 390, isMobile: w === 390 });
      await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.141.${w % 200}.${scheme === "light" ? 1 : 2}` });
      await ctx.addInitScript((s) => { try { localStorage.setItem("mymail-theme", s); } catch { /* blocked */ } }, scheme);
      const page = await ctx.newPage(); page.setDefaultTimeout(15000);
      await page.goto(base + "/login");
      await page.getByRole("button", { name: "Explore a demo workspace" }).click();
      await page.waitForURL(/\/app/, { timeout: 45000 });
      const tag = w === 390 ? "phone" : "desktop";
      for (const [name, p0] of PAGES) {
        const p = p0;
        await page.goto(base + p);
        await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${OUT}/premium5-${phase}-${name}-${tag}-${scheme}.png`, fullPage: w !== 390 });
      }
      await ctx.close();
    }
  }
} finally { await browser.close(); }
console.log("done", PAGES.length);

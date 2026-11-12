
import { chromium } from "@playwright/test";
const [,, phase, only] = process.argv;
const OUT = (process.env.SHOTS_ROOT || "/home/user/tab/files") + "/multies-r35";
const base = "http://localhost:8962";
const screens = [
  ["home", "/app/my-work"], ["mail", "/app/mail"], ["tasks", "/app/tasks?view=list"],
  ["board", "/app/tasks?view=board"], ["chat", "/app/chat"], ["settings", "/app/settings"],
];
const browser = await chromium.launch();
try {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: w === 390 ? 2 : 1, hasTouch: w === 390, isMobile: w === 390 });
      await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.135.${w % 200}.${scheme === "light" ? 1 : 2}` });
      await ctx.addInitScript((s) => { try { localStorage.setItem("mymail-theme", s); } catch { /* storage blocked */ } }, scheme);
      const page = await ctx.newPage(); page.setDefaultTimeout(15000);
      await page.goto(base + "/login");
      await page.getByRole("button", { name: "Explore a demo workspace" }).click();
      await page.waitForURL(/\/app/, { timeout: 45000 });
      for (const [name, path] of screens) {
        if (scheme === "dark" && name !== "home") continue;
        if (only && !only.split(",").includes(name)) continue;
        await page.goto(base + path);
        await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(900);
        const tag = w === 390 ? "phone" : "desktop";
        await page.screenshot({ path: `${OUT}/web-${phase}-${name}-${tag}-${scheme}.png` });
      }
      await ctx.close();
    }
  }
} finally { await browser.close(); }
console.log("done");

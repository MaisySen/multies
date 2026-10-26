
import { chromium } from "@playwright/test";
const [,, phase] = process.argv;
const OUT = "/home/user/tab/files/multies-r36";
const base = "http://localhost:8964";
const browser = await chromium.launch();
const tagOf = (w) => (w === 390 ? "phone" : "desktop");
try {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: w === 390 ? 2 : 1, hasTouch: w === 390, isMobile: w === 390 });
      await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.136.${w % 200}.${scheme === "light" ? 1 : 2}` });
      await ctx.addInitScript((s) => { try { localStorage.setItem("mymail-theme", s); } catch { /* blocked */ } }, scheme);
      const page = await ctx.newPage(); page.setDefaultTimeout(15000);
      await page.goto(base + "/login");
      await page.getByRole("button", { name: "Explore a demo workspace" }).click();
      await page.waitForURL(/\/app/, { timeout: 45000 });
      const tag = tagOf(w);
      const snap = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/web-${phase}-${name}-${tag}-${scheme}.png` }); };
      const go = async (p) => { await page.goto(base + p); await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {}); };
      // Command menu: open on the home page with an empty query (after a couple of visits so recents exist).
      await go("/app/my-work");
      // Use the menu twice first (a page and a search result), the way a person would, so the empty menu has recents.
      const menu = async () => { await page.keyboard.press("Control+k"); await page.locator("[cmdk-input]").waitFor(); };
      await menu(); await page.keyboard.type("Go to Tasks"); await page.waitForTimeout(300); await page.keyboard.press("Enter"); await page.waitForTimeout(800);
      await menu(); await page.keyboard.type("DMARC"); await page.locator("[data-testid=search-result]").first().click({ timeout: 8000 }).catch(() => page.keyboard.press("Enter")); await page.waitForTimeout(800);
      await menu(); await page.keyboard.type("Switch light"); await page.waitForTimeout(300); await page.keyboard.press("Enter"); await page.waitForTimeout(400);
      await menu(); await page.keyboard.type("Switch light"); await page.waitForTimeout(300); await page.keyboard.press("Enter"); await page.waitForTimeout(400);
      await go("/app/my-work");
      await page.keyboard.press("Control+k").catch(() => {});
      await page.waitForTimeout(500);
      if (!(await page.locator("[cmdk-root]").count())) { await page.keyboard.press("Meta+k").catch(() => {}); }
      await snap("command-menu");
      await page.keyboard.press("Escape");
      if (scheme === "dark") { await ctx.close(); continue; }
      // Shortcuts sheet (desktop only, ? key).
      if (w === 1440) { await go("/app/my-work"); await page.locator("body").click({ position: { x: 700, y: 450 } }).catch(() => {}); await page.keyboard.press("Shift+?"); await snap("shortcuts"); await page.keyboard.press("Escape"); }
      await go("/app/tasks?view=list&q=zzzz-no-match"); await snap("tasks-empty");
      await go("/app/mail?folder=spam"); await snap("inbox-empty");
      await go("/app/tasks?view=board"); await snap("board");
      if (phase === "after" && w === 1440) {
        const card = page.locator("[data-testid=board-card]").first();
        await card.hover(); await card.locator("[data-testid=card-priority]").click(); await snap("board-card-priority");
        await page.keyboard.press("Escape"); await card.hover(); await card.locator("[data-testid=card-rename]").click(); await snap("board-card-rename");
        await page.keyboard.press("Escape");
      }
      // A list loading: hold every API response for a while.
      await page.route("**/api/**", async (r) => { await new Promise((res) => setTimeout(res, 4000)); await r.continue().catch(() => {}); });
      await page.goto(base + "/app/tasks?view=list").catch(() => {}); await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}/web-${phase}-list-loading-${tag}-${scheme}.png` });
      await page.unroute("**/api/**");
      await ctx.close();
    }
  }
} finally { await browser.close(); }
console.log("done");

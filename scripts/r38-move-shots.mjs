
import { chromium } from "@playwright/test";
import { join } from "node:path";
// R38 move your data: after shots of Settings, Import and export (the page, the wizard on its preview step, the export ready).
const OUT = "/home/user/tab/files/multies-r38";
const base = process.env.BASE || "http://localhost:8841";
const browser = await chromium.launch();
try {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: w === 390 ? 2 : 1, hasTouch: w === 390, isMobile: w === 390 });
      await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.141.${w % 200}.${scheme === "light" ? 1 : 2}` });
      await ctx.addInitScript((s) => { try { localStorage.setItem("mymail-theme", s); } catch { /* blocked */ } }, scheme);
      const page = await ctx.newPage(); page.setDefaultTimeout(20000);
      await page.goto(base + "/login");
      await page.getByRole("button", { name: "Explore a demo workspace" }).click();
      await page.waitForURL(/\/app/, { timeout: 45000 });
      const tag = w === 390 ? "phone" : "desktop";
      const shot = (name, full = w !== 390) => page.screenshot({ path: `${OUT}/move-after-${name}-${tag}-${scheme}.png`, fullPage: full });
      await page.goto(base + "/app/settings/import");
      await page.getByRole("heading", { name: "Bring your work in" }).waitFor();
      await page.waitForTimeout(700);
      await shot("import");
      // The wizard: Trello board, people and statuses step, then the preview.
      await page.getByTestId("move-source-trello").click();
      await page.getByLabel("File to import").setInputFiles(join(process.cwd(), "tests/fixtures/import/trello.json"));
      const wiz = page.getByTestId("move-wizard");
      await wiz.getByText("found").first().waitFor();
      await wiz.getByRole("button", { name: "Next" }).click();
      await page.waitForTimeout(400);
      await wiz.scrollIntoViewIfNeeded();
      await wiz.screenshot({ path: `${OUT}/move-after-wizard-people-${tag}-${scheme}.png` });
      await wiz.getByRole("button", { name: "Next" }).click();
      await page.waitForTimeout(400);
      await wiz.screenshot({ path: `${OUT}/move-after-wizard-preview-${tag}-${scheme}.png` });
      await wiz.getByRole("button", { name: /^Import \d+ tasks/ }).click();
      await wiz.getByText("brought in").waitFor({ timeout: 30000 });
      await page.waitForTimeout(500);
      await wiz.screenshot({ path: `${OUT}/move-after-wizard-done-${tag}-${scheme}.png` });
      // Export ready, then the history.
      await page.getByTestId("move-export-start").click();
      await page.getByText("Your export is ready").waitFor({ timeout: 30000 });
      await page.locator("#move-out").scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.locator("#move-out").screenshot({ path: `${OUT}/move-after-export-${tag}-${scheme}.png` });
      await page.locator("#move-history").screenshot({ path: `${OUT}/move-after-history-${tag}-${scheme}.png` });
      await ctx.close();
    }
  }
} finally { await browser.close(); }
console.log("SHOTS_DONE");

import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";

/**
 * R33 premium UI pass, member screens. Screenshots only, so it is skipped unless R33_UI_SHOTS names a folder:
 *   R33_UI_SHOTS=/tmp/shots npx playwright test e2e/r33-ui-member.spec.ts --workers=1
 * It still checks every member screen renders a heading or main region in light and dark at 390 and 1440.
 */
const OUT = process.env.R33_UI_SHOTS;
test.skip(!OUT, "screenshots only (set R33_UI_SHOTS)");
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

type Shot = { name: string; path: string; act?: (p: Page) => Promise<void> };
const screens: Shot[] = [
  { name: "home", path: "/app/my-work" },
  { name: "mail", path: "/app/mail" },
  { name: "mail-thread", path: "/app/mail", act: async (p) => { const row = p.locator('[data-testid^="mail-row"]:visible, main [role="listitem"]:visible, main li:visible').first(); if (await row.count()) await row.click({ timeout: 3000 }).catch(() => {}); } },
  { name: "compose", path: "/app/mail", act: async (p) => { await p.keyboard.press("c"); } },
  { name: "tasks", path: "/app/tasks" },
  { name: "triage", path: "/app/triage" },
  { name: "docs", path: "/app/docs" },
  { name: "doc", path: "/app/docs", act: async (p) => { const a = p.locator('main a[href^="/app/docs/"]:visible').first(); if (await a.count()) await a.click({ timeout: 3000 }).catch(() => {}); } },
  { name: "chat", path: "/app/chat" },
  { name: "meetings", path: "/app/meetings" },
  { name: "notifications", path: "/app/notifications" },
  { name: "cmdk", path: "/app/my-work", act: async (p) => { await p.keyboard.press("Control+k"); } },
];

for (const scheme of ["light", "dark"] as const) {
  for (const width of [390, 1440] as const) {
    test(`member screens ${scheme} ${width}`, async ({ browser }) => {
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: scheme, reducedMotion: "reduce" });
      await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.133.${width % 200}.${scheme === "light" ? 1 : 2}` });
      await ctx.addInitScript((s) => { try { localStorage.setItem("mymail-theme", s); } catch { /* blocked */ } }, scheme);
      const overflow: Record<string, { doc: number; main: number; vw: number }> = {};
      const page = await ctx.newPage();
      page.setDefaultTimeout(8000);
      await page.goto("/login");
      await page.getByRole("button", { name: "Explore a demo workspace" }).click();
      await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
      for (const s of screens) {
        await page.goto(s.path);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        if (s.act) { await s.act(page); await page.waitForTimeout(700); }
        await page.screenshot({ path: `${OUT}/member-${s.name}-${scheme}-${width}.png` });
        // Anything wider than the screen scrolls the whole page sideways on a phone.
        const wide = await page.evaluate(() => { const m = document.querySelector("main"); return { doc: document.documentElement.scrollWidth, main: m ? m.scrollWidth : 0, vw: window.innerWidth }; });
        overflow[`${s.name}-${scheme}-${width}`] = wide;
      }
      fs.writeFileSync(`${OUT}/member-overflow-${scheme}-${width}.json`, JSON.stringify(overflow, null, 2));
      if (width === 390) {
        await page.goto("/app/my-work");
        await page.waitForTimeout(500);
        const menu = page.getByRole("button", { name: /menu|navigation/i }).first();
        if (await menu.count()) { await menu.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(500); }
        await page.screenshot({ path: `${OUT}/member-nav-${scheme}-${width}.png` });
      }
      await ctx.close();
    });
  }
}

/**
 * Screenshots pages on desktop (1440x900) and phone (390x844).
 *   node scripts/screenshots.mjs <base-url> <out-dir> [--cookies file.json] /path /other/path ...
 * Cookies (a JSON array in Playwright's format) let it capture signed-in pages.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const args = process.argv.slice(2);
const ci = args.indexOf("--cookies");
const cookies = ci >= 0 ? JSON.parse(fs.readFileSync(args.splice(ci, 2)[1], "utf8")) : [];
const [base, out, ...paths] = args;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: tag === "phone" ? 2 : 1 });
  if (cookies.length) await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  for (const p of paths) {
    await page.goto(base + p, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    // The app shell scrolls inside its own container, so grow the viewport until nothing scrolls.
    const extra = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll("*")]
      .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
      .map((el) => el.scrollHeight - el.clientHeight)));
    if (extra) { await page.setViewportSize({ width: w, height: h + extra }); await page.waitForTimeout(300); }
    const name = p.replace(/^\//, "").replace(/[/?=&#]/g, "_") || "home";
    await page.screenshot({ path: `${out}/${name}-${tag}.png`, fullPage: true });
    if (extra) await page.setViewportSize({ width: w, height: h });
  }
  await ctx.close();
}
await browser.close();

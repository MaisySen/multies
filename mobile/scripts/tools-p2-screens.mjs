// Screenshots of Tools P2 (1.9.13) on the web build with the sample workspace, at 390 wide.
// Usage: node scripts/tools-p2-screens.mjs http://localhost:8797 <out-dir> [light|dark]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8797";
const out = process.argv[3] ?? "screens";
const colorScheme = process.argv[4] ?? "light";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const shot = async (name, full = false) => { await page.waitForTimeout(700); await page.screenshot({ path: `${out}/${name}-${colorScheme}.png`, fullPage: full }); console.log("shot", name); };
const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
const overflow = async (name) => { const w = await page.evaluate(() => document.documentElement.scrollWidth); if (w > 390) console.log("OVERFLOW", name, w); };

await page.goto(base);
await page.waitForLoadState("networkidle");
await tid("sample").click();
await page.waitForTimeout(2500);

await page.goto(`${base}/tools`);
await tid("tool-compress").waitFor({ timeout: 20000 });
await shot("tools-landing"); await overflow("landing");
await page.evaluate(() => window.scrollTo(0, 900));
await page.mouse.wheel(0, 900);
await shot("tools-landing-scrolled");

await page.goto(`${base}/tools`);
await tid("tools-search").fill("password");
await shot("tools-search");

await page.goto(`${base}/tool/compress`);
await tid("tool-add-files").waitFor();
await shot("tool-compress-empty"); await overflow("compress-empty");
await tid("tool-add-files").click();
await page.getByText("Quarterly report 1.pdf").first().waitFor();
await shot("tool-compress-ready");
await tid("tool-run").click();
await tid("tool-progress").waitFor({ timeout: 5000 }).catch(() => {});
await shot("tool-compress-progress");
await tid("tool-done").waitFor({ timeout: 15000 });
await shot("tool-compress-result"); await overflow("compress-result");

await page.goto(`${base}/tool/stamp`);
await tid("tool-add-files").click();
await page.getByText("Quarterly report 1.pdf").first().waitFor();
await tid("tool-more").click().catch(() => {});
await shot("tool-stamp-options", true);

await page.goto(`${base}/tool/ocr`);
await tid("tool-add-files").click();
await page.getByText("Quarterly report 1.pdf").first().waitFor();
await shot("tool-ocr-options");

await page.goto(`${base}/tool/merge`);
await tid("tool-add-files").click();
await tid("tool-add-files").click();
await page.getByText("Quarterly report 2.pdf").first().waitFor();
await shot("tool-merge-files");

await page.goto(`${base}/tool/pii-find`);
await tid("tool-add-files").click();
await page.getByText("Quarterly report 1.pdf").first().waitFor();
await tid("tool-run").click();
await tid("tool-review").waitFor({ timeout: 15000 });
await shot("tool-autoredact-review");

await page.goto(`${base}/tool/compress`);
await tid("tool-add-mail").click();
await tid("tool-mail-sheet").waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);
await shot("tool-from-email");

await page.goto(`${base}/tool/organize`);
await page.getByText("works on the web").first().waitFor({ timeout: 10000 });
await shot("tool-web-only");

await page.goto(`${base}/thread/${process.argv[5] ?? "msg_3"}`);
await page.waitForTimeout(2500);
const att = page.getByTestId(/^attachment-/).filter({ visible: true }).first();
if (await att.count()) { await att.click(); await tid("attachment-tools").waitFor({ timeout: 5000 }).catch(() => {}); await shot("thread-attachment-tools"); }

console.log(errors.length ? `page errors: ${errors.join(" | ")}` : "no page errors");
await browser.close();

// Screenshots of Tools (1.9.12) on the web build with the sample workspace.
// Usage: node scripts/tools-screens.mjs http://localhost:8791 <out-dir> [light|dark]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8791";
const out = process.argv[3] ?? "screens";
const colorScheme = process.argv[4] ?? "light";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const shot = async (name) => { await page.waitForTimeout(800); await page.screenshot({ path: `${out}/${name}-${colorScheme}.png` }); console.log("shot", name); };
const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();

await page.goto(base);
await page.waitForLoadState("networkidle");
await tid("sample").click();
await page.waitForTimeout(2500);

await page.goto(`${base}/settings`);
await tid("tools-link").waitFor({ timeout: 20000 });
await shot("settings-tools-row");

await tid("tools-link").click();
await tid("tool-compress").waitFor();
await shot("tools-list");

await page.goto(`${base}/tool/watermark`);
await tid("tool-add-files").waitFor();
await tid("tool-add-files").click();
await page.getByText("Quarterly report 1.pdf").first().waitFor();
await shot("tool-watermark-options");

await page.goto(`${base}/tool/merge`);
await tid("tool-add-files").click();
await tid("tool-add-files").click();
await page.getByText("Quarterly report 2.pdf").first().waitFor();
await tid("tool-run").click();
await tid("tool-done").waitFor({ timeout: 15000 });
await shot("tool-merge-done");

await page.goto(`${base}/thread/${process.argv[5] ?? "msg_1"}`);
await page.getByText("remittance-advice.pdf").first().waitFor({ timeout: 15000 });
await page.getByText("remittance-advice.pdf").first().click();
await tid("attachment-tools").waitFor();
await shot("thread-attachment-tools");

console.log(errors.length ? `page errors: ${errors.join(" | ")}` : "no page errors");
await browser.close();

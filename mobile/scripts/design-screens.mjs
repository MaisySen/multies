// Phone size screenshots of the main screens from the web export, for design before and after.
// Usage: node scripts/design-screens.mjs http://localhost:8793 <out dir> <prefix> [dark|light]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const [base, out, prefix, scheme = "dark"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: scheme });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const byText = (t) => page.getByText(t, { exact: true }).filter({ visible: true }).first();
const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
const shot = async (name) => { await page.waitForTimeout(900); await page.screenshot({ path: `${out}/${prefix}-${name}.png` }); console.log(`${prefix}-${name}.png`); };
await page.goto(base); await page.waitForLoadState("networkidle");
await shot("sign-in");
await tid("sample").click();
await byText("Wholesale order for Saturday markets").waitFor();
await shot("mail");
await page.goto(`${base}/chat`); await tid("channel-chn_general").waitFor(); await shot("chat-list");
await tid("channel-chn_general").click(); await page.getByText(/12 kg house blend is packed/).filter({ visible: true }).first().waitFor(); await shot("chat-channel");
await page.goto(`${base}/notifications`); await byText("Josh Tran mentioned you in #general").waitFor(); await shot("notifications");
await page.goto(`${base}/tasks`); await byText("Confirm Saturday wholesale order with Bondi Bakehouse").waitFor(); await shot("tasks");
await byText("Confirm Saturday wholesale order with Bondi Bakehouse").click(); await page.waitForTimeout(800); await shot("task");
await page.goto(`${base}/settings`); await page.waitForTimeout(800); await shot("settings");
console.log("errors:", JSON.stringify(errors.slice(0, 5)));
await browser.close();

// Phone size screenshots of a chat channel (a mention and a task chip) and the notifications inbox, from the web export.
// Usage: node scripts/chat-screens.mjs http://localhost:8793 <out dir>
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
const base = process.argv[2]; const out = process.argv[3];
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: "dark" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const byText = (t) => page.getByText(t, { exact: true }).filter({ visible: true }).first();
const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
async function shot(name) {
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${name}.png` });
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  console.log(`${name}: ${serious.length ? serious.map((v) => `${v.id}(${v.nodes.map((n) => n.html.slice(0, 160)).join(" | ")})`).join(", ") : "no serious axe issues"}`);
}
await page.goto(base); await page.waitForLoadState("networkidle");
await tid("sample").click();
await byText("Wholesale order for Saturday markets").waitFor();
await page.goto(`${base}/chat`);
await tid("channel-chn_general").waitFor();
await shot("chat-list-phone-app");
await tid("channel-chn_general").click();
await page.getByText(/12 kg house blend is packed/).filter({ visible: true }).first().waitFor();
await shot("chat-phone-app");
await page.goto(`${base}/notifications`);
await byText("Josh Tran mentioned you in #general").waitFor();
await shot("inbox-phone-app");
console.log("errors:", JSON.stringify(errors.slice(0, 5)));
await browser.close();

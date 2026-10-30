// Phone size screenshots of custom fields on a task and the Portfolio list, from the web export.
// Usage: node scripts/fields-portfolio-screens.mjs http://localhost:8792 <out dir>
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
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png` });
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  console.log(`${name}: ${serious.length ? serious.map((v) => `${v.id}(${v.nodes.map((n) => n.html.slice(0, 160)).join(" | ")})`).join(", ") : "no serious axe issues"}`);
}
await page.goto(base); await page.waitForLoadState("networkidle");
await tid("sample").click();
await byText("Wholesale order for Saturday markets").waitFor();
await page.goto(`${base}/tasks`);
await byText("Confirm Saturday wholesale order with Bondi Bakehouse").click();
await tid("custom-fields").waitFor();
// Bring the Fields section to the top of the screen, under the header.
await page.evaluate(() => {
  const el = document.querySelector('[data-testid="custom-fields"]');
  let p = el?.parentElement;
  while (p && !(p.scrollHeight > p.clientHeight + 10 && getComputedStyle(p).overflowY !== "visible")) p = p.parentElement;
  if (el && p) p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - 40;
});
await shot("custom-fields-phone-app");
await page.goto(`${base}/portfolio`);
await byText("Operations").waitFor();
await shot("portfolio-phone-app");
console.log("errors:", JSON.stringify(errors.slice(0, 5)));
await browser.close();

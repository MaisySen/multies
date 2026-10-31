// 1.10.5: screenshots of Social (Posts, New post, Accounts) on the web build with the sample workspace,
// with an axe check on each. Usage: node scripts/social-screens.mjs http://localhost:8791 <out-dir> [light|dark]
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8791";
const out = process.argv[3] ?? "screens";
const colorScheme = process.argv[4] ?? "light";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
async function shot(name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/social-${name}-${colorScheme}.png` });
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  console.log(`${name} ${colorScheme}: ${serious.length ? serious.map((v) => `${v.id}(${v.nodes.length})`).join(", ") : "no serious axe issues"}`);
}
const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();

await page.goto(base);
await page.waitForLoadState("networkidle");
if (await page.getByTestId("sample").first().isVisible().catch(() => false)) await tid("sample").click();
await page.waitForTimeout(2500);

await page.goto(`${base}/settings`);
await tid("social-link").waitFor();
await tid("social-link").click();
await page.getByText("Partly posted").first().waitFor();
await shot("posts");

await page.getByRole("tab", { name: "New post" }).first().click();
await tid("social-text").waitFor();
await tid("social-text").fill("Fresh sourdough this Saturday at the wharf market.");
await tid("pick-facebook").click();
await page.getByText("Harbour Bakery Events").first().waitFor();
await page.getByText("Harbour Bakery Events").first().click();
await tid("pick-linkedin").click();
await shot("new-post");

await page.getByRole("tab", { name: "Accounts" }).first().click();
await tid("social-more-web").waitFor();
await shot("accounts");

console.log(errors.length ? `page errors: ${errors.join(" | ")}` : "no page errors");
await browser.close();

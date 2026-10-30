// Screenshots of the Email addresses flow (build 13) on the web build with the sample workspace,
// with an axe check on each. Usage: node scripts/email-screens.mjs http://localhost:8790 <out-dir> [light|dark]
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8790";
const out = process.argv[3] ?? "screens";
const colorScheme = process.argv[4] ?? "light";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
async function shot(name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/mobile-${name}.png` });
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  console.log(`${name}: ${serious.length ? serious.map((v) => `${v.id}(${v.nodes.length})`).join(", ") : "no serious axe issues"}`);
}
const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();

await page.goto(base);
await page.waitForLoadState("networkidle");
await tid("sample").click();
await page.getByText("Wholesale order for Saturday markets", { exact: true }).first().waitFor();

await page.goto(`${base}/settings`);
await tid("email-setup-link").waitFor();
await shot("settings-email-addresses");

await tid("email-setup-link").click();
await tid("option-connect").waitFor();
await page.getByText("ava.lin.studio@gmail.com").first().waitFor();
await shot("email-addresses");

await tid("option-connect").click();
await tid("connect-email").waitFor();
await tid("connect-email").fill("ava@icloud.com");
await shot("connect-picker");
await tid("connect-password").fill("wrong");
await tid("connect-submit").click();
await tid("connect-error").waitFor();
await shot("connect-error");
await tid("connect-password").fill("abcd-efgh-ijkl-mnop");
await tid("connect-submit").click();
await tid("connect-done").waitFor();
await shot("connect-done");

await page.goto(`${base}/free-address`);
await tid("free-local").waitFor();
await shot("free-address");
await tid("free-local").fill("ava");
await tid("free-claim").click();
await page.getByText(/is taken/).first().waitFor();
await shot("free-address-taken");
await tid("free-local").fill("ava.harbour");
await tid("free-claim").click();
await tid("free-address-done").waitFor();
await shot("free-address-done");

await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }

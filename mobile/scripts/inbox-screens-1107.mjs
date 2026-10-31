// 1.10.7: Inbox tabs, Snoozed, labels, Mail rules and the long press quick actions on the web build with the sample
// workspace at phone widths, light and dark, with layout checks (no sideways scroll, the tab row fits) and axe at 390.
// Usage: node scripts/inbox-screens-1107.mjs http://localhost:8793 <out-dir> [--before]
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8793";
const out = process.argv[3] ?? "screens";
const before = process.argv.includes("--before");
mkdirSync(out, { recursive: true });
const problems = [];
const seen = [];
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const browser = await chromium.launch();

for (const width of [375, 390, 430]) for (const scheme of ["light", "dark"]) {
  if (only && `${width}-${scheme}` !== only) continue;
  const height = width === 430 ? 932 : width === 375 ? 812 : 844;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: scheme, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const tag = `${width}-${scheme}`;
  const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
  const shot = async (name, axe = true) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${name}-${tag}.png` });
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    if (sideways) problems.push(`${name} ${tag}: scrolls sideways`);
    if (!axe || width !== 390 || before) return;
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    if (serious.length) problems.push(`${name} ${tag}: axe ${serious.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => `${n.html.slice(0, 100)} :: ${(n.failureSummary ?? "").slice(0, 140)}`).join(" || ")}`).join(", ")}`);
  };
  const step = async (name, fn) => { try { await fn(); } catch (e) { (before ? console.log : (m) => problems.push(m))(`${name} ${tag}: ${String(e).split("\n")[0].slice(0, 200)}`); } };
  const longPress = async (loc) => { const b = await loc.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + Math.min(30, b.height / 2)); await page.mouse.down(); await page.waitForTimeout(800); await page.mouse.up(); };
  const close = async () => { const c = tid("sheet-cancel"); if (await c.isVisible().catch(() => false)) await c.click(); await page.waitForTimeout(400); };

  try {
  await page.goto(base);
  await page.waitForLoadState("networkidle");
  if (await page.getByTestId("sample").first().isVisible().catch(() => false)) await tid("sample").click();
  await page.waitForTimeout(2500);
  await page.goto(`${base}/inbox`).catch(() => {});
  await page.waitForTimeout(2000);
  await step("inbox", async () => {
    if (!before) {
      await tid("inbox-tabs").waitFor({ timeout: 8000 });
      const r = await tid("inbox-tabs").boundingBox();
      if (!r || r.width > width + 1) problems.push(`inbox ${tag}: tab row too wide`);
    }
    await shot("01-inbox");
  });
  if (!before) {
    await step("updates tab", async () => { await tid("inbox-tab-updates").click(); await page.getByText("Your payout of A$2,140.60 is on its way").first().waitFor(); await shot("02-inbox-updates"); await tid("inbox-tab-primary").click(); });
    await step("mail menu", async () => {
      await page.waitForTimeout(800);
      await longPress(page.getByRole("button", { name: /Wholesale order for Saturday markets/ }).filter({ visible: true }).first());
      await tid("mail-actions").waitFor();
      await shot("03-mail-menu");
      await page.getByTestId("sheet-move-tab").filter({ visible: true }).first().click();
      await tid("move-tab-sheet").waitFor();
      await shot("04-move-to-tab");
      await page.getByTestId("sheet-updates").filter({ visible: true }).first().click();
      await page.waitForTimeout(600);
      await shot("05-moved-undo", false);
    });
    await step("labels", async () => {
      await page.waitForTimeout(6000);
      await longPress(page.getByRole("button", { name: /Quote for the Surry Hills kiosk fit out/ }).filter({ visible: true }).first());
      await page.getByTestId("sheet-labels").filter({ visible: true }).first().click();
      await tid("label-sheet").waitFor();
      await shot("06-labels");
      await close();
      await tid("label-Kiosk").or(page.getByTestId("label-msg_4-Kiosk").filter({ visible: true })).first().click();
      await page.waitForTimeout(800);
      await shot("07-label-filter", false);
      await tid("label-filter").click();
    });
    await step("snoozed", async () => {
      await page.getByRole("button", { name: /^Snoozed/ }).filter({ visible: true }).first().click();
      await page.getByText("Cup samples for the new kiosk").first().waitFor();
      await shot("08-snoozed");
      await page.getByRole("button", { name: /^Inbox/ }).filter({ visible: true }).first().click();
    });
  }
  await step("thread", async () => {
    if (!before) { await tid("inbox-tab-updates").click(); await page.waitForTimeout(800); }
    await page.getByRole("button", { name: /Your domain harbourcoffee.com.au is verified/ }).filter({ visible: true }).first().click();
    await page.waitForTimeout(1500);
    await shot("09-thread");
    if (!before) {
      // A link's own menu (Open, Copy link, Share) opens on a long press on the phone; the web build has no long press
      // on text, so the unit tests cover it. The header button opens the mail's menu here.
      await tid("thread-more").click();
      await tid("quick-actions").waitFor();
      await shot("10-thread-more");
      await page.getByTestId("sheet-copy-link").filter({ visible: true }).first().click();
      await tid("quick-toast").waitFor({ timeout: 6000 });
      await shot("11-copied-toast", false);
    }
    await page.goBack();
  });
  await step("mail settings", async () => {
    await page.goto(`${base}/settings`);
    await page.waitForTimeout(1500);
    await shot("13-settings", false);
    if (before) return;
    await tid("mail-settings-link").click();
    await tid("rules").waitFor();
    await page.getByText("Market bookings to Sam").first().waitFor();
    await shot("14-mail-settings");
    await tid("rule-mrl_s2").click();
    await tid("rule-web-only").waitFor();
    await shot("15-rule-web-only");
    await page.goBack();
    await tid("rule-mrl_s1").click();
    await tid("rule-runs").waitFor();
    await shot("16-rule-detail");
    await page.goBack();
    await tid("new-rule").click();
    await tid("rule-form").waitFor();
    await tid("rule-save").click();
    await page.getByText("Name the rule.").first().waitFor();
    await shot("17-new-rule-errors");
    await tid("rule-name").fill("Bakery orders");
    await tid("cond-value-0").fill("bondibakehouse");
    await tid("act-add").click();
    await page.getByTestId("sheet-label").filter({ visible: true }).first().click();
    await tid("act-label-0").fill("Orders");
    await tid("rule-test").click();
    await tid("rule-test-result").waitFor();
    await shot("18-new-rule-checked");
  });
  await step("social", async () => {
    await page.goto(`${base}/social`);
    await tid("social-posts").waitFor();
    await page.waitForTimeout(1200);
    if (before) { await shot("19-social-posts", false); return; }
    await longPress(page.getByTestId(/^open-sp_/).filter({ visible: true }).first());
    await tid("quick-actions").waitFor();
    await shot("19-post-menu");
  });

  } catch (e) { problems.push(`${tag}: run stopped: ${String(e).split("\n")[0].slice(0, 200)}`); }
  if (errors.length) problems.push(`${tag}: page errors ${errors.join(" | ").slice(0, 400)}`);
  console.log(`${tag}: done ${problems.length} problem(s) so far`);
  for (const p of problems.splice(0)) { console.log(`  ${p}`); seen.push(p); }
  await ctx.close().catch(() => {});
}
console.log(seen.length ? `PROBLEMS ${seen.length}` : "no layout or axe problems");
await browser.close();

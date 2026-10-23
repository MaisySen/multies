// Walks the main screens of the web build on a phone sized viewport, saves screenshots and runs
// an axe accessibility check on each. Usage: node scripts/screens.mjs http://localhost:8790 <out-dir>
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8790";
const out = process.argv[3] ?? "screens";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: "dark" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

const report = [];
let n = 0;
async function shot(name) {
  await page.waitForTimeout(600);
  n += 1;
  const file = `${out}/${String(n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file });
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  report.push({ screen: name, file, violations: axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })) });
  console.log(`${name}: ${serious.length ? serious.map((v) => `${v.id}(${v.nodes.length})`).join(", ") : "no serious axe issues"}`);
}
const byText = (t) => page.getByText(t, { exact: true }).filter({ visible: true }).first();
const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();

await page.goto(`${base}/two-factor`);
await page.waitForLoadState("networkidle");
await page.goto(base);
await page.waitForLoadState("networkidle");
await tid("sample").waitFor();
await shot("sign-in");

await tid("sample").click();
await byText("Wholesale order for Saturday markets").waitFor();
await shot("inbox");

await byText("Wholesale order for Saturday markets").click();
await tid("reply").waitFor();
await shot("thread");

await tid("reply").click();
await tid("send").waitFor();
await shot("reply");
await page.goBack();
await page.waitForTimeout(300);

await tid("make-task").click();
await page.getByText("Status", { exact: true }).waitFor();
await shot("task-from-email");
await page.goto(`${base}/inbox`);

await tid("open-search").click();
await tid("search").fill("invoice");
await byText("Re: Invoice INV-1042 overdue").waitFor();
await shot("search");
await page.goto(`${base}/approvals`);

await byText("Invoice INV-1051 is 14 days overdue").waitFor();
await shot("approvals");

await byText("Second reminder: invoice INV-1047").click();
await tid("approve").waitFor();
await shot("approval-review");
await tid("approve").click();
await page.waitForURL(/approvals$/);
await page.waitForTimeout(500);
await shot("approvals-after-approve");

await page.goto(`${base}/tasks`);
await tid("new-task").click();
await tid("task-title").fill("Book the Marrickville stall insurance");
await tid("save-task").click();
await page.waitForTimeout(400);
await shot("tasks-list");
await byText("Board").click();
await shot("tasks-board");

await page.goto(`${base}/compose`);
await tid("to").fill("sam@bondibakehouse.com.au");
await tid("subject").fill("Saturday order confirmed");
await tid("body").fill("Hi Sam,\n\n12 kg house blend and 4 kg decaf, ready from 6 am Saturday.\n\nMia");
await shot("compose");
await tid("send").click();
await page.waitForTimeout(600);

await page.goto(`${base}/settings`);
await tid("sign-out").waitFor();
await shot("settings");
await tid("delete-account").click();
await tid("confirm-delete").waitFor();
await shot("delete-account");

writeFileSync(`${out}/axe-report.json`, JSON.stringify(report, null, 2));
console.log(`page errors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log("  ", e.slice(0, 300));
await browser.close();

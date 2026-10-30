// Store screenshots from the web build with sample data, at the exact pixel sizes the stores ask for.
// Usage: node scripts/store-screens.mjs http://localhost:8795 store/screenshots
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8795";
const out = process.argv[3] ?? "store/screenshots";
// CSS size at 3x: 440x956 = 1320x2868 (6.9 inch), 428x926 = 1284x2778 (6.5 inch), 360x640 = 1080x1920 (Play phone).
const SIZES = [
  { dir: "ios-6.9", width: 440, height: 956 },
  { dir: "ios-6.5", width: 428, height: 926 },
  { dir: "play-phone", width: 360, height: 640 },
];

const browser = await chromium.launch();
const errors = [];
for (const size of SIZES) {
  const dir = `${out}/${size.dir}`;
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: "dark" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  const byText = (t) => page.getByText(t, { exact: true }).filter({ visible: true }).first();
  const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
  let n = 0;
  // A real account has no sample banner, so the store images leave it out.
  const hideBanner = () => page.evaluate(() => { for (const el of document.querySelectorAll("div")) { const t = el.textContent ?? ""; if (t.includes("Sample workspace.") && t.length < 90) el.style.display = "none"; } });
  const shot = async (name) => { await page.waitForTimeout(800); await hideBanner(); n += 1; await page.screenshot({ path: `${dir}/${String(n).padStart(2, "0")}-${name}.png` }); };

  await page.goto(base); await page.waitForLoadState("networkidle");
  await tid("sample").click();
  await byText("Wholesale order for Saturday markets").waitFor();
  await shot("inbox");

  await byText("Wholesale order for Saturday markets").click();
  await tid("reply").waitFor();
  await shot("thread");

  await page.goto(`${base}/approvals`);
  await page.waitForTimeout(1200);
  await shot("approvals");

  await page.goto(`${base}/tasks`);
  await byText("Confirm Saturday wholesale order with Bondi Bakehouse").waitFor();
  await byText("Board").click();
  await page.waitForTimeout(600);
  await shot("tasks-board");
  await byText("List").click();
  await page.waitForTimeout(400);

  await byText("Confirm Saturday wholesale order with Bondi Bakehouse").click();
  await tid("timer-start").click();
  await tid("timer-elapsed").waitFor();
  await page.waitForTimeout(3200);
  await shot("task-timer");
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="custom-fields"]');
    let p = el?.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight + 10 && getComputedStyle(p).overflowY !== "visible")) p = p.parentElement;
    if (el && p) p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - 40;
  });
  await shot("task-fields");

  await page.goto(`${base}/portfolio`);
  await byText("Operations").waitFor();
  await shot("portfolio");
  await ctx.close();
}
console.log("errors:", JSON.stringify(errors.slice(0, 5)));
await browser.close();

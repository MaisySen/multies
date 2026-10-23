// Runs axe-core (WCAG 2.2 A and AA) over every page, signed in, at desktop and phone widths.
// Usage: node scripts/a11y-audit.mjs <base-url> <out.json> [--cookies cookies.json]
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync, writeFileSync } from "node:fs";

const [base, out] = process.argv.slice(2);
const ci = process.argv.indexOf("--cookies");
const cookies = ci > 0 ? JSON.parse(readFileSync(process.argv[ci + 1], "utf8")) : [];
const pages = process.env.PAGES?.split(",") ?? [
  "/", "/pricing", "/login", "/signup", "/forgot-password", "/status", "/nope",
  "/app", "/app/mail", "/app/domains", "/app/mailboxes", "/app/deliverability", "/app/activity",
  "/app/settings", "/app/settings/team", "/app/settings/billing", "/app/settings/account", "/app/settings/mail",
  "/app/settings/mail-apps", "/app/settings/developers",
];
const browser = await chromium.launch();
const results = [];
let total = 0;
for (const vp of [{ width: 1280, height: 800, name: "desktop" }, { width: 390, height: 844, name: "phone" }]) {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  for (const p of pages) {
    if (p.startsWith("/app")) await ctx.addCookies(cookies); else await ctx.clearCookies();
    await page.goto(base + p, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    const v = r.violations.map((x) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.slice(0, 5).map((n) => ({ target: n.target.join(" "), summary: n.failureSummary?.slice(0, 300) })) }));
    total += v.length;
    results.push({ page: p, viewport: vp.name, violations: v });
    console.log(`${vp.name} ${p}: ${v.length ? v.map((x) => `${x.id}(${x.nodes.length})`).join(", ") : "clean"}`);
  }
  await ctx.close();
}
await browser.close();
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`total violations: ${total}`);

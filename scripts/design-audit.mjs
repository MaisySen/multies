// Runs the impeccable detector over every page, signed in, at desktop and phone widths.
// Usage: node scripts/design-audit.mjs <base-url> <out.json> [--cookies cookies.json]
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [base, out] = process.argv.slice(2);
const ci = process.argv.indexOf("--cookies");
const cookies = ci > 0 ? JSON.parse(readFileSync(process.argv[ci + 1], "utf8")) : [];
const pages = process.env.PAGES?.split(",") ?? [
  "/", "/pricing", "/agents", "/login", "/signup", "/forgot-password", "/status", "/nope",
  "/app", "/app/mail", "/app/inbox", "/app/agents", "/app/approvals", "/app/domains", "/app/mailboxes", "/app/deliverability", "/app/activity",
  "/app/settings", "/app/settings/team", "/app/settings/billing", "/app/settings/account", "/app/settings/mail",
  "/app/settings/mail-apps", "/app/settings/developers",
];
const port = 9333;
const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
const results = [];
for (const vp of [{ width: 1280, height: 800, name: "desktop" }, { width: 390, height: 844, name: "phone" }]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  if (cookies.length) await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  for (const p of pages) {
    const authPage = !p.startsWith("/app");
    // Public pages are scanned signed out.
    if (authPage) await ctx.clearCookies(); else if (cookies.length) await ctx.addCookies(cookies);
    await page.goto(base + p, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(600);
    const title = await page.title();
    const r = spawnSync("npx", ["-y", "impeccable@4.7.0", "detect", "--cdp", String(port), "--target", title || base, "--json", "--no-advisory"], { encoding: "utf8", timeout: 120_000 });
    let findings;
    try { findings = JSON.parse(r.stdout); } catch { findings = { raw: (r.stdout + r.stderr).slice(-1500) }; }
    results.push({ page: p, viewport: vp.name, findings });
    process.stdout.write(`${vp.name} ${p}: ${Array.isArray(findings) ? findings.length : JSON.stringify(findings).slice(0, 200)}\n`);
  }
  await ctx.close();
}
await browser.close();
writeFileSync(out, JSON.stringify(results, null, 2));

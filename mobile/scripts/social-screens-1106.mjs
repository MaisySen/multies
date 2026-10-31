// 1.10.6: Social on the web build with the sample workspace at phone widths, light and dark, with layout checks
// (nothing under the header, no sideways scroll, the Post button stays on screen) and an axe pass on each screen.
// Usage: node scripts/social-screens-1106.mjs http://localhost:8792 <out-dir>
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8792";
const out = process.argv[3] ?? "screens";
mkdirSync(out, { recursive: true });
const problems = [];
const browser = await chromium.launch();
const LONG = "Fresh sourdough this Saturday at the wharf market. ".repeat(30).trim();

for (const width of [375, 390, 430]) for (const scheme of ["light", "dark"]) {
  const height = width === 430 ? 932 : width === 375 ? 812 : 844;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const tag = `${width}-${scheme}`;
  const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
  const shot = async (name, axe = true) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}/${name}-${tag}.png` });
    if (!axe || width !== 390) return;
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    if (serious.length) problems.push(`${name} ${tag}: axe ${serious.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes.map((n) => `${n.html.slice(0, 120)} :: ${(n.failureSummary ?? "").slice(0, 160)}`).join(" || ")}`).join(", ")}`);
  };
  /** The list starts below the pinned bar and ends on screen; nothing scrolls sideways. */
  const layout = async (name, listId) => {
    const r = await page.evaluate(([listId]) => {
      const vis = (id) => [...document.querySelectorAll(`[data-testid="${id}"]`)].find((e) => e.getBoundingClientRect().height > 0);
      const pin = vis("social-pinned")?.getBoundingClientRect();
      const list = vis(listId)?.getBoundingClientRect();
      return { pinBottom: pin?.bottom ?? null, listTop: list?.top ?? null, listBottom: list?.bottom ?? null, h: innerHeight, sideways: document.documentElement.scrollWidth > innerWidth + 1 };
    }, [listId]);
    if (r.sideways) problems.push(`${name} ${tag}: scrolls sideways`);
    if (r.pinBottom !== null && r.listTop !== null && r.listTop < r.pinBottom - 1) problems.push(`${name} ${tag}: list starts under the pinned bar (${r.listTop} < ${r.pinBottom})`);
    if (r.listBottom !== null && r.listBottom > r.h + 1) problems.push(`${name} ${tag}: list runs past the screen (${r.listBottom} > ${r.h})`);
  };

  await page.goto(base);
  await page.waitForLoadState("networkidle");
  if (await page.getByTestId("sample").first().isVisible().catch(() => false)) await tid("sample").click();
  await page.waitForTimeout(2500);
  // Today carries a Social card.
  if (!(await tid("today-social").isVisible().catch(() => false))) problems.push(`today ${tag}: no Social card`);
  else if (width === 390) await shot("today-social", false);

  await page.goto(`${base}/settings`);
  await tid("social-link").waitFor();
  await tid("social-link").click();
  await tid("social-posts").waitFor();
  await page.waitForTimeout(1200);
  await layout("posts", "social-posts");
  await shot("posts");
  // Scrolled: the cards go under the pinned bar's edge, never behind the title.
  await page.evaluate(() => { const s = [...document.querySelectorAll('[data-testid="social-posts"]')].find((e) => e.getBoundingClientRect().height > 0); if (s) s.scrollTop = 400; });
  await layout("posts scrolled", "social-posts");
  await shot("posts-scrolled", false);
  await tid("filter-failed").click();
  await shot("posts-filter-failed", false);
  await tid("filter-all").click();

  // A post that was removed on Facebook, then the delete confirm.
  await tid("open-sp_1").click();
  await tid("post-text").waitFor();
  await shot("post-detail");
  await tid("post-delete").click();
  await tid("delete-sheet").waitFor();
  await shot("post-delete-confirm");
  await page.getByRole("button", { name: /^Delete from / }).filter({ visible: true }).first().click();
  await tid("social-toast").waitFor({ timeout: 8000 }).catch(() => problems.push(`delete ${tag}: no toast`));
  await shot("post-deleted-toast", false);

  // New post with long text: the Post button stays on screen.
  await page.getByRole("tab", { name: "New post" }).first().click();
  await tid("social-text").waitFor();
  await tid("social-text").fill(LONG);
  await tid("pick-facebook").click();
  await page.getByText("Harbour Bakery Events").first().waitFor();
  await page.getByText("Harbour Bakery Events").first().click();
  await tid("pick-linkedin").click();
  const send = await tid("social-send").boundingBox();
  if (!send || send.y + send.height > height + 1) problems.push(`new post ${tag}: Post button off screen`);
  await layout("new post", "social-new");
  await shot("new-post-long");
  await tid("social-text").fill("Fresh sourdough this Saturday at the wharf market.");

  // Post now: the result screen follows it to the end.
  await tid("social-send").click();
  await tid("posted-title").waitFor({ timeout: 10000 });
  await shot("posted-sending", false);
  await page.getByText(/^Posted to /).filter({ visible: true }).first().waitFor({ timeout: 15000 }).catch(() => problems.push(`posted ${tag}: never finished`));
  await shot("posted-done");
  await tid("view-in-posts").click();
  await tid("social-posts").waitFor();
  await shot("posts-after-posting", false);

  await page.getByRole("tab", { name: "Accounts" }).first().click();
  await tid("social-accounts").waitFor();
  await layout("accounts", "social-accounts");
  await shot("accounts");

  if (errors.length) problems.push(`${tag}: page errors ${errors.join(" | ")}`);
  console.log(`${tag}: done`);
  await ctx.close();
}
console.log(problems.length ? `PROBLEMS\n${problems.join("\n")}` : "no layout or axe problems");
await browser.close();

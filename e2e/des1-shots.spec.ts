import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * DES1: before and after screenshots of the pages a daily user sees most, at 1280 and 390, light and dark, plus the
 * Forest brand theme at 1280. Runs only with SHOTS_DIR set. Also writes the page CSP header per page (csp.json), the
 * serious or critical axe findings (axe.json) and any sideways scroll (scroll.json) next to the shots.
 */
const DIR = process.env.SHOTS_DIR;
test.skip(!DIR, "screenshots only with SHOTS_DIR");

let visitor = 0;
const ip = () => `10.156.${test.info().workerIndex % 200}.${++visitor}`;

const PAGES: [string, string][] = [
  ["/app/mail", "inbox"],
  ["/app/one-inbox", "one-inbox"],
  ["/app/tasks", "tasks"],
  ["/app/chat", "chat"],
  ["/app/contacts", "contacts"],
  ["/app/docs", "docs"],
  ["/app/forms", "forms"],
  ["/app/contacts/invoices", "invoices"],
  ["/app/settings", "settings"],
  ["/app/settings/account", "security"],
];

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => undefined);
  await page.waitForTimeout(700);
}

async function axe(page: Page, label: string, out: string[]) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  for (const v of violations) if (v.impact === "serious" || v.impact === "critical") out.push(`${label}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`);
}


/** DES1 sweep: interactive controls that overlap each other, and text cut off without an ellipsis. */
async function layout(page: Page, label: string, out: string[]) {
  const found = await page.evaluate(() => {
    const vis = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05 && r.bottom > 0 && r.top < innerHeight ? r : null; };
    const res: string[] = [];
    const name = (el: Element) => (el.getAttribute("aria-label") || el.getAttribute("data-testid") || (el.textContent || "").trim().slice(0, 24) || el.tagName).replace(/\s+/g, " ");
    const ctl = [...document.querySelectorAll("#root button, #root a[href], #root input, #root select, #root [role=checkbox], #root .ds-avatar")].filter((e) => vis(e) && !e.closest("[aria-hidden=true]:not(.ds-avatar)"));
    for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
      const a = ctl[i], b = ctl[j]; if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 3 && h > 3) {
        const pt = document.elementsFromPoint(Math.max(ra.left, rb.left) + w / 2, Math.max(ra.top, rb.top) + h / 2);
        if (pt.some((e) => e === a || a.contains(e)) && pt.some((e) => e === b || b.contains(e))) res.push(`overlap: ${name(a)} x ${name(b)} (${Math.round(w)}x${Math.round(h)})`);
      }
    }
    for (const el of document.querySelectorAll("#root *")) {
      if (!vis(el) || el.children.length > 0 || !(el.textContent || "").trim()) continue;
      const cs = getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.overflowX !== "visible" && cs.textOverflow !== "ellipsis" && cs.overflowX !== "auto" && cs.overflowX !== "scroll") res.push(`clip: ${name(el)}`);
    }
    return [...new Set(res)].slice(0, 25);
  });
  for (const f of found) out.push(`${label}: ${f}`);
}

test.use({ actionTimeout: 15_000 });

test("des1 shots", async ({ page, context }) => {
  test.setTimeout(1_500_000);
  mkdirSync(DIR!, { recursive: true });
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const csp: Record<string, string> = {};
  const bad: string[] = [];
  const scroll: string[] = [];
  const lay: string[] = [];
  const doAxe = process.env.SHOTS_AXE !== "0";
  const visit = async (path: string, name: string, w: number, scheme: string) => {
    const res = await page.goto(path);
    if (res) csp[path] = res.headers()["content-security-policy"] ?? "";
    await settle(page);
    await page.screenshot({ path: `${DIR}/${name}-${w}-${scheme}.png` });
    if (!(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))) scroll.push(`${name} ${w} ${scheme}`);
    if (doAxe) await axe(page, `${name} ${w} ${scheme}`, bad);
    await layout(page, `${name} ${w} ${scheme}`, lay);
    if (name === "inbox" && w < 1000) {
      const sel = page.getByTestId("mail-select").first();
      if (await sel.count()) { await sel.click(); await page.waitForTimeout(250); await page.screenshot({ path: `${DIR}/inbox-selecting-${w}-${scheme}.png` }); await layout(page, `inbox selecting ${w} ${scheme}`, lay); await sel.click(); await page.waitForTimeout(250); }
    }
  };
  // Sign in page, signed out.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const [w, h] of [[1280, 860], [430, 932], [390, 844], [375, 812]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await visit("/login", "signin", w, scheme);
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
  await settle(page);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const [w, h] of [[1280, 860], [430, 932], [390, 844], [375, 812]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const [path, name] of PAGES) await visit(path, name, w, scheme);
    }
  }
  // Forest brand theme at 1280.
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  const forest = page.getByRole("button", { name: "Forest", exact: true });
  await forest.first().waitFor({ timeout: 20_000 });
  await forest.first().click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const [path, name] of PAGES) await visit(path, `${name}-forest`, 1280, scheme);
  }
  writeFileSync(`${DIR}/csp.json`, JSON.stringify(csp, null, 1));
  writeFileSync(`${DIR}/axe.json`, JSON.stringify(bad, null, 1));
  writeFileSync(`${DIR}/scroll.json`, JSON.stringify(scroll, null, 1));
  writeFileSync(`${DIR}/layout.json`, JSON.stringify(lay, null, 1));
});


/** DES1 v3: empty and loading states at 390 (light), one each per page, into SHOTS_DIR/states. A fresh account gives the
 * empty states; holding the page's list requests open gives the skeletons. */
test("des1 states", async ({ browser, baseURL }) => {
  test.skip(!process.env.SHOTS_STATES, "states only with SHOTS_STATES");
  test.setTimeout(900_000);
  const out = `${DIR}/states`;
  mkdirSync(out, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light", reducedMotion: "reduce", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": `10.157.1.${Math.floor(Math.random() * 200) + 1}` } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(baseURL!).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Erin Empty", email: `empty-${Date.now()}@acme.io`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  for (const [path, name] of PAGES) {
    await page.goto(path);
    await settle(page);
    await page.screenshot({ path: `${out}/${name}-390-empty.png` });
  }
  // Loading: everything except the shell's own reads waits, so each page shows its skeleton.
  const shell = /\/api\/(config|account\/me|auth|org($|\/brand)|tours|nav|whats-new|preferences|notifications\/count|presence|features)/;
  await page.route("**/api/**", async (route) => {
    if (shell.test(new URL(route.request().url()).pathname)) return route.fallback();
    await new Promise((r) => setTimeout(r, 20_000));
    await route.fallback().catch(() => undefined);
  });
  for (const [path, name] of PAGES) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${name}-390-loading.png` });
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.close();
});

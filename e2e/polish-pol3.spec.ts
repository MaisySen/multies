import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, appendFileSync } from "node:fs";

/**
 * POL3 phone polish and theme sweep. Walks the main signed in pages and the public sign up path at 375, 390 and 430
 * (light) and at 1280 and 390 in light, dark and Forest. Each stop checks: no sideways scroll, nothing clipped without an
 * ellipsis, tap targets of at least 44 px on phones (inline text links exempt), no fixed bar covering the end of the page,
 * and axe 0 serious or critical. POL3_AUDIT=1 only lists findings (to POL3_FINDINGS); otherwise any finding fails.
 * SHOTS_DIR writes one screenshot per stop.
 */
const AUDIT = process.env.POL3_AUDIT === "1";
const OUT = process.env.POL3_FINDINGS ?? "/tmp/pol3-findings.txt";
const SHOTS = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.199.${test.info().workerIndex % 200}.${++visitor}`;
let ctx: BrowserContext, page: Page, headers: Record<string, string>;
const findings: string[] = [];

const APP_PAGES: [string, string][] = [
  ["my-work", "/app/my-work"], ["mail", "/app/mail"], ["inbox", "/app/inbox"], ["tasks", "/app/tasks"], ["docs", "/app/docs"],
  ["calendar", "/app/tasks?view=calendar"], ["meetings", "/app/meetings"], ["social-compose", "/app/social/compose"], ["contacts", "/app/contacts"],
  ["settings", "/app/settings"], ["account", "/app/settings/account"], ["billing", "/app/settings/billing"], ["notifications", "/app/notifications"],
  ["portals", "/app/contacts/portals"],
];
const PUBLIC_PAGES: [string, string][] = [["signup", "/signup"], ["login", "/login"], ["home", "/"], ["pricing", "/pricing"], ["client-portal", "/guest"], ["forgot", "/forgot-password"]];

function note(where: string, what: string) { findings.push(`${where}: ${what}`); }

async function settle() {
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 4_000 }).catch(() => {});
}

async function layoutChecks(where: string, phone: boolean) {
  const r = await page.evaluate((phone) => {
    const out: string[] = [];
    const vw = window.innerWidth, vh = window.innerHeight;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`sideways scroll ${document.documentElement.scrollWidth} > ${vw}`);
    const label = (el: Element) => {
      const t = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 40);
      const id = el.getAttribute("data-testid");
      return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ""} "${t}"`;
    };
    const visible = (el: Element) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== "hidden" && s.display !== "none" && b.bottom > 0 && b.top < vh * 3; };
    const inScroller = (el: Element) => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if ((s.overflowX === "auto" || s.overflowX === "scroll") && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
    const srOnly = (el: Element) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width <= 2 || b.height <= 2 || s.clip === "rect(0px, 0px, 0px, 0px)" || !!el.closest(".sr-only"); };
    const inDialogOrHidden = (el: Element) => !!el.closest("[aria-hidden=true],[inert],[data-sonner-toaster]");
    // Off screen controls (not in a sideways scroller).
    for (const el of Array.from(document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=tab]"))) {
      if (!visible(el) || inDialogOrHidden(el) || inScroller(el)) continue;
      const b = el.getBoundingClientRect();
      if (b.right > vw + 1 || b.left < -1) out.push(`off screen ${label(el)} x ${Math.round(b.left)}..${Math.round(b.right)}`);
    }
    // Clipped text without an ellipsis.
    for (const el of Array.from(document.querySelectorAll("main *, header *, nav *, [role=dialog] *"))) {
      if (!(el instanceof HTMLElement) || !visible(el) || inDialogOrHidden(el) || el.children.length > 2 || srOnly(el)) continue;
      const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
      if (text.length < 3) continue;
      const s = getComputedStyle(el);
      const clipsX = (s.overflowX === "hidden" || s.overflow === "hidden" || s.overflowX === "clip") && el.scrollWidth > el.clientWidth + 1;
      const clipsY = (s.overflowY === "hidden" || s.overflowY === "clip") && el.scrollHeight > el.clientHeight + 2 && !s.webkitLineClamp?.match(/\d/) && s.display !== "-webkit-box";
      if (clipsX && s.textOverflow !== "ellipsis") out.push(`clipped ${label(el)} ${el.scrollWidth}>${el.clientWidth}`);
      else if (clipsY && s.textOverflow !== "ellipsis" && el.clientHeight > 0) out.push(`clipped vertically ${label(el)} ${el.scrollHeight}>${el.clientHeight}`);
    }
    if (phone) {
      for (const el of Array.from(document.querySelectorAll("button, a[href], [role=button], [role=tab], [role=switch], input[type=checkbox], input[type=radio], select, summary"))) {
        if (!visible(el) || inDialogOrHidden(el)) continue;
        const b = el.getBoundingClientRect();
        if ((el.tagName === "A" || el.tagName === "BUTTON") && getComputedStyle(el).display.startsWith("inline") && !getComputedStyle(el).display.includes("flex") && el.closest("p")) continue; // a link in running text
        if (el.tagName === "A" && getComputedStyle(el).display === "inline" && el.closest("li")) continue;
        if (srOnly(el)) continue;
        if (el.tagName === "INPUT" && el.closest("label") && el.closest("label")!.getBoundingClientRect().height >= 43.5) continue; // the label is the target
        // The hit area can be larger than the box: honour a ::before/::after inset hit area.
        const pre = getComputedStyle(el, "::after"); const pre2 = getComputedStyle(el, "::before");
        const grow = (p: CSSStyleDeclaration) => (p.content && p.content !== "none" && p.position === "absolute" ? Math.max(0, -parseFloat(p.top || "0")) * 2 : 0);
        const growX = (p: CSSStyleDeclaration) => (p.content && p.content !== "none" && p.position === "absolute" ? Math.max(0, -parseFloat(p.left || "0")) * 2 : 0);
        const g = Math.max(grow(pre), grow(pre2)), gx = Math.max(growX(pre), growX(pre2));
        if (b.height + g < 43.5 || b.width + gx < 43.5) out.push(`tap target ${Math.round(b.width)}x${Math.round(b.height)} ${label(el)}`);
      }
    }
    // Fixed or sticky bars at the bottom must not cover the end of the content.
    const bars = Array.from(document.querySelectorAll("body *")).filter((el) => { const s = getComputedStyle(el); if (s.position !== "fixed" && s.position !== "sticky") return false; const b = el.getBoundingClientRect(); return b.height > 20 && b.height < vh / 2 && b.bottom >= vh - 2 && b.width > vw / 2 && visible(el) && !inDialogOrHidden(el); });
    if (bars.length) {
      const top = Math.min(...bars.map((b) => b.getBoundingClientRect().top));
      const sc = document.scrollingElement!; sc.scrollTop = sc.scrollHeight;
      const main = document.querySelector("main");
      if (main) {
        const scrollers = [main, ...Array.from(main.querySelectorAll("*")).filter((e) => { const s = getComputedStyle(e); return (s.overflowY === "auto" || s.overflowY === "scroll") && e.scrollHeight > e.clientHeight + 1; })];
        for (const sEl of scrollers) sEl.scrollTop = sEl.scrollHeight;
        const items = Array.from(main.querySelectorAll("button, a[href], input, textarea, select, p, li, h2, h3")).filter((e) => visible(e) && !bars.some((b) => b.contains(e)) && !inDialogOrHidden(e));
        const last = items.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
        if (last && last.getBoundingClientRect().bottom > top + 1 && last.getBoundingClientRect().top < vh) out.push(`bottom bar covers ${label(last)} (${Math.round(last.getBoundingClientRect().bottom)} > ${Math.round(top)})`);
        for (const sEl of scrollers) sEl.scrollTop = 0;
      }
      sc.scrollTop = 0;
    }
    return Array.from(new Set(out)).slice(0, 40);
  }, phone);
  for (const x of r) note(where, x);
}

async function axeCheck(where: string) {
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  for (const v of violations.filter((v) => v.impact === "serious" || v.impact === "critical")) note(where, `axe ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
}

async function stop(name: string, path: string, w: number, theme: string, opts: { layout: boolean; axe: boolean }) {
  const where = `${name} ${w} ${theme}`;
  await page.goto(path);
  await settle();
  if (opts.layout) await layoutChecks(where, w < 600);
  if (opts.axe) await axeCheck(where);
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/pol3-${name}-${w}-${theme}.png` }); }
}

test.describe.configure({ mode: "serial" });
test.setTimeout(30 * 60_000);

test.beforeAll(async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 200)));
  headers = { origin: new URL(base).origin };
  const s = Date.now().toString(36);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Priya Polish", email: `owner-pol3-${s}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  for (const [email, name] of [["ana.long.name@client.example", "Anastasia Longname Featherstonehaugh"], ["bo@client.example", "Bo Li"]]) await page.request.post("/api/contacts", { data: { email, name }, headers });
  for (const title of ["Prepare the quarterly board pack with every regional number checked twice", "Call Bo"]) await page.request.post("/api/tasks", { data: { title }, headers });
});
test.afterAll(async () => {
  if (findings.length) appendFileSync(OUT, findings.join("\n") + "\n");
  console.log(`POL3 FINDINGS ${findings.length}`);
  await ctx?.close();
});

test("phones 375, 390, 430 light: layout, tap targets, bottom bars, axe", async () => {
  for (const w of [375, 390, 430]) {
    await page.setViewportSize({ width: w, height: w === 430 ? 932 : w === 390 ? 844 : 812 });
    for (const [n, p] of APP_PAGES) await stop(n, p, w, "light", { layout: true, axe: w === 390 });
  }
  if (!AUDIT) expect(findings).toEqual([]);
});

test("1280 and 390 in light, dark and Forest: axe and layout", async () => {
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      for (const [n, p] of APP_PAGES) { if (theme === "light" && w === 390) continue; await stop(n, p, w, theme, { layout: w === 1280, axe: true }); }
    }
  };
  await page.emulateMedia({ colorScheme: "light" }); await run("light");
  await page.emulateMedia({ colorScheme: "dark" }); await run("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  await run("forest");
  if (!AUDIT) expect(findings).toEqual([]);
});

test("public sign up path at 375, 390, 430 and 1280, light and dark", async () => {
  const anon = await ctx.browser()!.newContext({ baseURL: test.info().project.use.baseURL!, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const prev = page; page = await anon.newPage();
  try {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const w of [375, 390, 430, 1280]) {
        await page.setViewportSize({ width: w, height: 860 });
        for (const [n, p] of PUBLIC_PAGES) await stop(n, p, w, scheme, { layout: true, axe: w === 390 || w === 1280 });
      }
    }
  } finally { await anon.close(); page = prev; }
  if (!AUDIT) expect(findings).toEqual([]);
});

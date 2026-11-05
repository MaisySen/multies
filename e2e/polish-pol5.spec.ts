import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * POL5 polish round after R104B. Run with LANG_R104=on and FILES_PLUS_R101=on (E2E_POL5=on).
 * MB-363: Meetings and the Calendar settings Copy buttons read in Nepali and Hindi. Sweep: the pages R104B translated at
 * 375, 390 and 430 (light) and 390 (dark, Forest) in Nepali and Hindi: no sideways scroll, no raw key, no clipped
 * Devanagari, no control under 44 px on phones, axe 0 serious at 390. POL5_SHOTS=<dir> writes pol5-<page>-<width>-<theme>-<lang>.png.
 */
test.skip(process.env.E2E_POL5 !== "on", "POL5 runs with E2E_POL5=on (LANG_R104 on)");
const SHOTS = process.env.POL5_SHOTS;
let visitor = 0;
const ip = () => `10.172.${test.info().workerIndex % 200}.${++visitor}`;
const KEYISH = /(?<![@.\w/])(?:common|nav|shell|mail|compose|tasks|calendar|settings|docs|chat|contacts|meetings|files|home|social|mywork|whatsnew|appearance|branding)\.[a-z0-9_]+(?![.\w@/])/;

const PAGES: [string, string][] = [
  ["docs", "/app/docs"], ["chat", "/app/chat"], ["calendar-settings", "/app/settings/calendar"], ["contacts", "/app/contacts"],
  ["deals", "/app/deals"], ["meetings", "/app/meetings"], ["files", "/app/files"], ["social-new", "/app/social/new"],
  ["my-work", "/app/my-work"], ["appearance", "/app/settings/appearance"],
];

async function settle(p: Page) {
  await p.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 4_000 }).catch(() => {});
}
async function shot(p: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: `${SHOTS}/pol5-${name}.png` });
}
async function axe(p: Page, label: string) {
  const { violations } = await new AxeBuilder({ page: p }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function demo(ctx: BrowserContext) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 200)));
  await p.goto("/login");
  const origin = new URL(p.url()).origin;
  const r = await p.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  return { p, origin };
}
async function setLang(p: Page, origin: string, locale: "en" | "ne" | "hi") {
  expect((await p.request.patch("/api/account/preferences", { data: { locale }, headers: { origin } })).status()).toBe(200);
}

/** Everything wrong on the page as short lines: sideways scroll, raw keys, clipped Devanagari, small phone targets. */
async function problems(p: Page, phone: boolean): Promise<string[]> {
  return p.evaluate(({ phone, keyish }) => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > window.innerWidth + 1) out.push(`sideways ${de.scrollWidth}>${window.innerWidth}`);
    const key = document.body.innerText.match(new RegExp(keyish));
    if (key) out.push(`raw key ${key[0]}`);
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return null;
      if (e.closest(".sr-only, [aria-hidden=true], [inert]") || e.matches('[data-testid="skip-link"]')) return null;
      const s = getComputedStyle(e);
      if (s.visibility === "hidden" || s.clip !== "auto" || Number(s.opacity) === 0) return null;
      return r;
    };
    const name = (e: Element) => ((e.getAttribute("aria-label") || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32)) || e.tagName.toLowerCase();
    // Clipped Devanagari: a box that hides overflow while its text is taller or wider than it (ellipsis on purpose is fine).
    for (const e of document.querySelectorAll("body *")) {
      if (!e.childNodes.length || ![...e.childNodes].some((n) => n.nodeType === 3 && /[\u0900-\u097F]/.test(n.textContent ?? ""))) continue;
      if (!visible(e)) continue;
      const s = getComputedStyle(e);
      const hidesY = ["hidden", "clip"].includes(s.overflowY), hidesX = ["hidden", "clip"].includes(s.overflowX);
      const lines = Number(s.webkitLineClamp) > 0;
      if (hidesY && !lines && e.scrollHeight > e.clientHeight + 2) out.push(`clipped tall "${name(e)}" ${e.scrollHeight}>${e.clientHeight}`);
      if (hidesX && s.textOverflow !== "ellipsis" && e.scrollWidth > e.clientWidth + 2) out.push(`clipped wide "${name(e)}"`);
      const lh = parseFloat(s.lineHeight), fs = parseFloat(s.fontSize);
      if (Number.isFinite(lh) && lh < fs * 1.2 && hidesY) out.push(`tight line height "${name(e)}"`);
    }
    if (phone) {
      // A control is fine when its own box is 44 px on the short side or a point 21 px from its centre still lands on it.
      for (const e of document.querySelectorAll("button, [role=button], [role=tab], [role=switch], select, input[type=checkbox], input[type=radio], a.inline-flex, a[role=button]")) {
        const r = visible(e);
        if (!r || r.bottom < 0 || r.top > window.innerHeight * 3) continue;
        if ((e as HTMLElement).closest("p, li > span, [contenteditable=true]") && e.tagName === "A") continue;
        if (r.width >= 44 && r.height >= 44) continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const lands = (dx: number, dy: number) => {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return true;
          const t = document.elementFromPoint(x, y);
          return !!t && (t === e || e.contains(t) || (e as HTMLInputElement).labels?.[0]?.contains(t) === true || !!t.closest("label")?.contains(e));
        };
        if (r.top < 0 || r.bottom > window.innerHeight) continue; // measured only on screen
        const okY = r.height >= 44 || (lands(0, -21) && lands(0, 21));
        const okX = r.width >= 44 || (lands(-21, 0) && lands(21, 0));
        if (!okY || !okX) out.push(`small target "${name(e)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return [...new Set(out)];
  }, { phone, keyish: KEYISH.source });
}

test.describe.configure({ mode: "default" });
test.setTimeout(30 * 60_000);

for (const code of ["ne", "hi"] as const) {
  test(`MB-363: Meetings and Calendar settings read in ${code === "ne" ? "Nepali" : "Hindi"}`, async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
    const { p, origin } = await demo(ctx);
    await setLang(p, origin, code);
    // A meeting with one guest, so the list shows its guest count and the Upcoming heading.
    const starts = new Date(Date.now() + 86_400_000).toISOString();
    const made = await p.request.post("/api/meetings", { data: { title: "POL5 check", startsAt: starts, durationMin: 30, invitees: ["guest.pol5@example.com"] }, headers: { origin } });
    expect(made.ok(), await made.text()).toBe(true);
    await p.goto("/app/meetings");
    await settle(p);
    await expect.poll(() => p.evaluate(() => document.documentElement.lang), { timeout: 15_000 }).toBe(code);
    await expect(p.getByText("POL5 check")).toBeVisible({ timeout: 15_000 });
    const text = await p.evaluate(() => document.body.innerText);
    expect(text).not.toMatch(/free call minutes|\bUpcoming\b|\bUPCOMING\b|\bEarlier\b|\b1 guest\b|switched on for this workspace|Start one now/);
    await shot(p, `meetings-390-light-${code}`);
    await p.goto("/app/settings/calendar");
    await settle(p);
    const copy = await p.evaluate(() => [...document.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()).filter((t) => /^(Copy|Copied)$/.test(t)));
    expect(copy, "English Copy buttons").toEqual([]);
    await shot(p, `calendar-settings-390-light-${code}`);
    await ctx.close();
  });
}

test("sweep: the R104B pages in Nepali and Hindi at phone widths in light, dark and Forest", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const { p, origin } = await demo(ctx);
  const found: string[] = [];
  const run = async (l: string, theme: string, widths: number[]) => {
    for (const w of widths) {
      await p.setViewportSize({ width: w, height: w === 430 ? 932 : 844 });
      for (const [name, path] of PAGES) {
        await p.goto(path);
        await settle(p);
        await expect.poll(() => p.evaluate(() => document.documentElement.lang), { timeout: 15_000 }).toBe(l);
        for (const x of await problems(p, true)) found.push(`${l} ${theme} ${w} ${name}: ${x}`);
        if (w === 390 && theme !== "forest") await axe(p, `${l} ${theme} ${name} ${w}`);
        await shot(p, `${name}-${w}-${theme}-${l}`);
      }
    }
  };
  for (const l of ["ne", "hi"] as const) {
    await setLang(p, origin, l);
    await p.emulateMedia({ colorScheme: "light" });
    await run(l, "light", [375, 390, 430]);
    await p.emulateMedia({ colorScheme: "dark" });
    await run(l, "dark", [390]);
    await p.emulateMedia({ colorScheme: "light" });
  }
  await p.setViewportSize({ width: 1280, height: 860 });
  await p.goto("/app/settings/branding");
  await expect(p.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await p.getByRole("button", { name: /Forest|वन|फ़ॉरेस्ट|फरेस्ट/ }).first().click();
  const save = p.getByTestId("brand-actions").getByRole("button");
  if (await save.count()) await save.last().click();
  await p.waitForTimeout(800);
  for (const l of ["hi", "ne"] as const) { await setLang(p, origin, l); await run(l, "forest", [390]); }
  await setLang(p, origin, "en");
  console.log(`POL5 SWEEP ${found.length}\n${found.join("\n")}`);
  expect(found).toEqual([]);
  await ctx.close();
});

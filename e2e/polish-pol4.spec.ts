import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * POL4 polish round after R104. Run with LANG_R104=on and TRANSLATE_R116=on (E2E_POL4=on).
 * MB-353 the planner's Set time slots link has a 44 px hit area on phones; MB-354 a dialog's Close button stays 44 px
 * beside a long description (the doc translate dialog); MB-355 Read aloud on a device with no voice says so; MB-356 mail
 * folders and tabs, task views, filters, columns and due dates follow Nepali and Hindi; MB-357 the public cookie notice
 * follows the page language and never covers the footer language switch. Then the Nepali and Hindi sweep at 375, 390,
 * 430 and 1280 in light, dark and Forest: no sideways scroll, no raw key, no clipped Devanagari, axe 0 serious.
 * POL4_SHOTS=<dir> writes pol4-<page>-<width>-<theme>-<lang>.png.
 */
test.skip(process.env.E2E_POL4 !== "on", "POL4 runs with E2E_POL4=on (LANG_R104 and TRANSLATE_R116 on)");
const SHOTS = process.env.POL4_SHOTS;
let visitor = 0;
const ip = () => `10.166.${test.info().workerIndex % 200}.${++visitor}`;
const KEYISH = /(?<![@.\w/])(?:common|nav|shell|mail|mailfolder|mailtab|compose|tasks|taskview|taskstatus|tasktype|taskgroup|tasksort|priority|calendar|settings|auth|onboarding|notifications|notifview|notifcat|errors|empty|appearance|branding|site|landing|mywork|myday|whatsnew|time|theme|translate|read)\.[a-z0-9_]+(?![.\w@/])/;
const MONTHS_EN = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;

async function settle(p: Page) {
  await p.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 4_000 }).catch(() => {});
}
async function shot(p: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: `${SHOTS}/pol4-${name}.png` });
}
async function axe(p: Page, label: string) {
  const { violations } = await new AxeBuilder({ page: p }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function noSideScroll(p: Page, label: string) {
  const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(w.sw, `${label} sideways scroll`).toBeLessThanOrEqual(w.iw + 1);
}
async function noRawKeys(p: Page, label: string) {
  const text = await p.evaluate(() => document.body.innerText);
  expect(text.match(KEYISH)?.[0] ?? null, `${label} shows a raw key`).toBeNull();
}
/** Visible buttons and links whose Devanagari text is cut off (overflow hidden, wider than its box, no ellipsis on purpose). */
async function noClippedButtons(p: Page, label: string) {
  const cut = await p.evaluate(() => [...document.querySelectorAll("button, a, [role=tab]")].filter((e) => {
    const r = e.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2 || !/[\u0900-\u097F]/.test(e.textContent ?? "")) return false;
    if (e.matches('[data-testid="skip-link"]') || e.closest(".sr-only") || getComputedStyle(e).clip !== "auto") return false; // the skip link stays hidden until focused
    const s = getComputedStyle(e);
    if (s.textOverflow === "ellipsis" || e.querySelector(".truncate")) return false;
    return (s.overflow === "hidden" || s.overflowX === "hidden") && e.scrollWidth > e.clientWidth + 2;
  }).map((e) => (e.textContent ?? "").trim().slice(0, 30)));
  expect(cut, `${label} clipped Devanagari`).toEqual([]);
}
/** The element under points 21 px either side of the centre is still the control (a 44 px hit area). */
async function reach44(p: Page, sel: string, axis: "x" | "y") {
  return p.locator(sel).first().evaluate((e, ax) => {
    e.scrollIntoView({ block: "center", inline: "center" });
    const r = e.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = (dx: number, dy: number) => { const t = document.elementFromPoint(cx + dx, cy + dy); return !!t && (t === e || e.contains(t)); };
    return { w: Math.round(r.width), h: Math.round(r.height), ok: ax === "y" ? hit(0, -21) && hit(0, 21) : hit(-21, 0) && hit(21, 0) };
  }, axis);
}
async function demo(ctx: BrowserContext) {
  const p = await ctx.newPage();
  await p.goto("/login");
  const origin = new URL(p.url()).origin;
  const r = await p.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  await p.goto("/app");
  await expect.poll(async () => ((await (await p.request.get("/api/mailboxes")).json()).mailboxes ?? []).length, { timeout: 20_000 }).toBeGreaterThan(0);
  return { p, origin };
}
async function setLang(p: Page, origin: string, locale: "en" | "ne" | "hi") {
  expect((await p.request.patch("/api/account/preferences", { data: { locale }, headers: { origin } })).status()).toBe(200);
}

test.describe.configure({ mode: "default" });

test("MB-353 and MB-354: Set time slots and a dialog Close button keep 44 px hit areas on phones", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const { p, origin } = await demo(ctx);
  const r = await (await p.request.post("/api/apps/connect", { data: { app: "linkedin" }, headers: { origin } })).json() as { redirectUrl: string };
  await p.request.post(`/api/apps/accounts/${new URL(r.redirectUrl).searchParams.get("connected_account_id")}/confirm`, { headers: { origin } });
  await p.goto("/app/social");
  await expect(p.getByTestId("no-slots")).toBeVisible({ timeout: 20_000 });
  const slots = await reach44(p, '[data-testid="no-slots-set"]', "y");
  console.log("MB-353 Set time slots", JSON.stringify(slots));
  expect(slots.ok).toBe(true);
  await shot(p, "mb353-planner-375-light-en");
  // A dialog with a long description (Weekly time slots): Close stays 44 x 44.
  await p.getByTestId("no-slots-set").click();
  const close = p.locator("dialog[open]").getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeVisible();
  const box = (await close.boundingBox())!;
  console.log("MB-354 slots dialog Close", Math.round(box.width), Math.round(box.height));
  expect(box.width).toBeGreaterThanOrEqual(44);
  await p.keyboard.press("Escape");
  // The doc translate dialog (the one MB-354 measured).
  const doc = await (await p.request.post("/api/docs", { data: { title: "Weekly update", text: "Hello team, the report is ready." }, headers: { origin } })).json();
  await p.goto(`/app/docs/${doc.doc.id}`);
  await p.getByTestId("doc-lang-button").click();
  await p.getByRole("menuitem", { name: "Translate doc" }).click();
  const dlg = p.locator("dialog[open]");
  await expect(dlg.getByTestId("doc-translate-dialog")).toBeVisible();
  const x = await reach44(p, 'dialog[open] button[aria-label="Close"]', "x");
  console.log("MB-354 doc translate Close", JSON.stringify(x));
  expect(x.w).toBeGreaterThanOrEqual(44);
  expect(x.ok).toBe(true);
  await shot(p, "mb354-doc-translate-375-light-en");
  await ctx.close();
});

test("MB-355: Read aloud on a device with no voice says so plainly, in the language on screen", async ({ browser }) => {
  test.setTimeout(150_000);
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  await ctx.addInitScript(() => {
    class Utterance { text: string; lang = ""; rate = 1; voice: unknown = null; onend: (() => void) | null = null; onerror: ((e: { error: string }) => void) | null = null; constructor(t: string) { this.text = t; } }
    const synth = {
      speaking: false, paused: false, getVoices: () => [],
      speak(u: Utterance) { setTimeout(() => u.onerror?.({ error: "synthesis-failed" }), 20); },
      cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {},
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: Utterance, configurable: true });
  });
  const { p, origin } = await demo(ctx);
  const doc = await (await p.request.post("/api/docs", { data: { title: "Read me", text: "Hello team, the report is ready." }, headers: { origin } })).json();
  // R104B: the menu itself now follows the language too.
  const readAloud = { en: "Read doc aloud", ne: "डक ठूलो स्वरमा पढ्नुहोस्", hi: "डॉक ज़ोर से पढ़ें" }; // R104B
  for (const [l, words] of [["en", "no voice for reading aloud"], ["ne", "आवाज छैन"], ["hi", "कोई आवाज़ नहीं"]] as const) {
    await setLang(p, origin, l);
    await p.goto(`/app/docs/${doc.doc.id}`);
    await p.getByTestId("doc-lang-button").click();
    await p.getByRole("menuitem", { name: readAloud[l] }).click();
    await expect(p.getByText(words, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    await expect(p.getByText("Reading stopped")).toHaveCount(0);
    await shot(p, `mb355-novoice-390-light-${l}`);
  }
  await setLang(p, origin, "en");
  await ctx.close();
});

test("MB-356: mail folders and tabs, task views, filters, columns and due dates in Nepali and Hindi", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, viewport: { width: 1280, height: 860 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const { p, origin } = await demo(ctx);
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const t = await (await p.request.post("/api/tasks", { data: { title: "Send the quarterly report", due }, headers: { origin } })).json();
  expect(t).toBeTruthy();
  for (const [l, inbox, sent, filter, board] of [["ne", "इनबक्स", "पठाइएका", "फिल्टर", "बोर्ड"], ["hi", "इनबॉक्स", "भेजे गए", "फ़िल्टर", "बोर्ड"]] as const) {
    await setLang(p, origin, l);
    await p.setViewportSize({ width: 1280, height: 860 });
    await p.goto("/app/mail");
    await settle(p);
    const folders = p.getByRole("navigation", { name: /./ }).filter({ has: p.locator('a, button') }).filter({ hasText: inbox });
    await expect(folders.first()).toBeVisible({ timeout: 20_000 });
    await expect(folders.first()).toContainText(sent);
    const navText = await folders.first().innerText();
    for (const en of ["Starred", "Sent", "Drafts", "Spam", "Trash"]) expect(navText, `${l} folder ${en}`).not.toContain(en);
    const tabs = p.getByRole("tablist").filter({ has: p.locator('[data-testid^="split-tab-"]') });
    if (await tabs.count()) expect(await tabs.first().innerText()).not.toMatch(/\b(Primary|Updates|Promotions|Important|Other)\b/);
    await shot(p, `mb356-mail-1280-light-${l}`);
    await p.goto("/app/tasks?view=list");
    await settle(p);
    const header = p.getByTestId("tasks-header");
    await expect(header.getByRole("tab", { name: board })).toBeVisible();
    expect(await p.locator('input[role="combobox"]').first().getAttribute("placeholder")).not.toMatch(/Search or filter/);
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto("/app/tasks?view=list");
    await settle(p);
    await expect(p.getByTestId("phone-filter-button")).toContainText(filter);
    const rows = await p.getByTestId("phone-task-list").innerText();
    expect(rows, `${l} due dates`).not.toMatch(MONTHS_EN);
    await p.getByTestId("phone-filter-button").click();
    const sheet = p.locator("dialog[open]");
    await expect(sheet).toBeVisible();
    expect(await sheet.innerText()).not.toMatch(/\b(Assignee|Priority|Status|Anyone|Nobody|Any|To do|Doing|Done|Clear all)\b/);
    await shot(p, `mb356-filters-390-light-${l}`);
    await p.keyboard.press("Escape");
    await p.goto("/app/tasks?view=board");
    await settle(p);
    const pills = await p.getByTestId("column-pill").allInnerTexts();
    expect(pills.join(" | "), `${l} board columns`).not.toMatch(/\b(To do|In progress|In review|Done|Backlog|Doing)\b/);
    await shot(p, `mb356-board-390-light-${l}`);
    await p.goto("/app/notifications");
    await settle(p);
    expect(await p.getByTestId("triage-tab-later").innerText()).not.toMatch(/Later/);
  }
  await setLang(p, origin, "en");
  await ctx.close();
});

test("MB-357: the cookie notice follows the page language and never covers the footer language switch", async ({ browser }) => {
  test.setTimeout(150_000);
  for (const [loc, l, word] of [["ne-NP", "ne", "कुकी"], ["hi-IN", "hi", "कुकी"]] as const) {
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, locale: loc, extraHTTPHeaders: { "x-forwarded-for": ip() } });
    const p = await ctx.newPage();
    for (const w of [375, 390, 430, 1280]) {
      await p.setViewportSize({ width: w, height: w === 1280 ? 860 : 844 });
      await p.goto("/");
      await settle(p);
      const banner = p.getByTestId("cookie-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(word);
      expect(await banner.innerText()).not.toMatch(/essential cookies|\bOK\b/);
      await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await p.waitForTimeout(400);
      const en = p.getByTestId("language-switch-en");
      await en.scrollIntoViewIfNeeded();
      await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await p.waitForTimeout(200);
      const free = await en.evaluate((e) => { const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && (t === e || e.contains(t)); });
      expect(free, `${l} ${w} footer switch reachable with the notice up`).toBe(true);
      await noSideScroll(p, `home ${l} ${w}`);
      await shot(p, `mb357-footer-${w}-light-${l}`);
    }
    await ctx.close();
  }
});

const SWEEP: [string, string][] = [
  ["my-work", "/app/my-work"], ["mail", "/app/mail"], ["compose", "/app/mail?compose=1"], ["tasks", "/app/tasks?view=list"], ["board", "/app/tasks?view=board"],
  ["calendar", "/app/tasks?view=calendar"], ["settings", "/app/settings"], ["appearance", "/app/settings/appearance"], ["notifications", "/app/notifications"],
];
test("sweep: Nepali and Hindi at 375, 390, 430 and 1280 in light, dark and Forest", async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const { p, origin } = await demo(ctx);
  const run = async (l: string, theme: string, widths: number[]) => {
    for (const w of widths) {
      await p.setViewportSize({ width: w, height: w === 1280 ? 860 : w === 430 ? 932 : 844 });
      for (const [name, path] of SWEEP) {
        await p.goto(path);
        await settle(p);
        await expect.poll(() => p.evaluate(() => document.documentElement.lang)).toBe(l);
        const label = `${l} ${theme} ${name} ${w}`;
        await noSideScroll(p, label);
        await noRawKeys(p, label);
        await noClippedButtons(p, label);
        if (w === 390 || w === 1280) await axe(p, label);
        await shot(p, `${name}-${w}-${theme}-${l}`);
      }
    }
  };
  for (const l of ["ne", "hi"] as const) {
    await setLang(p, origin, l);
    await p.emulateMedia({ colorScheme: "light" });
    await run(l, "light", [375, 390, 430, 1280]);
    await p.emulateMedia({ colorScheme: "dark" });
    await run(l, "dark", [390, 1280]);
    await p.emulateMedia({ colorScheme: "light" });
  }
  // Forest brand.
  await p.setViewportSize({ width: 1280, height: 860 });
  await p.goto("/app/settings/branding");
  await expect(p.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await p.getByRole("button", { name: /Forest|वन|फ़ॉरेस्ट|फरेस्ट/ }).first().click();
  const save = p.getByTestId("brand-actions").getByRole("button");
  if (await save.count()) await save.last().click();
  await p.waitForTimeout(800);
  for (const l of ["hi", "ne"] as const) { await setLang(p, origin, l); await run(l, "forest", [390, 1280]); }
  await setLang(p, origin, "en");
  await ctx.close();
});

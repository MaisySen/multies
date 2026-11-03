import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * R104 languages (LANG_R104). Run with E2E_R104=on and LANG_R104=on for the language checks, or E2E_R104=off (and no
 * LANG_R104) for the flag off check. Pick Nepali in Settings, Appearance and walk the first wave pages without a reload;
 * reload keeps the choice; Hindi the same; no raw key shows; numbers and dates follow the language; the sign in and
 * public pages follow the browser language with a footer switch; admins can suggest a better wording; 375, 390, 430
 * and 1280 have no sideways scroll, 44 px targets on the new parts and axe 0 serious with lang attributes right.
 */
const ON = process.env.E2E_R104 === "on";
const OFF = process.env.E2E_R104 === "off";
test.skip(!ON && !OFF, "R104 runs with E2E_R104=on or off");
const SHOTS = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.104.${test.info().workerIndex % 200}.${++visitor}`;
let ctx: BrowserContext, page: Page, headers: Record<string, string>;

const PAGES: [string, string][] = [
  ["my-work", "/app/my-work"], ["mail", "/app/mail"], ["compose", "/app/mail?compose=1"], ["tasks", "/app/tasks"], ["calendar", "/app/tasks?view=calendar"],
  ["settings", "/app/settings"], ["appearance", "/app/settings/appearance"], ["notifications", "/app/notifications"], ["whats-new", "/changelog"],
];
const KEYISH = /(?<![@.\w/])(?:common|nav|shell|mail|compose|tasks|calendar|settings|auth|onboarding|notifications|errors|empty|appearance|branding|site|landing|mywork|whatsnew|time|theme)\.[a-z0-9_]+(?![.\w@/])/;

async function settle(p = page) {
  await p.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 4_000 }).catch(() => {});
}
async function shot(name: string, p = page) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: `${SHOTS}/r104-${name}.png` });
}
async function axe(label: string, p = page) {
  const { violations } = await new AxeBuilder({ page: p }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function noSideScroll(label: string, p = page) {
  const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(w.sw, `${label} sideways scroll`).toBeLessThanOrEqual(w.iw + 1);
}
async function targets(scope: string, label: string, p = page) {
  const small = await p.locator(`${scope} button:visible`).evaluateAll((els) => els
    .map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent ?? "").trim().slice(0, 24), h: Math.round(r.height), w: Math.round(r.width) }; })
    .filter((r) => r.h > 0 && (r.h < 44 || r.w < 44)));
  expect(small, `${label} tap targets`).toEqual([]);
}
async function noRawKeys(label: string, p = page) {
  const text = await p.evaluate(() => document.body.innerText);
  expect(text.match(KEYISH)?.[0] ?? null, `${label} shows a raw key`).toBeNull();
}
const lang = (p = page) => p.evaluate(() => document.documentElement.lang);

test.describe.configure({ mode: "serial" });
test.setTimeout(20 * 60_000);

test.beforeAll(async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  ctx = await browser.newContext({ baseURL: base, locale: "en-AU", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 200)));
  headers = { origin: new URL(base).origin };
  const s = Date.now().toString(36);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Sita Sharma", email: `owner-r104-${s}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "Asia/Kathmandu", locale: "en" }, headers })).status()).toBe(200);
  for (const title of ["Prepare the quarterly board pack with every regional number checked twice", "Call Bo"]) await page.request.post("/api/tasks", { data: { title }, headers });
});
test.afterAll(async () => { await ctx?.close(); });

test("flag off: English exactly, no picker, no switch, no language file", async ({ browser }) => {
  test.skip(!OFF);
  const chunks: string[] = [];
  page.on("request", (r) => { if (/\/assets\/(ne|hi)-[\w-]+\.js$/.test(r.url())) chunks.push(r.url()); });
  expect((await (await page.request.get("/api/config")).json()).langR104).toBe(false);
  expect((await page.request.get("/api/i18n/suggestions")).status()).toBe(404);
  await page.goto("/app/settings/appearance");
  await expect(page.getByTestId("appearance-settings")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("language-r104")).toHaveCount(0);
  await expect(page.getByTestId("wording-r104")).toHaveCount(0);
  expect(await lang()).toBe("en-AU");
  await page.goto("/app/my-work");
  await settle();
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  const anon = await browser.newContext({ baseURL: test.info().project.use.baseURL!, locale: "hi-IN", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const p = await anon.newPage();
  p.on("request", (r) => { if (/\/assets\/(ne|hi)-[\w-]+\.js$/.test(r.url())) chunks.push(r.url()); });
  await p.goto("/login");
  await expect(p.getByRole("button", { name: "Explore a demo workspace" })).toBeVisible({ timeout: 20_000 });
  await settle(p);
  expect(await lang(p)).toBe("en-AU");
  await expect(p.getByTestId("language-switch")).toHaveCount(0);
  await p.goto("/");
  await settle(p);
  await expect(p.getByTestId("language-switch")).toHaveCount(0);
  expect(await lang(p)).toBe("en-AU");
  await anon.close();
  expect(chunks).toEqual([]);
});

test("pick Nepali in Appearance: applied without a reload, saved, every first wave page in Nepali", async () => {
  test.skip(!ON);
  expect((await (await page.request.get("/api/config")).json()).langR104).toBe(true);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/appearance");
  const picker = page.getByTestId("language-picker");
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("language-en")).toHaveAttribute("aria-checked", "true");
  await shot("appearance-1280-light-en");
  await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
  await page.getByTestId("language-ne").click();
  await expect.poll(() => lang()).toBe("ne");
  await expect(page.getByTestId("language-ne")).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  await expect(page.getByTestId("language-r104")).toContainText("भाषा");
  await expect(page.getByTestId("language-draft-note")).toBeVisible();
  expect((await (await page.request.get("/api/account/me")).json()).user.locale).toBe("ne");
  await shot("appearance-1280-light-ne");
  await axe("appearance ne");
  // Reload keeps it.
  await page.reload();
  await expect.poll(() => lang()).toBe("ne");
  await expect(page.getByTestId("language-ne")).toHaveAttribute("aria-checked", "true");
  for (const [name, path] of PAGES) {
    await page.goto(path);
    await settle();
    await expect.poll(() => lang()).toBe("ne");
    await noRawKeys(`ne ${name}`);
    await noSideScroll(`ne ${name} 1280`);
    await axe(`ne ${name} 1280`);
    await shot(`${name}-1280-light-ne`);
  }
  // The rail and the page title are in Nepali; the changelog dates use Nepali digits.
  await page.goto("/app/my-work");
  await settle();
  await expect(page.getByTestId("icon-rail")).toContainText("मेल");
  expect(await page.title()).toContain("Multies");
  await page.goto("/changelog");
  await settle();
  await expect(page.locator("time").first()).toHaveText(/[०-९]/);
  await expect(page.getByTestId("changelog-entry").first()).toContainText("Multies नेपाली र हिन्दीमा");
});

test("phones 375, 390, 430 and themes: Nepali then Hindi, no sideways scroll, 44 px picker, axe", async () => {
  test.skip(!ON);
  for (const w of [375, 390, 430]) {
    await page.setViewportSize({ width: w, height: w === 430 ? 932 : w === 390 ? 844 : 812 });
    for (const [name, path] of PAGES) {
      await page.goto(path);
      await settle();
      await noSideScroll(`ne ${name} ${w}`);
      await noRawKeys(`ne ${name} ${w}`);
      if (w === 390) await axe(`ne ${name} 390`);
      await shot(`${name}-${w}-light-ne`);
    }
    await page.goto("/app/settings/appearance");
    await settle();
    await targets('[data-testid="language-r104"]', `picker ${w}`);
    await targets('[data-testid="phone-tabbar"]', `tab bar ${w}`);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  for (const w of [390, 1280]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
    for (const [name, path] of PAGES.slice(0, 7)) { await page.goto(path); await settle(); await noSideScroll(`ne dark ${name} ${w}`); await axe(`ne dark ${name} ${w}`); await shot(`${name}-${w}-dark-ne`); }
  }
  await page.emulateMedia({ colorScheme: "light" });
  // Hindi from the picker at 390.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/settings/appearance");
  await page.getByTestId("language-hi").click();
  await expect.poll(() => lang()).toBe("hi");
  for (const w of [390, 1280]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
    for (const [name, path] of PAGES) { await page.goto(path); await settle(); await noSideScroll(`hi ${name} ${w}`); await noRawKeys(`hi ${name} ${w}`); await axe(`hi ${name} ${w}`); await shot(`${name}-${w}-light-hi`); }
  }
  await page.goto("/changelog");
  await settle();
  await expect(page.locator("time").first()).toHaveText(/2026/);
  // Forest brand, both languages.
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button");
  if (await save.count()) await save.last().click();
  await page.waitForTimeout(800);
  for (const l of ["hi", "ne"] as const) {
    if (l === "ne") { await page.goto("/app/settings/appearance"); await page.getByTestId("language-ne").click(); await expect.poll(() => lang()).toBe("ne"); }
    for (const w of [390, 1280]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      for (const [name, path] of PAGES.slice(0, 7)) { await page.goto(path); await settle(); await noSideScroll(`${l} forest ${name} ${w}`); await axe(`${l} forest ${name} ${w}`); await shot(`${name}-${w}-forest-${l}`); }
    }
  }
});

test("admins suggest a better wording; it is kept for review and changes nothing by itself", async () => {
  test.skip(!ON);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/settings/appearance");
  const panel = page.getByTestId("wording-r104");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByTestId("wording-empty")).toBeVisible();
  await panel.getByTestId("wording-find").fill("Cancel");
  await panel.getByTestId("wording-matches").getByRole("button").first().click();
  await panel.getByTestId("wording-text").fill("छोड्नुहोस्");
  await panel.getByTestId("wording-send").click();
  await expect(panel.getByTestId("wording-list")).toContainText("छोड्नुहोस्");
  await targets('[data-testid="wording-r104"]', "wording 390");
  await axe("wording panel 390");
  await shot("wording-390-light-ne");
  // Not applied: the app still says the bundled word.
  await page.goto("/app/settings/appearance");
  await expect(page.getByTestId("wording-r104").getByTestId("wording-list")).toContainText("छोड्नुहोस्");
  // Back to English for the next checks.
  await page.getByTestId("language-en").click();
  await expect.poll(() => lang()).toBe("en-AU");
  await expect(page.getByTestId("language-r104")).toContainText("Language");
});

test("sign in and public pages follow the browser language, with a footer switch that sticks", async ({ browser }) => {
  test.skip(!ON);
  for (const [loc, l, word] of [["hi-IN", "hi", "साइन इन"], ["ne-NP", "ne", "साइन इन"]] as const) {
    const anon = await browser.newContext({ baseURL: test.info().project.use.baseURL!, locale: loc, extraHTTPHeaders: { "x-forwarded-for": ip() } });
    const p = await anon.newPage();
    for (const w of [375, 390, 430, 1280]) {
      await p.setViewportSize({ width: w, height: w === 1280 ? 860 : 844 });
      await p.goto("/login");
      await settle(p);
      await expect.poll(() => lang(p)).toBe(l);
      await expect(p.locator("main")).toContainText(word);
      await expect(p.getByTestId("language-switch")).toBeVisible();
      await noSideScroll(`login ${l} ${w}`, p);
      await noRawKeys(`login ${l} ${w}`, p);
      await targets('[data-testid="language-switch"]', `switch ${w}`, p);
      if (w === 390 || w === 1280) await axe(`login ${l} ${w}`, p);
      await shot(`login-${w}-light-${l}`, p);
      await p.goto("/");
      await settle(p);
      await expect.poll(() => lang(p)).toBe(l);
      await noSideScroll(`home ${l} ${w}`, p);
      await noRawKeys(`home ${l} ${w}`, p);
      if (w === 390 || w === 1280) await axe(`home ${l} ${w}`, p);
      await shot(`home-${w}-light-${l}`, p);
    }
    await p.emulateMedia({ colorScheme: "dark" });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto("/login"); await settle(p); await axe(`login ${l} dark`, p); await shot(`login-390-dark-${l}`, p);
    await p.emulateMedia({ colorScheme: "light" });
    // The footer switch: English, kept across a reload.
    await p.getByTestId("language-switch-en").click();
    await expect.poll(() => lang(p)).toBe("en-AU");
    await expect(p.locator("main")).toContainText("Sign in");
    await p.reload();
    await settle(p);
    await expect.poll(() => lang(p)).toBe("en-AU");
    await anon.close();
  }
});

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * R104B, the second wave of Nepali and Hindi (LANG_R104, no new flag). Run with E2E_R104B=on, LANG_R104=on and FILES_PLUS_R101=on (the Files page), or
 * E2E_R104B=off with no LANG_R104 for the flag off check. On: Docs, Chat, Calendar settings, Contacts, Deals, Meetings,
 * Files, the social composer, My Work and Appearance read in Nepali and then Hindi with no raw key, no sideways scroll at
 * 375 and 1280, axe 0 serious at 1280. MB-359: the composer's photo Crop and Remove are 44 px at 375, 390 and 430 in
 * light, dark and Forest. Off: English, no language chunk fetched, no Devanagari.
 */
const ON = process.env.E2E_R104B === "on";
const OFF = process.env.E2E_R104B === "off";
test.skip(!ON && !OFF, "R104B runs with E2E_R104B=on or off");
const SHOTS = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.204.${test.info().workerIndex % 200}.${++visitor}`;

const PAGES: [string, string][] = [
  ["docs", "/app/docs"], ["chat", "/app/chat"], ["calendar-settings", "/app/settings/calendar"], ["contacts", "/app/contacts"],
  ["deals", "/app/deals"], ["meetings", "/app/meetings"], ["files", "/app/files"], ["social-new", "/app/social/new"],
  ["my-work", "/app/my-work"], ["appearance", "/app/settings/appearance"],
];
const KEYISH = /(?<![@.\w/])(?:common|nav|shell|mail|compose|tasks|calendar|settings|docs|chat|contacts|meetings|files|home|social|mywork|whatsnew|appearance|branding)\.[a-z0-9_]+(?![.\w@/])/;
const DEVA = /[\u0900-\u097F]/g;

async function demo(ctx: BrowserContext) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 200)));
  await p.goto("/login");
  const origin = new URL(p.url()).origin;
  const r = await p.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  return { p, origin };
}
async function settle(p: Page) {
  await p.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 4_000 }).catch(() => {});
}
async function shot(p: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: `${SHOTS}/r104b-${name}.png` });
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
const lang = (p: Page) => p.evaluate(() => document.documentElement.lang);

test.describe.configure({ mode: "serial" });
test.setTimeout(20 * 60_000);

test("flag off: English, no language chunk, no Devanagari on the second wave pages", async ({ browser }) => {
  test.skip(!OFF);
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, locale: "hi-IN", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const { p } = await demo(ctx);
  const chunks: string[] = [];
  p.on("request", (r) => { if (/\/assets\/(ne|hi)-[\w-]+\.js$/.test(r.url())) chunks.push(r.url()); });
  expect((await (await p.request.get("/api/config")).json()).langR104).toBe(false);
  for (const [name, path] of PAGES) {
    await p.goto(path);
    await settle(p);
    expect(await lang(p), name).not.toMatch(/^(ne|hi)/);
    const text = await p.evaluate(() => document.body.innerText);
    expect(text.match(DEVA)?.length ?? 0, `${name} has Devanagari with the flag off`).toBe(0);
    expect(text.match(KEYISH)?.[0] ?? null, `${name} shows a raw key`).toBeNull();
  }
  expect(chunks).toEqual([]);
  await ctx.close();
});

for (const code of ["ne", "hi"] as const) {
  test(`${code}: the second wave pages read in ${code === "ne" ? "Nepali" : "Hindi"}`, async ({ browser }) => {
    test.skip(!ON);
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, locale: "en-AU", extraHTTPHeaders: { "x-forwarded-for": ip() } });
    const { p, origin } = await demo(ctx);
    expect((await (await p.request.get("/api/config")).json()).langR104).toBe(true);
    expect((await p.request.patch("/api/account/preferences", { data: { locale: code }, headers: { origin } })).status()).toBe(200);
    const thin: string[] = [];
    for (const [name, path] of PAGES) {
      for (const w of [1280, 375]) {
        await p.setViewportSize({ width: w, height: w === 375 ? 812 : 860 });
        await p.goto(path);
        await settle(p);
        await expect.poll(() => lang(p), { timeout: 15_000 }).toBe(code);
        const text = await p.evaluate(() => document.body.innerText);
        expect(text.match(KEYISH)?.[0] ?? null, `${code} ${name} shows a raw key`).toBeNull();
        const deva = text.match(DEVA)?.length ?? 0;
        if (deva < 40) thin.push(`${name} ${w}: ${deva}`);
        await noSideScroll(p, `${code} ${name} ${w}`);
        if (w === 1280) await axe(p, `${code} ${name} 1280`);
        await shot(p, `${name}-${w}-light-${code}`);
      }
    }
    expect(thin, "pages with almost no Devanagari").toEqual([]);
    await ctx.close();
  });
}

test("MB-359: social composer photo Crop and Remove are 44 px at 375, 390 and 430 in light, dark and Forest", async ({ browser }) => {
  test.skip(!ON);
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const { p, origin } = await demo(ctx);
  for (const app of ["linkedin"]) {
    const r = await (await p.request.post("/api/apps/connect", { data: { app }, headers: { origin } })).json() as { redirectUrl: string };
    const id = new URL(r.redirectUrl).searchParams.get("connected_account_id")!;
    await p.request.post(`/api/apps/accounts/${id}/confirm`, { headers: { origin } });
  }
  const jpeg = Buffer.from(await p.evaluate(async () => {
    const c = new OffscreenCanvas(800, 600); const g = c.getContext("2d")!;
    g.fillStyle = "#3a7"; g.fillRect(0, 0, 800, 600); g.fillStyle = "#fff"; g.fillRect(200, 150, 400, 300);
    const b = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
    let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s);
  }), "base64");
  const run = async (theme: string) => {
    for (const w of [375, 390, 430]) {
      await p.setViewportSize({ width: w, height: 844 });
      await p.goto("/app/social/new");
      await expect(p.getByTestId("social-composer")).toBeVisible({ timeout: 20_000 });
      const pick = p.getByTestId("pick-linkedin").getByRole("checkbox");
      if (!(await pick.isChecked())) await pick.check();
      await p.getByTestId("format-picker").getByRole("radio", { name: "Image" }).click();
      await p.getByTestId("social-image").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: jpeg });
      await expect(p.getByTestId("composer-images").locator("img")).toHaveCount(1, { timeout: 30_000 });
      for (const id of ["composer-image-crop", "composer-image-remove"]) {
        const box = (await p.getByTestId(id).first().boundingBox())!;
        expect(Math.round(box.height), `${id} ${w} ${theme} height`).toBeGreaterThanOrEqual(44);
        expect(Math.round(box.width), `${id} ${w} ${theme} width`).toBeGreaterThanOrEqual(44);
      }
      const [a, b] = [(await p.getByTestId("composer-image-crop").first().boundingBox())!, (await p.getByTestId("composer-image-remove").first().boundingBox())!];
      expect(a.x + a.width, `crop and remove do not overlap at ${w} ${theme}`).toBeLessThanOrEqual(b.x + 0.5);
      await p.getByTestId("composer-images").scrollIntoViewIfNeeded();
      await shot(p, `mb359-${w}-${theme}`);
      await noSideScroll(p, `composer ${w} ${theme}`);
    }
    await axe(p, `composer ${theme}`);
  };
  for (const scheme of ["light", "dark"] as const) { await p.emulateMedia({ colorScheme: scheme }); await run(scheme); }
  await p.emulateMedia({ colorScheme: "light" });
  await p.setViewportSize({ width: 1280, height: 860 });
  await p.goto("/app/settings/branding");
  await expect(p.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await p.getByRole("button", { name: "Forest", exact: true }).click();
  const save = p.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await p.waitForTimeout(800);
  await run("forest");
  // The Remove button still removes the photo.
  await p.getByTestId("composer-image-remove").first().click();
  await expect(p.getByTestId("composer-images").locator("img")).toHaveCount(0);
  await ctx.close();
});

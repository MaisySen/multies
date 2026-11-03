import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * SOCFIX (owner's client screen, Nov 4): Social > New post against the mock networks (COMPOSIO_BASE_URL
 * https://composio.mock, nothing reaches a real network). A 12 MB JPEG, an 8 MB PNG and a sideways phone photo
 * (EXIF orientation 6) are taken with no error and come out under 1 MB, upright, shape kept; HEIC in a browser that
 * cannot open it says so plainly. LinkedIn and Instagram read ready with images, a single Pinterest board is picked
 * by itself, the Reddit community field sits in its check row and the last one is offered next time. The tabs show
 * the brand ring for keyboard focus only, at 375, 390, 430 and 1280 in light, dark and Forest, 44 px tall on phones,
 * no sideways scroll, axe 0 serious.
 */
const SHOTS = process.env.SOCFIX_SHOTS;
let visitor = 0;
const ip = () => `10.171.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(ctx: BrowserContext) {
  const p = await ctx.newPage();
  await p.goto("/login");
  const origin = new URL(p.url()).origin;
  const r = await p.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  return { p, origin };
}
async function connect(p: Page, origin: string, apps: string[]) {
  const ids: Record<string, string> = {};
  for (const app of apps) {
    const r = await (await p.request.post("/api/apps/connect", { data: { app }, headers: { origin } })).json() as { redirectUrl: string };
    const id = new URL(r.redirectUrl).searchParams.get("connected_account_id")!;
    await p.request.post(`/api/apps/accounts/${id}/confirm`, { headers: { origin } });
    ids[app] = id;
  }
  return ids;
}
async function settle(p: Page) {
  await p.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 4_000 }).catch(() => {});
}
async function shot(p: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: `${SHOTS}/socfix-${name}.png`, fullPage: true });
}

/** A photo made in the page: noise so it does not compress away (bigger than a real photo per pixel), as bytes. */
async function photo(p: Page, kind: "jpeg" | "png" | "sideways", w: number, h: number): Promise<Buffer> {
  const b64 = await p.evaluate(async ({ kind, w, h }) => {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d")!;
    if (kind === "sideways") { g.fillStyle = "#c00"; g.fillRect(0, 0, w / 2, h); g.fillStyle = "#00c"; g.fillRect(w / 2, 0, w / 2, h); }
    else {
      const img = g.createImageData(w, h); const d = img.data; let s = 12345;
      const block = kind === "jpeg" ? 3 : 1;
      for (let y = 0; y < h; y += block) for (let x = 0; x < w; x += block) {
        s = (s * 1103515245 + 12345) >>> 0; const v = s >>> 8;
        for (let dy = 0; dy < block && y + dy < h; dy++) for (let dx = 0; dx < block && x + dx < w; dx++) { const i = ((y + dy) * w + x + dx) * 4; d[i] = v & 255; d[i + 1] = (v >> 8) & 255; d[i + 2] = (v >> 16) & 255; d[i + 3] = 255; }
      }
      g.putImageData(img, 0, 0);
    }
    const blob = await c.convertToBlob({ type: kind === "png" ? "image/png" : "image/jpeg", quality: kind === "jpeg" ? 0.97 : 0.9 });
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (kind === "sideways") {
      // EXIF APP1 with orientation 6 (turn a quarter right), right after the start marker.
      const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
      const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
      const seg = [0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1];
      const out = new Uint8Array(bytes.length + seg.length); out.set(bytes.subarray(0, 2)); out.set(seg, 2); out.set(bytes.subarray(2), 2 + seg.length); bytes = out;
    }
    let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }, { kind, w, h });
  return Buffer.from(b64, "base64");
}

async function openComposer(p: Page, apps: string[]) {
  await p.goto("/app/social/new");
  await expect(p.getByTestId("social-composer")).toBeVisible({ timeout: 20_000 });
  await p.getByTestId("social-text").fill("Student visa update: new rules from December");
  for (const a of apps) {
    const pick = p.getByTestId(`pick-${a}`).getByRole("checkbox");
    if (!(await pick.isChecked())) await pick.check();
  }
}

test.describe.configure({ mode: "default" });

test("SOCFIX: big photos just work, checks read ready, Reddit community remembered, posted to the mock networks", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const { p, origin } = await demo(ctx);
  p.setDefaultTimeout(30_000);
  await p.setViewportSize({ width: 390, height: 844 });
  await connect(p, origin, ["linkedin", "instagram", "pinterest", "reddit"]);
  await openComposer(p, ["linkedin"]);
  await p.getByTestId("format-picker").getByRole("radio", { name: "Image" }).click();

  // A 12 MB JPEG: no error, an optimised note, the stored copy under 1 MB with its shape kept.
  const big = await photo(p, "jpeg", 4000, 3000);
  expect(big.length, "fixture is a 12 MB class JPEG").toBeGreaterThan(9 * 1024 * 1024);
  await p.getByTestId("social-image").setInputFiles({ name: "IMG_2041.jpg", mimeType: "image/jpeg", buffer: big });
  await expect(p.getByTestId("image-optimised")).toContainText(/Optimised for posting, [\d.]+ MB to \d+ KB/, { timeout: 30_000 });
  await expect(p.getByTestId("image-error")).toHaveCount(0);
  const thumb = p.getByTestId("composer-images").locator("img").first();
  const dims = await thumb.evaluate((i: HTMLImageElement) => ({ w: i.naturalWidth, h: i.naturalHeight, bytes: Math.round((i.src.length - i.src.indexOf(",") - 1) * 0.75) }));
  expect(Math.max(dims.w, dims.h)).toBeLessThanOrEqual(2048);
  expect(Math.abs(dims.w / dims.h - 4 / 3)).toBeLessThan(0.01);
  expect(dims.bytes).toBeLessThan(1_000_000);
  await shot(p, "upload-390");

  // An 8 MB PNG in a carousel, then a sideways phone photo comes out upright.
  await p.getByTestId("format-picker").getByRole("radio", { name: "Carousel" }).click();
  const png = await photo(p, "png", 3000, 2500);
  expect(png.length).toBeGreaterThan(7 * 1024 * 1024);
  await p.getByTestId("social-image").setInputFiles({ name: "poster.png", mimeType: "image/png", buffer: png });
  await expect(p.getByTestId("composer-images").locator("img")).toHaveCount(2, { timeout: 30_000 });
  const side = await photo(p, "sideways", 800, 400);
  await p.getByTestId("social-image").setInputFiles({ name: "IMG_2042.jpg", mimeType: "image/jpeg", buffer: side });
  await expect(p.getByTestId("composer-images").locator("img")).toHaveCount(3, { timeout: 30_000 });
  const all = await p.getByTestId("composer-images").locator("img").evaluateAll((list) => list.map((i) => { const im = i as HTMLImageElement; return { w: im.naturalWidth, h: im.naturalHeight, bytes: Math.round((im.src.length - im.src.indexOf(",") - 1) * 0.75) }; }));
  for (const d of all) expect(d.bytes).toBeLessThan(1_000_000);
  expect(Math.abs(all[1]!.w / all[1]!.h - 3000 / 2500)).toBeLessThan(0.01);
  expect(all[2], "EXIF quarter turn applied: the sideways photo is upright (portrait)").toMatchObject({ w: 400, h: 800 });
  await expect(p.getByTestId("image-optimised")).toContainText("photos optimised for posting");

  // HEIC where the browser cannot open it: one plain sentence, nothing else breaks.
  await p.getByTestId("social-image").setInputFiles({ name: "IMG_2043.HEIC", mimeType: "image/heic", buffer: Buffer.from("not really a heic file") });
  await expect(p.getByTestId("image-error")).toHaveText(/This browser can't open HEIC photos|could not be read/);
  await expect(p.getByTestId("composer-images").locator("img")).toHaveCount(3);

  // Checks: LinkedIn and Instagram ready with images, the only Pinterest board picked by itself, Reddit's field in its row.
  for (const a of ["instagram", "pinterest", "reddit"]) await p.getByTestId(`pick-${a}`).getByRole("checkbox").check();
  const row = (a: string) => p.getByTestId("composer-checks").locator(`[data-testid="check-row"][data-app="${a}"]`);
  await expect(row("linkedin")).toHaveAttribute("data-state", "ready");
  await expect(row("instagram")).toHaveAttribute("data-state", "ready");
  await expect(row("pinterest")).toHaveAttribute("data-state", "changed"); // one pin takes the first image
  await expect(row("pinterest")).toContainText("First image only");
  await expect(row("reddit")).toHaveAttribute("data-state", "out");
  const field = row("reddit").getByTestId("check-target-reddit");
  await expect(field).toBeVisible();
  const box = await field.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await shot(p, "checks-out-390");
  await field.fill("r/studentvisas");
  await expect(row("reddit")).toHaveAttribute("data-state", "changed");
  await expect(row("reddit")).toContainText("Text only");
  await shot(p, "checks-390");

  // Send (mock networks only): the upload is the shrunk copy, every account goes.
  const res = p.waitForResponse((r) => r.url().endsWith("/api/social/posts") && r.request().method() === "POST");
  await p.getByTestId("social-submit").click();
  const sent = await res;
  const body = sent.request().postDataJSON() as { images: { dataB64?: string }[] };
  for (const im of body.images) if (im.dataB64) expect(im.dataB64.length * 0.75).toBeLessThan(1_000_000);
  expect(sent.status(), await sent.text()).toBe(201);
  const id = ((await sent.json()) as { post: { id: string } }).post.id;
  await expect.poll(async () => {
    const one = (await (await p.request.get(`/api/social/posts/${id}`)).json()) as { post?: { targets: { app: string; status: string }[] } };
    return one.post?.targets.map((t) => `${t.app}:${t.status}`).sort().join(",") ?? "";
  }, { timeout: 30_000 }).toBe("instagram:sent,linkedin:sent,pinterest:sent,reddit:sent");

  // Next post: the community used last is already there.
  await openComposer(p, ["reddit"]);
  await expect(p.getByTestId("target-reddit")).toHaveValue("r/studentvisas", { timeout: 15_000 });
  // The field sits on its own line under the account on a phone, never over its name or logo.
  const fieldBox = (await p.getByTestId("target-reddit").boundingBox())!;
  const nameBox = (await p.getByTestId("pick-reddit").locator("label").boundingBox())!;
  expect(fieldBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
  const sw = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sw).toBeLessThanOrEqual(1);
  await expect(p.getByTestId("composer-checks").locator('[data-app="reddit"]')).toHaveAttribute("data-state", "ready");
  await ctx.close();
});

test("SOCFIX: tabs show the brand ring for keyboard focus only, 44 px on phones, at 375 to 1280 in light, dark and Forest", async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const { p, origin } = await demo(ctx);
  p.setDefaultTimeout(20_000);
  await connect(p, origin, ["linkedin", "reddit"]);
  // The workspace's own accent, read where the tab is (an accent is scoped to the app shell).
  const brand = (sel: string) => p.locator(sel).evaluate((t) => { const e = document.createElement("span"); e.style.color = "var(--color-brand)"; t.parentElement!.append(e); const c = getComputedStyle(e).color; e.remove(); return c; });
  const ring = (sel: string) => p.locator(sel).evaluate((e) => { const s = getComputedStyle(e); return { style: s.outlineStyle, color: s.outlineColor, width: s.outlineWidth, shadow: s.boxShadow, focused: document.activeElement === e }; });
  const check = async (w: number, theme: string) => {
    await p.setViewportSize({ width: w, height: w === 1280 ? 860 : w === 430 ? 932 : 844 });
    await openComposer(p, ["linkedin", "reddit"]); // both take text, so neither is greyed out
    await settle(p);
    const label = `${theme} ${w}`;
    const tab = '[data-testid="network-tabs"] [role="tab"]#tab-linkedin';
    // A click shows no ring at all (focus stays in the text, so no browser draws its own).
    await p.getByTestId("social-text").focus();
    await p.locator(tab).click();
    await expect(p.locator(tab)).toHaveAttribute("aria-selected", "true");
    let r = await ring(tab);
    expect(r.focused, `${label} click keeps focus in the text`).toBe(false);
    expect(r.style, `${label} click shows no outline`).toBe("none");
    expect(r.shadow, `${label} click shows no ring`).not.toMatch(/0px 0px 0px 2px/);
    // Keyboard focus shows the brand ring.
    await p.locator(tab).focus();
    await p.keyboard.press("Shift+Tab");
    await p.keyboard.press("Tab");
    r = await ring(tab);
    expect(r.focused, label).toBe(true);
    expect(r.style, `${label} keyboard ring`).toBe("solid");
    expect(r.width).toBe("2px");
    // transition-colors eases the ring in; it settles on the workspace accent.
    const want = await brand(tab);
    await expect.poll(async () => (await ring(tab)).color, { timeout: 3_000 }).toBe(want);
    if (w < 640) {
      const tabs = await p.locator('[data-testid="network-tabs"] [role="tab"]').evaluateAll((l) => l.map((e) => Math.round(e.getBoundingClientRect().height)));
      for (const h of tabs) expect(h, `${label} tab height`).toBeGreaterThanOrEqual(44);
    }
    if (w >= 1280) {
      const pt = p.getByTestId("composer-preview").getByRole("tab", { name: "Reddit" });
      await pt.click();
      await expect(pt).toHaveAttribute("aria-selected", "true");
      const s = await pt.evaluate((e) => ({ style: getComputedStyle(e).outlineStyle, focused: document.activeElement === e }));
      expect(s, `${label} preview tab click`).toEqual({ style: "none", focused: false });
    }
    const sw = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(sw.sw, `${label} sideways scroll`).toBeLessThanOrEqual(sw.iw + 1);
    if (w === 390 || w === 1280) {
      const { violations } = await new AxeBuilder({ page: p }).exclude("[data-sonner-toaster]").analyze();
      const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
    }
    await p.locator(tab).focus();
    await p.keyboard.press("Shift+Tab"); await p.keyboard.press("Tab");
    await shot(p, `ring-${w}-${theme}`);
  };
  await p.emulateMedia({ colorScheme: "light" });
  for (const w of [375, 390, 430, 1280]) await check(w, "light");
  await p.emulateMedia({ colorScheme: "dark" });
  for (const w of [375, 390, 430, 1280]) await check(w, "dark");
  await p.emulateMedia({ colorScheme: "light" });
  await p.setViewportSize({ width: 1280, height: 860 });
  await p.goto("/app/settings/branding");
  await expect(p.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await p.getByRole("button", { name: /Forest/ }).first().click();
  const save = p.getByTestId("brand-actions").getByRole("button");
  if (await save.count()) await save.last().click();
  await p.waitForTimeout(800);
  for (const w of [375, 390, 430, 1280]) await check(w, "forest");
  await ctx.close();
});

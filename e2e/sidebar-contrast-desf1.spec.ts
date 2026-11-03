import { test, expect, type Page } from "@playwright/test";

/**
 * DESF1 (owner screenshot 12:25 Sydney Nov 3): with DES1 on, a workspace brand sidebar colour left white sidebar text on
 * the light desktop canvas. This measures the computed contrast of every text and icon in the icon rail, the section
 * sidebar (workspace name, section header, items, badges) and the phone drawer, against the ground actually painted
 * under it: text 4.5:1, icons 3:1. Default look, Forest, and a dark brand sidebar (Midnight), light and dark, at 1280
 * and 1600, and the drawer at 375, 390 and 430. It also checks count grouping (15,536) and the 99+ badge cap.
 */
let visitor = 0;
const ip = () => `10.159.${test.info().workerIndex % 200}.${++visitor}`;

type Finding = { text: string; ratio: number; need: number; fg: string; bg: string };

async function measure(page: Page, roots: string): Promise<{ checked: number; bad: Finding[] }> {
  return page.evaluate((sel) => {
    const cv = document.createElement("canvas"); cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    const rgba = (c: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] =>
      [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])) as [number, number, number];
    const ground = (el: Element | null): [number, number, number] => {
      const layers: [number, number, number, number][] = [];
      for (let e = el; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
      }
      let base: [number, number, number] = [255, 255, 255];
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
      return base;
    };
    const lum = (c: [number, number, number]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a: [number, number, number], b: [number, number, number]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const opacity = (el: Element) => { let o = 1; for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
    const hex = (c: number[]) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const bad: { text: string; ratio: number; need: number; fg: string; bg: string }[] = [];
    let checked = 0;
    for (const root of Array.from(document.querySelectorAll(sel))) {
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (!visible(el)) continue;
        const isIcon = el.tagName.toLowerCase() === "svg";
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && (n.textContent || "").trim()).map((n) => n.textContent!.trim()).join(" ");
        if (!isIcon && !own) continue;
        if (el.closest("[aria-hidden='true']") && !isIcon) continue;
        if (el.closest("input,textarea")) continue;
        const cs = getComputedStyle(el);
        const fgRaw = rgba(isIcon ? (cs.color || cs.fill) : cs.color);
        const bg = ground(el);
        const fg = over([fgRaw[0], fgRaw[1], fgRaw[2], fgRaw[3] * opacity(el)], bg);
        const r = ratio(fg, bg); const need = isIcon ? 3 : 4.5; checked++;
        if (r < need - 0.01) bad.push({ text: isIcon ? `icon in ${(el.closest("a,button")?.textContent || "").trim().slice(0, 20)}` : own.slice(0, 30), ratio: Math.round(r * 100) / 100, need, fg: hex(fg), bg: hex(bg) });
      }
    }
    return { checked, bad };
  }, roots);
}

const DESKTOP = '[data-testid="icon-rail"], [data-testid="context-sidebar"]';
const DRAWER = '[role="dialog"][aria-label="Navigation"] aside';

async function signIn(page: Page) {
  if (!process.env.E2E_BASE_URL) await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}

async function brand(page: Page, preset: "Forest" | "Midnight" | null) {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  if (preset) {
    await page.getByRole("button", { name: preset, exact: true }).first().click();
    await page.getByRole("button", { name: "Save brand" }).click();
  } else {
    const reset = page.getByRole("button", { name: "Reset to Multies default" });
    if (await reset.isEnabled().catch(() => false)) { await reset.click(); await page.getByRole("button", { name: "Reset", exact: true }).click(); }
  }
  await page.waitForTimeout(800);
}

async function desktop(page: Page, label: string, out: string[]) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const w of [1280, 1600]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto("/app/my-work");
      await expect(page.locator('[data-testid="context-sidebar"]').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(500);
      const { checked, bad } = await measure(page, DESKTOP);
      expect(checked, `${label} ${scheme} ${w}: nothing measured`).toBeGreaterThan(15);
      for (const b of bad) out.push(`${label} ${scheme} ${w}: "${b.text}" ${b.ratio}:1 (need ${b.need}) ${b.fg} on ${b.bg}`);
    }
  }
}

async function drawer(page: Page, label: string, out: string[]) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const [w, h] of [[375, 812], [390, 844], [430, 932]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/app/my-work");
      const more = page.getByRole("button", { name: "More", exact: true }).last();
      await more.click({ timeout: 20_000 });
      await expect(page.locator(DRAWER)).toBeVisible();
      await page.waitForTimeout(400);
      const { checked, bad } = await measure(page, DRAWER);
      expect(checked, `${label} drawer ${scheme} ${w}: nothing measured`).toBeGreaterThan(8);
      for (const b of bad) out.push(`${label} drawer ${scheme} ${w}: "${b.text}" ${b.ratio}:1 (need ${b.need}) ${b.fg} on ${b.bg}`);
    }
  }
}

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

test("sidebar, section header and icon rail text keep AA contrast: default, Forest and a dark brand sidebar", async ({ page }) => {
  await signIn(page);
  const out: string[] = [];
  for (const preset of [null, "Forest", "Midnight"] as const) {
    await brand(page, preset);
    await desktop(page, preset ?? "default", out);
    await drawer(page, preset ?? "default", out);
  }
  await brand(page, null);
  expect(out, out.join("\n")).toEqual([]);
});

test("light mode is layered: tinted canvas, its own sidebar surface, tinted sheet and white cards with an edge", async ({ page }) => {
  test.skip(process.env.DESIGN_DES1 !== "on", "the layers are the design pass (flag on only)");
  await signIn(page);
  await brand(page, null);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/app/my-work");
  await expect(page.getByTestId("today-mail")).toBeVisible({ timeout: 20_000 });
  const g = await page.evaluate(() => {
    const bg = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : "none");
    const card = document.querySelector('[data-testid="today-mail"]');
    return {
      canvas: bg(document.querySelector(".app-shell")),
      sidebar: bg(document.querySelector('.app-shell .glass-sidebar:not([data-testid="icon-rail"])')),
      sheet: bg(document.querySelector('.app-shell div:has(> [data-desktop-topbar])')),
      card: bg(card), cardShadow: card ? getComputedStyle(card).boxShadow : "none",
    };
  });
  const white = /^rgba?\(255, 255, 255(, 1)?\)$/;
  expect(g.canvas).not.toMatch(white);
  expect(g.sheet).not.toMatch(white);
  expect(new Set([g.canvas, g.sidebar, g.sheet]).size, JSON.stringify(g)).toBe(3);
  expect(g.card).toMatch(white);
  expect(g.cardShadow).not.toBe("none");
});

test("count tiles group thousands and nav badges stop at 99+", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/counts**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    mail: { inbox: 15536, important: 1204, other: 0 }, chat: { unread: 2345, mentions: 3 }, notifications: { unread: 150 }, triage: 1200, tasks: { dueToday: 1500, overdue: 0 }, at: new Date().toISOString(),
  }) }));
  await page.goto("/app/my-work");
  const mail = page.getByTestId("today-mail");
  await expect(mail).toContainText("15,536", { timeout: 20_000 });
  await expect(mail).not.toContainText("15536");
  await expect(mail).toContainText("1,204 important");
  const badges = await page.locator('[data-testid="icon-rail"] [aria-label$="unread"], [data-testid="icon-rail"] [aria-label$="need you"], [data-testid="context-sidebar"] [data-badge]').allTextContents();
  expect(badges.length).toBeGreaterThan(0);
  for (const b of badges) expect(b.trim(), `badge ${b}`).toMatch(/^(\d{1,2}|99\+)$/);
  expect(badges.map((b) => b.trim())).toContain("99+");
});

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * POL2 polish round (needs PEOPLE_R126, TOURS_R130 and E2E_TD1=on): Staff pages name themselves, one New asset
 * button, a filled button's hover keeps its text at AA in light, dark and Forest, Settings Tours says "1 step" and
 * marks rail only steps (MB-327, MB-329), the AI switch states itself (MB-325). Axe at 1280 and 390 in all three themes.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.198.${test.info().workerIndex % 200}.${++visitor}`;
let ctx: BrowserContext, page: Page, headers: Record<string, string>;
let tourId = "";

async function axe(label: string) {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5_000 }).catch(() => {});
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/pol2-${name}.png` });
}
async function forest() {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.isEnabled().catch(() => false)) await save.click();
  await page.waitForTimeout(800);
}
/** The contrast of a hovered button's text on its own background, read from the page. */
async function hoveredContrast(name: string): Promise<number> {
  const btn = page.getByRole("button", { name, exact: true }).first();
  await btn.hover();
  await page.waitForTimeout(400);
  return btn.evaluate((el) => {
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
    const cs = getComputedStyle(el);
    const probe = document.createElement("div"); probe.style.color = cs.backgroundColor; document.body.appendChild(probe);
    const bg = getComputedStyle(probe).color; probe.remove();
    const [a, b] = [lum(rgb(cs.color)), lum(rgb(bg))].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
  headers = { origin: new URL(base).origin };
  const s = Date.now().toString(36);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Olive Owner", email: `owner-pol2-${s}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  const t = await page.request.post("/api/tours/admin", { data: { name: "Side menu tour", page: "/app/tasks", audience: "members", newDays: null, steps: [{ target: "rail-docs", title: "Docs", body: "Docs live here." }] }, headers });
  expect(t.status()).toBe(200);
  tourId = (await t.json()).id;
});
test.afterAll(async () => { await ctx?.close(); });

test("Staff pages say Staff in the tab title; no assets shows one New asset button", async () => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/contacts/staff");
  await expect(page.getByTestId("staff-page")).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveTitle(/^Staff · Multies$/);
  await page.goto("/app/contacts/staff?view=org");
  await expect(page.getByTestId("staff-page")).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveTitle(/^Staff · Multies$/);
  await page.goto("/app/contacts/staff?view=assets");
  await expect(page.getByText("No assets yet")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "New asset", exact: true })).toHaveCount(1);
  await expect(page.getByTestId("asset-new")).toHaveCount(1);
});

test("a filled button keeps AA contrast on hover in light, dark and Forest", async () => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/app/contacts/staff?view=assets");
    await expect(page.getByText("No assets yet")).toBeVisible({ timeout: 20_000 });
    expect(await hoveredContrast("New asset"), scheme).toBeGreaterThanOrEqual(4.5);
  }
  await forest();
  await page.goto("/app/contacts/staff?view=assets");
  await expect(page.getByText("No assets yet")).toBeVisible({ timeout: 20_000 });
  expect(await hoveredContrast("New asset"), "forest").toBeGreaterThanOrEqual(4.5);
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  const reset = page.getByRole("button", { name: /^(Multies|Default)/ }).first();
  if (await reset.count()) { await reset.click(); const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i }); if (await save.isEnabled().catch(() => false)) await save.click(); await page.waitForTimeout(500); }
});

test("Settings Tours: 1 step, and a rail only tour is marked computers and tablets only (MB-327, MB-329)", async () => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app/settings/tours");
  await expect(page.getByTestId("tours-settings")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/^Phones only\. 1 step\. Started from the account menu, Tours\.$/)).toBeVisible();
  await expect(page.getByText(/\b1 steps\b/)).toHaveCount(0);
  await expect(page.getByTestId(`tour-row-${tourId}`)).toContainText("1 step · Computers and tablets only");
  await page.getByTestId(`tour-row-${tourId}`).getByTestId("tour-edit").click();
  await expect(page.getByTestId("tour-step-phone-0")).toHaveText("Not shown on phones");
  await expect(page.getByTestId("tour-desktop-only")).toBeVisible();
  await shot("tour-editor-1280-light");
});

test("the AI switch says its state to screen readers and in words (MB-325)", async () => {
  await page.goto("/app/settings#ai-trust");
  const sw = page.getByTestId("ai-trust-switch");
  await expect(sw).toBeVisible({ timeout: 20_000 });
  await expect(sw).toHaveAttribute("role", "switch");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Allow AI in this workspace" })).toBeChecked();
  await expect(page.getByTestId("ai-trust-state")).toHaveText("On");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false", { timeout: 10_000 });
  await expect(page.getByTestId("ai-trust-state")).toHaveText("Off");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
});

test("axe and shots at 1280 and 390 in light, dark and Forest on every touched page", async () => {
  test.setTimeout(300_000);
  const pages: [string, string, string][] = [
    ["staff", "/app/contacts/staff", "staff-page"], ["assets", "/app/contacts/staff?view=assets", "asset-new"],
    ["tours", "/app/settings/tours", "tours-settings"], ["tour-edit", `/app/settings/tours?edit=${encodeURIComponent(tourId)}`, "tour-step-0"],
    ["ai", "/app/settings#ai-trust", "ai-trust-switch"],
  ];
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      for (const [name, url, id] of pages) {
        await page.goto(url);
        await expect(page.getByTestId(id).first()).toBeVisible({ timeout: 20_000 });
        await shot(`${name}-${w}-${theme}`);
        await axe(`${name} ${w} ${theme}`);
      }
    }
  };
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await run(scheme); }
  await page.setViewportSize({ width: 1280, height: 860 });
  await forest();
  await run("forest");
});

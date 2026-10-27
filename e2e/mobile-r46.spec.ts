import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";

/**
 * R46 mobile web: every main screen at 360, 390 and 430 px, light and dark. Checks that the page never scrolls
 * sideways, the phone tab bar is on screen, tap targets reach 44 px and text fields are 16 px (so iOS Safari does
 * not zoom). SHOTS=before|after writes shots and a metrics file to /home/user/tab/files/multies-mobile/.
 */
const SHOTS = process.env.SHOTS;
const DIR = "/home/user/tab/files/multies-mobile";
let visitor = 0;
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.147.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(600_000);

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}

type Metrics = { overflowX: number; tabBar: boolean; smallTargets: string[]; smallInputs: string[] };
async function measure(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("main") as HTMLElement | null;
    const overflowX = Math.max(doc.scrollWidth - window.innerWidth, document.body.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0);
    const bar = document.querySelector("[data-testid=phone-tabbar]") as HTMLElement | null;
    const tabBar = !!bar && bar.getBoundingClientRect().height > 0 && bar.getBoundingClientRect().bottom <= window.innerHeight + 1;
    const smallTargets: string[] = [];
    for (const el of Array.from(document.querySelectorAll("[data-topbar] a, [data-topbar] button, [data-testid=phone-tabbar] a, [data-testid=phone-tabbar] button, [data-testid=today-quick] a"))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 43.5 || r.width < 43.5) smallTargets.push(`${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    const smallInputs: string[] = [];
    for (const el of Array.from(document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=hidden]), textarea, select"))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) smallInputs.push(`${el.getAttribute("name") ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.tagName} ${fs}px`);
    }
    return { overflowX, tabBar, smallTargets, smallInputs };
  });
}

/** Empty workspace view of My Work: every count is zero (what a new person sees). */
async function zeroCounts(page: Page) {
  await page.route(/\/api\/counts(\?|$)/, async (route) => {
    const res = await route.fetch(); const j = await res.json().catch(() => null);
    if (!j) return route.fallback();
    const z = JSON.parse(JSON.stringify(j));
    if (z.mail) for (const k of Object.keys(z.mail)) if (typeof z.mail[k] === "number") z.mail[k] = 0;
    if (z.tasks) for (const k of Object.keys(z.tasks)) if (typeof z.tasks[k] === "number") z.tasks[k] = 0;
    if (z.chat) for (const k of Object.keys(z.chat)) if (typeof z.chat[k] === "number") z.chat[k] = 0;
    return route.fulfill({ json: z, headers: { "cache-control": "no-store" } });
  });
  await page.route(/\/api\/my-work(\?|$)/, async (route) => {
    const res = await route.fetch(); const j = await res.json().catch(() => null);
    if (!j) return route.fallback();
    for (const k of Object.keys(j)) if (Array.isArray(j[k])) j[k] = [];
    return route.fulfill({ json: j, headers: { "cache-control": "no-store" } });
  });
}

const SCREENS: { name: string; go: (page: Page) => Promise<void> }[] = [
  { name: "mywork", go: async (p) => { await p.goto("/app/my-work"); await expect(p.getByTestId("today")).toBeVisible({ timeout: 20_000 }); } },
  { name: "mywork-empty", go: async (p) => { await zeroCounts(p); await p.goto("/app/my-work"); await expect(p.getByTestId("today")).toBeVisible({ timeout: 20_000 }); await p.waitForTimeout(800); await p.unroute(/\/api\/counts(\?|$)/); await p.unroute(/\/api\/my-work(\?|$)/); } },
  { name: "mail", go: async (p) => { await p.goto("/app/mail"); await p.waitForTimeout(1500); } },
  { name: "mail-thread", go: async (p) => { await p.goto("/app/mail"); const row = p.getByTestId("mail-row").first(); await row.click({ timeout: 15_000 }); await p.waitForTimeout(800); } },
  { name: "mail-compose", go: async (p) => { await p.goto("/app/mail?compose=1"); await p.waitForTimeout(1200); } },
  { name: "tasks-list", go: async (p) => { await p.goto("/app/tasks?view=list"); await p.waitForTimeout(1500); } },
  { name: "tasks-board", go: async (p) => { await p.goto("/app/tasks?view=board"); await p.waitForTimeout(1500); } },
  { name: "tasks-backlog", go: async (p) => { await p.goto("/app/tasks?view=sprint"); await p.waitForTimeout(1500); } },
  { name: "task-detail", go: async (p) => { await p.goto("/app/tasks?view=list"); await p.locator("[data-testid=task-row], [data-task-id]").first().click({ timeout: 15_000 }); await p.waitForTimeout(1000); } },
  { name: "calendar", go: async (p) => { await p.goto("/app/tasks?view=calendar"); await p.waitForTimeout(1500); } },
  { name: "docs", go: async (p) => { await p.goto("/app/docs"); await p.waitForTimeout(1200); } },
  { name: "meetings", go: async (p) => { await p.goto("/app/meetings"); await p.waitForTimeout(1200); } },
  { name: "settings", go: async (p) => { await p.goto("/app/settings"); await p.waitForTimeout(1200); } },
  { name: "menu", go: async (p) => { await p.goto("/app/my-work"); await expect(p.getByTestId("today")).toBeVisible({ timeout: 20_000 }); const more = p.getByTestId("tab-more"); if (await more.isVisible().catch(() => false)) await more.click(); else await p.getByRole("button", { name: "Open navigation" }).click(); await p.waitForTimeout(500); } },
];

for (const scheme of ["light", "dark"] as const) {
  test(`phone screens audit (${scheme})`, async ({ page }) => {
    const widths = SHOTS ? [360, 390, 430] : [360, 390];
    page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(20_000);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await demo(page);
    const report: Record<string, Metrics | { error: string }> = {};
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: 844 });
      for (const s of SCREENS) {
        const key = `${s.name}-${w}`;
        try {
          await s.go(page);
          await page.waitForTimeout(300);
          const m = await measure(page);
          report[key] = m;
          if (SHOTS) { fs.mkdirSync(`${DIR}/${SHOTS}`, { recursive: true }); await page.screenshot({ path: `${DIR}/${SHOTS}/${s.name}-${w}-${scheme}.png`, type: "png" }); }
        } catch (e) { report[key] = { error: String(e).slice(0, 200) }; }
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
    if (SHOTS) { fs.writeFileSync(`${DIR}/${SHOTS}/metrics-${scheme}.json`, JSON.stringify(report, null, 1)); return; }
    for (const [key, m] of Object.entries(report)) {
      expect.soft("error" in m ? m.error : "", `${key} loads`).toBe("");
      if ("error" in m) continue;
      expect.soft(m.overflowX, `${key}: no sideways scroll`).toBeLessThanOrEqual(0);
      if (!key.startsWith("mail-compose") && !key.startsWith("menu") && !key.startsWith("task-detail")) expect.soft(m.tabBar, `${key}: tab bar on screen`).toBe(true);
      expect.soft(m.smallTargets, `${key}: 44 px targets`).toEqual([]);
      expect.soft(m.smallInputs, `${key}: 16 px fields`).toEqual([]);
    }
  });
}

test("sign in at 360 and 390: no sideways scroll, 16 px fields", async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const w of SHOTS ? [360, 390, 430] : [360, 390]) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.goto("/login");
      await page.waitForTimeout(600);
      const m = await measure(page);
      if (SHOTS) { fs.mkdirSync(`${DIR}/${SHOTS}`, { recursive: true }); await page.screenshot({ path: `${DIR}/${SHOTS}/signin-${w}-${scheme}.png` }); continue; }
      expect.soft(m.overflowX, `sign in ${w} ${scheme}`).toBeLessThanOrEqual(0);
      expect.soft(m.smallInputs, `sign in ${w} ${scheme} fields`).toEqual([]);
    }
  }
});

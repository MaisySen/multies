import { test, expect, type Page } from "@playwright/test";

/**
 * R40 ui helper: the timeline (start of the range), Settings Connections with the demo's sample connected mailbox,
 * Mailboxes and Settings Developers load at desktop (1280) and phone (390), light and dark, with no sideways scroll on
 * the phone. With SHOTS=before or SHOTS=after it also saves screenshots to /home/user/tab/files/multies-r40/.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.143.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(180_000);

const SHOTS = process.env.SHOTS;
const ONLY = (process.env.SHOT_AREAS ?? "timeline,connections,mailboxes,developers").split(",");
const DIR = "/home/user/tab/files/multies-r40";

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}

for (const size of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`R40 ui screens (${size.name}, ${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: size.width, height: size.height });
      await demo(page);
      const screens: [string, string, () => Promise<void>][] = [
        ["connections", "/app/settings/connections", async () => {
          await expect(page.getByRole("heading", { name: "Connected accounts" }).first()).toBeVisible();
          if (SHOTS === "after") await expect(page.getByText(/personal\.example/).first()).toBeVisible({ timeout: 10_000 });
        }],
        ["mailboxes", "/app/mailboxes", async () => { await expect(page.getByRole("heading", { name: "Mailboxes", level: 1 })).toBeVisible(); }],
        ["developers", "/app/settings/developers", async () => { await expect(page.getByText("API keys").first()).toBeVisible(); }],
      ];
      for (const [area, path, check] of screens) {
        if (!ONLY.includes(area)) continue;
        await page.goto(path);
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        await check();
        if (size.width === 390) {
          const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect(over, `${path} scrolls sideways at 390`).toBeLessThanOrEqual(1);
        }
        if (SHOTS) await page.screenshot({ path: `${DIR}/${area}-${SHOTS}-r40-${size.name}-${scheme}.png`, type: "png" });
      }
      if (ONLY.includes("timeline")) {
        // The demo's first project, timeline view, scrolled to the start of the range.
        await page.goto("/app/work");
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        const project = page.getByRole("link", { name: /Launch|Website|Onboarding|Q[1-4]/ }).first();
        if (await project.count()) await project.click();
        const tl = page.getByRole("tab", { name: "Timeline" }).or(page.getByRole("button", { name: "Timeline" })).first();
        if (await tl.count()) {
          await tl.click();
          await page.waitForTimeout(800);
          await page.evaluate(() => { const a = document.querySelector(".wx-area")?.parentElement; if (a) a.scrollLeft = 0; });
          // No outside label may sit on a wait band or an early pill.
          const hits = await page.evaluate(() => {
            const r = (e: Element) => e.getBoundingClientRect();
            const labels = [...document.querySelectorAll("[data-testid=timeline-bar-out]")].map(r);
            const gaps = [...document.querySelectorAll("[data-testid=timeline-lag-gap][data-kind=lag], [data-testid=timeline-lag-gap] .mm-gap-pill")].map(r);
            let n = 0;
            for (const a of labels) for (const b of gaps) if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) n++;
            return n;
          });
          expect(hits).toBe(0);
          if (SHOTS) await page.screenshot({ path: `${DIR}/timeline-${SHOTS}-r40-start-${size.name}-${scheme}.png`, type: "png" });
        }
      }
    });
  }
}

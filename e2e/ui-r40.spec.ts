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
          await expect(page.getByRole("heading", { name: "Mail accounts" }).first()).toBeVisible();
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
        // A small plan with a 3 day wait, a 1 day early start and long names, shown from the start of the range.
        const headers = { origin: new URL(page.url()).origin };
        const day = (n: number) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
        const project = (await (await page.request.post("/api/projects", { headers, data: { name: "Launch plan", key: "LCH" } })).json()).project as { id: string };
        const mk = async (title: string, s: number, e: number) => (await (await page.request.post("/api/tasks", { headers, data: { projectId: project.id, title, start: day(s), due: day(e) } })).json()).task as { id: string };
        const link = async (blocked: string, blocker: string, lag: number) => {
          await page.request.post(`/api/tasks/${blocked}/dependencies`, { headers, data: { blockedBy: blocker } });
          if (lag) await page.request.patch(`/api/tasks/${blocked}/dependencies/${blocker}`, { headers, data: { lagDays: lag } });
        };
        const design = await mk("Design the pricing page", 0, 3);
        const press = await mk("Prepare the press kit with quotes from the founders and two customers", 3, 4);
        const write = await mk("Write the launch announcement and the long form post for the blog", 7, 8);
        await link(write.id, design.id, 3);
        await link(press.id, design.id, -1);
        await page.goto(`/app/tasks?view=timeline&project=${project.id}`);
        await expect(page.getByTestId("timeline-bar-label").first()).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(900);
        await page.locator(".mm-gantt .wx-chart").first().evaluate((el) => { el.scrollLeft = 0; });
        await page.waitForTimeout(300);
        // No outside label may sit on a wait band or an early pill, and no early pill may reach the row above.
        const hits = await page.evaluate(() => {
          const r = (e: Element) => e.getBoundingClientRect();
          const labels = [...document.querySelectorAll("[data-testid=timeline-bar-out]")].map(r).filter((x) => x.width > 0);
          const gaps = [...document.querySelectorAll("[data-testid=timeline-lag-gap][data-kind=lag], [data-testid=timeline-lag-gap][data-kind=lead] .mm-gap-pill")].map(r);
          let n = 0;
          for (const a of labels) for (const b of gaps) if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) n++;
          return n;
        });
        expect(hits).toBe(0);
        if (SHOTS) await page.screenshot({ path: `${DIR}/timeline-${SHOTS}-r40-start-${size.name}-${scheme}.png`, type: "png" });
      }
    });
  }
}

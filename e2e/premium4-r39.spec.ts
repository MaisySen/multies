import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R39 web premium pass 4: billing, notifications (and its settings), domain detail and the domain list load at
 * desktop (1280) and phone (390) with no console errors and no sideways scroll on the phone, the new pieces are
 * there (plan hero and usage rings, kind tiles, setup stepper and record pills), and notifications pass axe
 * (moderate and worse) at both sizes.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.139.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(120_000);

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}

/** Console errors that are not ours: the browser's own notes about blocked third party scripts and push. */
const ignorable = (t: string) => /favicon|Failed to load resource: the server responded with a status of 40[134]|ServiceWorker|push/i.test(t);

for (const size of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }]) {
  test(`premium pass 4 screens load clean (${size.name})`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await demo(page);
    const domains = ((await (await page.request.get("/api/domains")).json()).domains ?? []) as { id: string }[];
    const screens: [string, () => Promise<void>][] = [
      ["/app/settings/billing", async () => {
        await expect(page.getByTestId("plan-hero")).toBeVisible();
        await expect(page.getByTestId("usage-ring").first()).toBeVisible();
        await page.getByRole("button", { name: "Compare limits" }).click();
        await expect(page.getByTestId("compare-plans")).toBeVisible();
        await page.keyboard.press("Escape");
      }],
      ["/app/notifications", async () => {
        await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible();
        const rows = page.getByTestId("notification-row");
        if (await rows.count()) await expect(rows.first().getByTestId("kind-tile")).toBeVisible();
      }],
      ["/app/settings/notifications", async () => { await expect(page.getByTestId("notification-settings").getByTestId("kind-tile").first()).toBeVisible(); }],
      ["/app/domains", async () => { await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible(); }],
      ["/app/settings/developers", async () => { await expect(page.getByTestId("developer-tiles")).toBeVisible(); }],
    ];
    if (domains[0]) screens.push([`/app/domains/${domains[0].id}`, async () => {
      await expect(page.getByTestId("setup-stepper")).toBeVisible();
      await expect(page.getByTestId("record-pill").first()).toBeVisible();
      expect(await page.getByTestId("setup-stepper").locator("[aria-current=step]").count()).toBeLessThanOrEqual(1);
    }]);
    for (const [path, check] of screens) {
      await page.goto(path);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await check();
      if (size.width === 390) {
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(over, `${path} scrolls sideways at 390`).toBeLessThanOrEqual(1);
      }
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test(`notifications have no moderate or worse axe findings (${size.name})`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await demo(page);
    for (const path of ["/app/notifications", "/app/settings/notifications"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      const { violations } = await new AxeBuilder({ page }).analyze();
      const bad = violations.filter((v) => ["moderate", "serious", "critical"].includes(v.impact ?? ""));
      expect(bad.map((v) => `${path}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
  });
}

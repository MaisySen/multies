import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R39 web premium pass 5: mailboxes, team, deliverability and connections load at desktop (1280) and phone (390)
 * with no console errors and no sideways scroll on the phone, the new pieces are there (mailbox cards with a kind
 * pill, team headline numbers, plain word pills), and team passes axe (moderate and worse) at both sizes.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.142.${test.info().workerIndex % 200}.${++visitor}` });
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
  test(`premium pass 5 screens load clean (${size.name})`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await demo(page);
    const screens: [string, () => Promise<void>][] = [
      ["/app/mailboxes", async () => {
        await expect(page.getByRole("heading", { name: "Mailboxes", level: 1 })).toBeVisible();
        const cards = page.getByTestId("mailbox-card");
        if (await cards.count()) await expect(cards.first().getByTestId("mailbox-kind")).toBeVisible();
      }],
      ["/app/settings/team", async () => {
        await expect(page.getByTestId("team-headline")).toBeVisible();
        // R41: the demo can't send invites, so Invite is disabled with the reason beside it (the role cards are
        // covered for real workspaces in e2e/premium4-r39 and the invite specs).
        await expect(page.getByRole("button", { name: "Invite", exact: true })).toBeDisabled();
        await expect(page.getByTestId("demo-invites-off")).toBeVisible();
      }],
      ["/app/deliverability", async () => {
        await expect(page.getByRole("heading", { name: "Deliverability", level: 1 })).toBeVisible();
        const factors = page.getByTestId("health-factor");
        if (await factors.count()) await expect(factors.first().getByTestId("plain-status")).toBeVisible();
      }],
      ["/app/settings/connections", async () => { await expect(page.getByRole("heading", { name: "Connected accounts" }).first()).toBeVisible(); }],
    ];
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

  test(`team has no moderate or worse axe findings (${size.name})`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await demo(page);
    await page.goto("/app/settings/team");
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await expect(page.getByTestId("team-headline")).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).analyze();
    const bad = violations.filter((v) => ["moderate", "serious", "critical"].includes(v.impact ?? ""));
    expect(bad.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

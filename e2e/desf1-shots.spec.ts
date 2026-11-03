import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/** DESF1: before and after shots, light, 1600 and 390: My Work, Mail, Tasks, Settings, plus a dark brand sidebar. */
const DIR = process.env.SHOTS_DIR;
const PHASE = process.env.SHOTS_PHASE ?? "after";
test.skip(!DIR, "screenshots only with SHOTS_DIR");
test.setTimeout(240_000);

async function shoot(page: Page, name: string) {
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${DIR}/${PHASE}-${name}.png` });
}

test("desf1 shots", async ({ page }) => {
  mkdirSync(DIR!, { recursive: true });
  if (!process.env.E2E_BASE_URL) await page.context().setExtraHTTPHeaders({ "x-forwarded-for": "10.161.0.7" });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
  await page.route("**/api/counts**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    mail: { inbox: 15536, important: 12, other: 0 }, chat: { unread: 4, mentions: 1 }, notifications: { unread: 150 }, triage: 3, tasks: { dueToday: 2, overdue: 1 }, at: new Date().toISOString() }) }));
  const pages: [string, string][] = [["/app/my-work", "mywork"], ["/app/mail", "mail"], ["/app/tasks", "tasks"], ["/app/settings", "settings"]];
  for (const [w, h] of [[1600, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const [path, name] of pages) { await page.goto(path); await shoot(page, `${name}-${w}-light`); }
  }
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Midnight", exact: true }).first().click({ timeout: 20_000 });
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await page.goto("/app/my-work"); await shoot(page, "mywork-1600-light-brand-sidebar");
});

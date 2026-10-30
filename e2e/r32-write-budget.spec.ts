import { test, expect } from "@playwright/test";

/**
 * R32: the operator console shows the account's D1 writes today as a meter. /api/health and the admin
 * overview are mocked (62% of the budget), so nothing here depends on Cloudflare analytics.
 */
test("operator console shows the D1 write meter at 62%", async ({ page }) => {
  const health = {
    ok: true, mode: "test", db: "ok", release: "e2e",
    writes: { today: 62_340, budget: 100_000, level: "warn", pct: 62.3, warnAt: 60, shedAt: 85, at: new Date().toISOString(),
      resetAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)).toISOString(),
      byEnvironment: { production: 21_870, staging: 40_470 }, deferred: { written: 12, coalesced: 40, skipped: 0 } },
  };
  await page.route("**/api/health", (r) => r.fulfill({ json: health }));
  await page.route("**/api/admin/overview", (r) => r.fulfill({ json: {
    totals: { users: 41, workspaces: 12, domains: 9, mailboxes: 23, deliveries24h: 310 }, tenants: [],
    integrations: { sentryApi: true, sentryWeb: true, outbound: "resend", billing: true, billingTestMode: false, auth0: true, google: true, github: false },
  } }));
  const email = `e2e-wb-${Date.now()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Olive Operator");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
  await page.goto("/app/admin");
  const meter = page.getByTestId("write-budget");
  await expect(meter).toBeVisible({ timeout: 15_000 });
  await expect(meter.getByRole("heading", { name: "D1 writes today" })).toBeVisible();
  await expect(page.getByTestId("write-budget-today")).toHaveText("62,340");
  await expect(page.getByTestId("write-budget-pct")).toHaveText("62.3%");
  await expect(page.getByTestId("write-budget-level")).toHaveText("Watch");
  await expect(meter.getByRole("meter", { name: "D1 rows written today" })).toHaveAttribute("aria-valuenow", "62340");
  await expect(meter.getByText("staging", { exact: true })).toBeVisible();
  await expect(meter.getByText("production", { exact: true })).toBeVisible();
  await expect(meter.getByText("Resets at 00:00 UTC", { exact: false })).toBeVisible();
  if (process.env.R32_SHOTS) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await meter.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.R32_SHOTS}/admin-write-budget.png` });
  }
});

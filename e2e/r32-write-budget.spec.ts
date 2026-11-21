import { test, expect } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * R32: the operator console shows the account's D1 writes today as a meter. Since the OPS1 polish the meter lives on
 * System health (/console/system), not the Overview. The snapshot (GET /api/console/system/snapshot) and the operator
 * are mocked (62% of the budget), so nothing here depends on Cloudflare analytics.
 */
const now = new Date();
const snapshot = {
  at: now.toISOString(), mode: "test", release: "e2e",
  migrations: { ok: true, pending: [] },
  database: {
    meter: "on",
    writes: { today: 62_340, budget: 100_000, level: "warn", pct: 62.3, warnAt: 60, shedAt: 85, at: now.toISOString(),
      resetAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(),
      byEnvironment: { production: 21_870, staging: 40_470 } },
    reads: null,
  },
  busiestWorkspaces: { day: now.toISOString().slice(0, 10), budget: 0, items: [] },
  integrations: { sentryApi: true, sentryWeb: true, outbound: "resend", billing: true, billingTestMode: false, auth0: true, google: true, github: false, mailServer: false, writeBudgetMeter: true },
  circuitBreakers: { scope: "this_isolate", providers: [] },
  rateLimits: {
    store: { auth: "database", api: "database", webhooks: "database", app: "database", handoff: "database" },
    perMinute: { auth: 10, api: 120, webhooks: 600, app: 300, handoff: 10 },
    lockout: { maxFailures: 10, windowMs: 900_000, lockForMs: 900_000 },
  },
  uptime: null,
};

test("System health shows the D1 write meter at 62%", async ({ page }) => {
  await mockConsoleMe(page, "admin");
  await page.route("**/api/console/system/snapshot", (r) => r.fulfill({ json: snapshot }));
  const email = `e2e-wb-${Date.now()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Olive Operator");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
  await page.goto("/console/system"); // OPS1 polish: was the Overview
  const meter = page.getByTestId("console-system-writes");
  await expect(meter).toBeVisible({ timeout: 15_000 });
  await expect(meter.getByRole("heading", { name: "Writes today" })).toBeVisible();
  await expect(meter.getByText("62,340", { exact: true })).toBeVisible();
  await expect(page.getByTestId("console-system-writes-pct")).toHaveText("62.3%");
  await expect(page.getByTestId("console-system-writes-level")).toHaveText("Watch");
  await expect(meter.getByRole("meter", { name: "Database rows written today" })).toHaveAttribute("aria-valuenow", "62340");
  await expect(meter.getByText("staging", { exact: true })).toBeVisible();
  await expect(meter.getByText("production", { exact: true })).toBeVisible();
  await expect(meter.getByText("Resets at 00:00 UTC", { exact: false })).toBeVisible();
  // The Overview no longer carries the meter or the analytics token line.
  await page.route("**/api/console/overview", (r) => r.fulfill({ json: { attention: [], totals: { users: 1, workspaces: 1, domains: 0, mailboxes: 0, deliveries24h: 0 }, newest: [] } }));
  await page.goto("/console");
  await expect(page.getByTestId("console-attention-clear")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("CF_ANALYTICS_TOKEN")).toHaveCount(0);
  if (process.env.R32_SHOTS) {
    await page.goto("/console/system");
    await page.setViewportSize({ width: 1440, height: 900 });
    await meter.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.R32_SHOTS}/admin-write-budget.png` });
  }
});

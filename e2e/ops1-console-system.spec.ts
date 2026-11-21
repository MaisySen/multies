import { test, expect, type Page } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * OPS1: /console/system. The overall line names what needs attention (a pending migration here), the sections read
 * top to bottom, the API Sentry test asks for a reason and sends it, and a read only operator sees no test buttons.
 * The snapshot is mocked (GET /api/console/system/snapshot).
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const now = new Date();
const snapshot = {
  at: now.toISOString(), mode: "production", release: "rel-e2e-2026-11-21",
  migrations: { ok: true, pending: ["0412_console_indexes"] },
  database: {
    meter: "on",
    writes: { today: 61_000, budget: 100_000, level: "warn", pct: 61, warnAt: 60, shedAt: 85, resetAt: new Date(now.getTime() + 3 * 3_600_000).toISOString(), byEnvironment: { production: 50_000, staging: 11_000 }, at: now.toISOString() },
    reads: { today: 1_000_000, budget: 5_000_000, pct: 20, level: "ok", warnAt: 70, loadStopAt: 90 },
  },
  busiestWorkspaces: { day: now.toISOString().slice(0, 10), budget: 20_000, items: [{ orgId: "org_busy", workspaceName: "Busy Bees", rowsWritten: 15_000, level: "near" }] },
  integrations: { sentryApi: true, sentryWeb: false, outbound: "resend", billing: true, billingTestMode: false, auth0: false, google: true, github: false, mailServer: false, writeBudgetMeter: true },
  circuitBreakers: { scope: "this_isolate", providers: [{ provider: "outbound", state: "closed" }, { provider: "stripe", state: "closed" }] },
  rateLimits: { store: { auth: "binding", api: "binding", webhooks: "database", app: "database", handoff: "database" }, perMinute: { auth: 30, api: 600, webhooks: 600, app: 300, handoff: 20 }, lockout: { maxFailures: 10, windowMs: 900_000, lockForMs: 900_000 } },
  uptime: { days: [{ date: now.toISOString().slice(0, 10), checks: 288, uptime: 1, worst: "operational" }], uptime30d: 1, uptime90d: 0.9991 },
};

test("an operator sees what needs attention and sends an API test error with a reason", async ({ page }) => {
  await mockConsoleMe(page, "ops_admin");
  let snapshotReads = 0;
  await page.route("**/api/console/system/snapshot", (r) => { snapshotReads++; return r.fulfill({ json: snapshot }); });
  const sent: unknown[] = [];
  await page.route("**/api/console/system/sentry-test", async (r) => { sent.push(r.request().postDataJSON()); await r.fulfill({ json: { configured: true, eventId: "evt_e2e" } }); });
  await signUp(page, "Olive Operator");
  await page.goto("/console/system");
  await expect(page.getByRole("heading", { name: "System health", level: 1 })).toBeVisible({ timeout: 15_000 });
  const overall = page.getByTestId("console-system-overall");
  await expect(overall).toContainText("1 database migration is waiting to run");
  await expect(overall).toContainText("Database writes are at 61% of today's budget");
  await expect(page.getByText("rel-e2e-2026-11-21")).toBeVisible();
  await expect(page.getByText("0412_console_indexes")).toBeVisible();
  await expect(page.getByTestId("console-system-writes-level")).toHaveText("Watch");
  await expect(page.getByTestId("console-system-busiest")).toContainText("Busy Bees");
  await expect(page.getByTestId("console-system-breakers")).toContainText("Outbound mail");
  await expect(page.getByText("This shows only the server that answered this page.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("console-system-updated")).toBeVisible();

  const before = snapshotReads;
  await page.getByTestId("console-system-refresh").click();
  await expect.poll(() => snapshotReads).toBeGreaterThan(before);

  await page.getByTestId("console-system-sentry-api").click();
  const dialog = page.getByRole("dialog", { name: "Send an API test error to Sentry?" });
  await dialog.getByLabel("Reason").fill("Checking alerts after the deploy");
  await dialog.getByRole("button", { name: "Send test error" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => sent[0]).toEqual({ reason: "Checking alerts after the deploy" });
});

test("all clear reads as normal, and a read only operator sees no test buttons", async ({ page }) => {
  await mockConsoleMe(page, "ops_readonly");
  const calm = { ...snapshot, migrations: { ok: true, pending: [] }, database: { ...snapshot.database, writes: { ...snapshot.database.writes, level: "ok", pct: 12 } } };
  await page.route("**/api/console/system/snapshot", (r) => r.fulfill({ json: calm }));
  await signUp(page, "Rory Readonly");
  await page.goto("/console/system");
  await expect(page.getByTestId("console-system-overall")).toHaveText("All systems normal", { timeout: 15_000 });
  await expect(page.getByTestId("console-system-integrations")).toContainText("Sentry (API)");
  await expect(page.getByTestId("console-system-sentry-api")).toHaveCount(0);
  await expect(page.getByTestId("console-system-sentry-web")).toHaveCount(0);
});

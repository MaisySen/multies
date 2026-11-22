import { test, expect, type Page } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * OPS1 Trends: the trend charts on a workspace's Usage tab (/console/workspaces/:id/usage; the old /trends address
 * redirects there, keeping ?range=), and the platform trends block on the console Overview (/console). The operator,
 * the workspace and the trends are mocked (GET /api/console/me, /api/console/overview, /api/console/workspaces/:id...,
 * /api/console/metrics...); the server's own checks are covered by tests/console-metrics-routes.test.ts.
 */
const ORG = "org_e2e_trends";

async function signUp(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Olive Operator");
  await page.getByLabel("Work email").fill(`e2e-ops1-trends-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function trends(days: number) {
  const now = Date.now();
  const list = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * 86_400_000));
  const series = (f: (i: number) => number | null) => list.map((_, i) => f(i));
  return {
    from: list[0], to: list[list.length - 1], days: list,
    series: {
      deliveries_sent: series((i) => 10 + (i % 4)),
      deliveries_failed: series((i) => i % 3),
      deliveries_received: series((i) => 5 + (i % 2)),
      ai_calls: series((i) => (i >= days - 3 ? 4 + i % 2 : null)),
      ai_units: series((i) => (i >= days - 3 ? 40 : null)),
      // Not in display order on purpose: the page orders the chips itself (rows written first).
      "usage:chat_in": series((i) => (i % 2 ? 2 : null)),
      "usage:d1_rows": series((i) => 300 + i),
    },
    ai: { historyDays: 2, from: list[Math.max(0, days - 3)], partial: days > 3 },
  };
}

const workspace = {
  org: {
    id: ORG, name: "Acme Trends", slug: "acme-trends", plan: "pro", effectivePlan: "pro", compPlan: false, isDemo: false, timezone: "UTC", country: "US",
    createdAt: new Date(Date.now() - 90 * 86_400_000).toISOString(), stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: "active",
    billingInterval: "month", currentPeriodEnd: null, cancelAtPeriodEnd: false, pastDueSince: null, graceEndsAt: null, requireSso: false,
    suspendedAt: null, suspendedReason: null, sendCapDaily: null, meetingMinutesCap: null, channelsEnabled: true, legacyStorageMb: null,
  },
  limits: {}, addons: {}, usage: {},
  counts: { members: 3, agentMembers: 0, pendingInvites: 0, agents: 0, apiKeys: 0, webhookEndpoints: 0, webhookEndpointsDisabled: 0, activeOauthGrants: 0, sendsToday: 0, meetingMinutesThisMonth: 0 },
  writeBudget: { used: 0, budget: 1000, level: "ok", resetAt: new Date().toISOString() },
};

async function mockTrends(page: Page) {
  const asked: number[] = [];
  await page.route(`**/api/console/workspaces/${ORG}**`, (r) => r.fulfill({ json: workspace }));
  await page.route(`**/api/console/metrics/workspaces/${ORG}**`, (r) => {
    const days = Number(new URL(r.request().url()).searchParams.get("days") ?? 30);
    asked.push(days);
    return r.fulfill({ json: trends(days) });
  });
  return asked;
}

test("a workspace's Usage tab shows limits, then mail, AI and daily usage trends, and the range is kept in the address", async ({ page }) => {
  await mockConsoleMe(page, "ops_readonly");
  const asked = await mockTrends(page);
  await signUp(page);
  // The old Trends address opens the merged Usage tab.
  await page.goto(`/console/workspaces/${ORG}/trends`);
  await expect(page).toHaveURL(new RegExp(`/console/workspaces/${ORG}/usage$`), { timeout: 15_000 });
  await expect(page.getByRole("link", { name: "Usage" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Trends" })).toHaveCount(0);
  await expect(page.getByTestId("console-workspaces-usage-limits")).toBeVisible();

  const tab = page.getByTestId("console-workspace-trends");
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await expect(tab.getByRole("heading", { name: "Trends" })).toBeVisible();
  for (const id of ["mail", "ai", "usage"]) await expect(page.getByTestId(`console-workspace-trends-${id}`)).toBeVisible();
  await expect(page.getByTestId("console-workspace-trends-mail").getByTestId("trend-line")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-workspace-trends-ai")).toContainText("AI history is only kept for the last 2 days");
  // Rows written is the first usage chip and the default, whatever order the API's keys arrive in.
  await expect(page.getByTestId("console-workspace-trends-usage")).toContainText("Rows written per day.");
  await expect(page.getByTestId("console-workspace-trends-usage-view").getByRole("button")).toHaveText(["Rows written", "Chat messages received"]);
  expect(asked).toContain(30);

  // The range picker updates the address and asks for that range.
  const picker = tab.getByTestId("range-picker");
  await picker.getByRole("button", { name: "7 days" }).click();
  await expect(page).toHaveURL(/[?&]range=7(&|$)/);
  await expect(picker.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => asked.includes(7)).toBe(true);

  // A shared link opens the same range.
  await page.reload();
  await expect(page.getByTestId("console-workspace-trends").getByTestId("range-picker").getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });

  // The chips switch what a card shows.
  const mail = page.getByTestId("console-workspace-trends-mail");
  await page.getByTestId("console-workspace-trends-mail-view").getByRole("button", { name: "Inbound" }).click();
  await expect(mail).toContainText("Inbound mail received.");
  const usage = page.getByTestId("console-workspace-trends-usage");
  await page.getByTestId("console-workspace-trends-usage-view").getByRole("button", { name: "Chat messages received" }).click();
  await expect(usage).toContainText("Chat messages received per day.");
});

test("a workspace's Usage trends say when there is no data, and shows an error with a retry", async ({ page }) => {
  await mockConsoleMe(page, "admin");
  await page.route(`**/api/console/workspaces/${ORG}**`, (r) => r.fulfill({ json: workspace }));
  let fail = true;
  await page.route(`**/api/console/metrics/workspaces/${ORG}**`, (r) => {
    if (fail) return r.fulfill({ status: 500, json: { error: { code: "internal", message: "The trends read failed." } } });
    const t = trends(30);
    return r.fulfill({ json: { ...t, series: { ...t.series, ai_calls: t.days.map(() => null), ai_units: t.days.map(() => null), "usage:d1_rows": undefined, "usage:chat_in": undefined } } });
  });
  await signUp(page);
  await page.goto(`/console/workspaces/${ORG}/trends?range=7`);
  await expect(page).toHaveURL(new RegExp(`/console/workspaces/${ORG}/usage\\?range=7$`), { timeout: 15_000 });
  const mail = page.getByTestId("console-workspace-trends-mail");
  await expect(mail.getByTestId("chart-error")).toBeVisible({ timeout: 20_000 });
  fail = false;
  await mail.getByRole("button", { name: "Retry" }).click();
  await expect(mail.getByTestId("trend-line")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-workspace-trends-ai").getByTestId("chart-empty")).toBeVisible();
  await expect(page.getByTestId("console-workspace-trends-usage")).toContainText("This workspace has no daily usage counters in this range.");
});

/** The platform trends read: flow counts on every day (only today live, nothing stored yet), stock counts empty. */
function platformTrends(days: number) {
  const now = Date.now();
  const list = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * 86_400_000));
  const flow = (base: number) => list.map((_, i) => base + (i % 3));
  const none = () => list.map(() => null);
  return {
    from: list[0], to: list[list.length - 1], liveDay: list[list.length - 1], days: list,
    series: {
      signups: flow(3), workspaces_created: flow(1), deliveries_sent: flow(40), deliveries_failed: flow(2), ai_calls: flow(10),
      jobs_dead: flow(0), webhook_deliveries_failed: flow(0), uptime_pct: none(),
      workspaces_paid: none(), workspaces_past_due: none(), workspaces_suspended: none(),
    },
    // Nothing stored yet: the owner tier is offered "Fill in history".
    firstDay: {},
  };
}

async function mockOverview(page: Page) {
  await page.route("**/api/console/overview", (r) => r.fulfill({ json: {
    attention: [], totals: { users: 3, workspaces: 2, domains: 0, mailboxes: 0, deliveries24h: 0 }, newest: [],
  } }));
  await page.route((u) => u.pathname === "/api/console/metrics/registry", (r) => r.fulfill({ json: { metrics: [], ranges: [7, 30, 90], maxBackfillDays: 90 } }));
  await page.route((u) => u.pathname === "/api/console/metrics", (r) => {
    const q = new URL(r.request().url()).searchParams;
    return r.fulfill({ json: platformTrends(Number(q.get("days") ?? 30) || 30) });
  });
}

test("the Overview shows the platform trends, says No data yet for counts kept by day, and hides Fill in history from a read-only operator", async ({ page }) => {
  await mockConsoleMe(page, "ops_readonly");
  await mockOverview(page);
  await signUp(page);
  await page.goto("/console");
  const block = page.getByTestId("console-trends");
  await expect(block).toBeVisible({ timeout: 20_000 });
  await expect(block.getByRole("heading", { name: "Trends" })).toBeVisible();
  await expect(page.getByTestId("console-trends-tiles")).toBeVisible();
  // A flow count has a number; the paid workspaces count (a stock kept once a day) has none yet.
  await expect(page.getByTestId("console-trends-tile-signups").getByTestId("kpi-value")).not.toHaveText("No data");
  await expect(page.getByTestId("console-trends-tile-workspaces_paid").getByTestId("kpi-value")).toHaveText("No data");
  await expect(page.getByTestId("console-trends-mail").getByTestId("trend-line")).toBeVisible({ timeout: 15_000 });
  const state = page.getByTestId("console-trends-state");
  await expect(state.getByTestId("chart-empty")).toContainText("No data yet");
  await expect(page.getByTestId("console-trends-uptime")).toHaveText("No uptime checks recorded yet.");
  // Read only: no Fill in history, even with nothing stored.
  await expect(page.getByTestId("console-trends-backfill")).toHaveCount(0);
});

test("the Overview offers Fill in history to the owner tier while nothing is stored", async ({ page }) => {
  await mockConsoleMe(page, "admin");
  await mockOverview(page);
  await signUp(page);
  await page.goto("/console");
  await expect(page.getByTestId("console-trends")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("console-trends-backfill")).toBeVisible({ timeout: 15_000 });
});

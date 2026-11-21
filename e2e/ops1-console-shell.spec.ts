import { test, expect, type Page } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * OPS1: the operator console shell at /console. Someone who is not an operator sees a plain card (the API says 403),
 * the old /app/admin addresses open the console, an operator sees the grouped sidebar, and a lower tier role sees a
 * shorter menu. The operator is mocked (GET /api/console/me); the server's own role checks are covered by
 * tests/console-rbac.test.ts.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const overview = {
  attention: [
    { id: "reports", label: "Reports to review", count: 2, tone: "bad", to: "/console/moderation" },
    { id: "dead_jobs", label: "Jobs that failed for good", count: 3, tone: "bad", to: "/console/jobs?status=dead" },
  ],
  totals: { users: 3, workspaces: 2, domains: 0, mailboxes: 0, deliveries24h: 0 },
  newest: [{ id: "org_1", name: "Acme Bakery", plan: "starter", isDemo: false, createdAt: new Date().toISOString(), suspendedAt: null, pastDueSince: null, ownerUserId: "usr_2", ownerEmail: "alice.acme.bakery.owner@example.com" }],
};

const wsRow = (i: number) => ({
  id: `org_${i}`, name: `Northwind Labs ${i}`, slug: null, plan: "starter", effectivePlan: "starter", compPlan: false, isDemo: i === 1,
  subscriptionStatus: null, pastDueSince: null, graceEndsAt: null, suspendedAt: i === 2 ? new Date().toISOString() : null, suspendedReason: null,
  sendCapDaily: null, createdAt: new Date().toISOString(), ownerEmail: `someone.with.a.long.address${i}@northwind-example.com`, members: 3, agentMembers: 0, domains: 1,
});

const workspaceDetail = {
  org: {
    id: "org_1", name: "Northwind Labs with a fairly long workspace name", slug: "northwind", plan: "starter", effectivePlan: "starter", compPlan: false, isDemo: false,
    timezone: "Australia/Sydney", country: "AU", createdAt: new Date().toISOString(), stripeCustomerId: null, stripeSubscriptionId: null,
    subscriptionStatus: null, billingInterval: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, pastDueSince: null, graceEndsAt: null,
    requireSso: false, suspendedAt: null, suspendedReason: null, sendCapDaily: null, meetingMinutesCap: null, channelsEnabled: true, legacyStorageMb: null,
  },
  limits: { domains: 1, mailboxes: 3, aliases: 5, storagePerMailboxMb: 1000, storageMb: 3000, dailySends: 100, seats: 3, agentInboxes: 1, agentMessagesMonthly: 100, agentDailySends: 10, automationRunsMonthly: 50, agentMembers: 1 },
  addons: {}, usage: { domains: 1, mailboxes: 1, agentInboxes: 0, aliases: 0, seats: 3, storageMb: 5, agentMessages: 0 },
  counts: { members: 3, agentMembers: 0, pendingInvites: 0, agents: 0, apiKeys: 0, webhookEndpoints: 0, webhookEndpointsDisabled: 0, activeOauthGrants: 0, sendsToday: 0, meetingMinutesThisMonth: 0 },
  writeBudget: { used: 1, budget: 5000, level: "ok", resetAt: new Date(Date.now() + 3600_000).toISOString() },
};

/** Console reads the phone test needs, answered from the mocks above. */
async function mockConsoleData(page: Page) {
  await page.route("**/api/console/overview", (r) => r.fulfill({ json: overview }));
  await page.route((u) => u.pathname === "/api/console/workspaces", (r) => r.fulfill({ json: { items: [1, 2, 3, 4, 5].map(wsRow), nextCursor: null } }));
  await page.route((u) => u.pathname.startsWith("/api/console/workspaces/org_1"), (r) => (new URL(r.request().url()).pathname === "/api/console/workspaces/org_1"
    ? r.fulfill({ json: workspaceDetail }) : r.fulfill({ status: 404, json: { error: { code: "not_found", message: "Not found." } } })));
  await page.route((u) => u.pathname.startsWith("/api/console/metrics"), (r) => r.fulfill({ status: 404, json: { error: { code: "not_found", message: "Not found." } } }));
}

test("a customer sees the operators-only card, and the old addresses open the console", async ({ page }) => {
  await signUp(page, "Cara Customer");
  await page.goto("/console");
  await expect(page.getByText("This console is for platform operators")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-sidebar")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to my work" })).toBeVisible();

  await page.goto("/app/admin");
  await expect(page).toHaveURL(/\/console$/);
  await expect(page.getByText("This console is for platform operators")).toBeVisible();
  await page.goto("/app/admin/reports");
  await expect(page).toHaveURL(/\/console\/moderation$/);
  await expect(page.getByText("This console is for platform operators")).toBeVisible();

  // The API agrees: no console data for a customer, and Better Auth's admin endpoints are closed.
  const headers = { origin: new URL(page.url()).origin };
  expect((await page.request.get("/api/console/me")).status()).toBe(403);
  expect((await page.request.post("/api/auth/admin/list-users", { data: {}, headers })).status()).toBe(404);
});

test("an operator sees the grouped sidebar, attention first, and the sections open", async ({ page }) => {
  await mockConsoleMe(page, "admin");
  await page.route("**/api/console/overview", (r) => r.fulfill({ json: overview }));
  await page.route((u) => u.pathname === "/api/console/audit", (r) => r.fulfill({ json: { items: [{
    id: "paud_1", actorUserId: "usr_1", actorEmail: "olive@example.com", actorRole: "admin", action: "workspace.suspended", targetType: "workspace",
    targetId: "org_1", orgId: "org_1", reason: "Phishing reports", before: { suspendedAt: null }, after: null, metadata: null,
    ip: null, userAgent: null, requestId: null, impersonationId: null, createdAt: new Date().toISOString(), targetLabel: "Acme Bakery", orgName: "Acme Bakery",
  }, {
    id: "paud_2", actorUserId: "usr_1", actorEmail: "olive@example.com", actorRole: "admin", action: "note.added", targetType: "note",
    targetId: "onote_1", orgId: null, reason: null, before: null, after: null, metadata: null,
    ip: null, userAgent: null, requestId: null, impersonationId: null, createdAt: new Date().toISOString(),
  }], nextCursor: null } }));
  await signUp(page, "Olive Operator");
  await page.goto("/console");
  const nav = page.getByTestId("console-sidebar");
  await expect(nav).toBeVisible({ timeout: 15_000 });
  for (const group of ["Overview", "Customers", "Product", "Platform", "Access"]) await expect(nav.getByText(group, { exact: true }).first()).toBeVisible();
  await expect(nav.getByRole("link", { name: "Operators" })).toBeVisible();
  await expect(page.getByTestId("console-role")).toHaveText("Owner");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page.getByTestId("console-attention")).toContainText("Reports to review");
  await expect(page.getByTestId("console-attention-dead_jobs")).toHaveAttribute("href", "/console/jobs?status=dead");
  // The legacy blocks left the Overview: integrations, the job queue and the workspace controls live on their pages.
  await expect(page.getByText("Integrations", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Job queue", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("console-overview-newest").getByRole("link", { name: "Acme Bakery" })).toHaveAttribute("href", "/console/workspaces/org_1");

  await nav.getByRole("link", { name: "Audit log" }).click();
  await expect(page).toHaveURL(/\/console\/audit$/);
  await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();
  await expect(page.getByText("Workspace suspended")).toBeVisible();
  await expect(page.getByText("Phishing reports")).toBeVisible();
  // The target reads as the workspace's name, linked, with the id in the title; a note needs no reason.
  await expect(page.getByRole("link", { name: "Acme Bakery" })).toHaveAttribute("title", "org_1");
  await expect(page.getByText("Note added")).toBeVisible();
  await expect(page.getByText("No reason")).toHaveCount(0);
  await expect(page.getByTestId("audit-export")).toBeVisible();

  await nav.getByRole("link", { name: "Workspaces" }).click();
  await expect(page).toHaveURL(/\/console\/workspaces$/);
  await expect(page.getByRole("heading", { name: "Workspaces", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Back to app" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/);
});

test("a lower tier role sees a shorter menu", async ({ page }) => {
  await page.route("**/api/console/overview", (r) => r.fulfill({ json: overview }));
  await signUp(page, "Rory Readonly");
  await mockConsoleMe(page, "admin");
  await page.goto("/console");
  const nav = page.getByTestId("console-sidebar");
  await expect(nav).toBeVisible({ timeout: 15_000 });
  const ownerLinks = await nav.getByRole("link").count();

  await page.unroute("**/api/console/me");
  await mockConsoleMe(page, "ops_readonly");
  await page.reload();
  await expect(nav).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-role")).toHaveText("Read only");
  await expect(nav.getByRole("link", { name: "Audit log" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Operators" })).toHaveCount(0);
  expect(await nav.getByRole("link").count()).toBeLessThan(ownerLinks);
});

test("a role without the Operators page sees a calm no access card, not an error", async ({ page }) => {
  await signUp(page, "Sam Support");
  await mockConsoleMe(page, "ops_support");
  await page.goto("/console/operators");
  await expect(page.getByTestId("console-no-access")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("You don't have access to this page")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("at phone width the console never scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleMe(page, "admin");
  await mockConsoleData(page);
  await signUp(page, "Pia Phone");
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  for (const [path, ready] of [
    ["/console", "console-overview"],
    ["/console/workspaces", "console-workspaces-list"],
    ["/console/workspaces/org_1", "console-workspaces-detail"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByTestId(ready)).toBeVisible({ timeout: 15_000 });
    expect(await fits(), `${path} fits 390 px`).toBe(true);
  }
  // Back to app stays one icon button with a name; the theme switcher moved into the menu.
  await expect(page.getByRole("link", { name: "Back to app" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Appearance" })).toBeHidden();
  await page.getByRole("button", { name: "Open the console menu" }).click();
  await expect(page.getByRole("dialog", { name: "Console menu" }).getByRole("radiogroup", { name: "Appearance" })).toBeVisible();
});

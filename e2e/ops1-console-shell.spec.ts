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
  attention: [{ id: "reports", label: "Reports to review", count: 2, tone: "bad", to: "/console/moderation" }],
  totals: { users: 3, workspaces: 2, domains: 0, mailboxes: 0, deliveries24h: 0 }, tenants: [],
  integrations: { sentryApi: false, sentryWeb: false, outbound: "log", billing: false, billingTestMode: false, auth0: false, google: false, github: false },
};

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

  await nav.getByRole("link", { name: "Audit log" }).click();
  await expect(page).toHaveURL(/\/console\/audit$/);
  await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();
  await expect(page.getByText("Workspace suspended")).toBeVisible();
  await expect(page.getByText("Phishing reports")).toBeVisible();
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

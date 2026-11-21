import { test, expect, type Page } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * OPS1: Users in the operator console. The list renders and its filters live in the address; the detail page's Ban
 * opens the reason dialog and sends the reason; a read only operator sees no actions. /api/console/* is mocked
 * (the server side is covered by tests/console-users-routes.test.ts).
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-users-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const now = new Date().toISOString();

const row = {
  id: "usr_ada", email: "ada@acme.example", name: "Ada Lovelace", emailVerified: false, role: "user", operator: false,
  banned: false, banReason: null, banExpires: null, twoFactorEnabled: false, lastLoginMethod: "email", kind: "person", workspaces: 2, createdAt: now,
};

const detail = {
  profile: {
    id: "usr_ada", email: "ada@acme.example", name: "Ada Lovelace", emailVerified: false, image: null, role: "user", operator: false,
    banned: false, banReason: null, banExpires: null, lastLoginMethod: "email", timezone: "Europe/London", locale: "en", createdAt: now, updatedAt: now,
  },
  memberships: [{ memberId: "mem_1", orgId: "org_acme", orgName: "Acme Works", plan: "pro", effectivePlan: "pro", isDemo: false, suspendedAt: null, role: "owner", kind: "human", joinedAt: now }],
  accounts: [{ id: "acc_1", providerId: "credential", accountId: "usr_ada", hasPassword: true, scope: null, createdAt: now, updatedAt: now }],
  twoFactor: { enabled: false, configured: false, verified: null, failedAttempts: 0, lockedUntil: null },
  lockout: { locked: true, lockedUntil: now, failures: 10, windowStart: now },
  activeSessions: 1,
};

async function mockUsers(page: Page) {
  await page.route("**/api/console/users?*", (r) => r.fulfill({ json: { items: [row], nextCursor: null } }));
  await page.route("**/api/console/users/usr_ada", (r) => r.fulfill({ json: detail }));
  await page.route("**/api/console/users/usr_ada/sessions*", (r) => r.fulfill({ json: { items: [{
    id: "ses_1", createdAt: now, updatedAt: now, expiresAt: now, active: true, ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    loginMethod: "email", activeOrganizationId: null, impersonatedBy: null,
  }], nextCursor: null } }));
}

test("the users list renders and a filter updates the address", async ({ page }) => {
  await signUp(page, "Olive Operator");
  await mockConsoleMe(page, "admin");
  await mockUsers(page);
  await page.goto("/console/users");
  await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-users-row")).toHaveText("Ada Lovelace");
  const table = page.getByRole("region", { name: "Users" });
  await expect(table.getByText("ada@acme.example")).toBeVisible();
  await expect(table.getByText("Unverified")).toBeVisible();

  await page.getByRole("combobox", { name: "Banned", exact: true }).selectOption("true");
  await expect(page).toHaveURL(/[?&]banned=true/);
  await page.getByRole("combobox", { name: "Two-step", exact: true }).selectOption("false");
  await expect(page).toHaveURL(/[?&]twoFactor=false/);

  await page.getByTestId("console-users-row").click();
  await expect(page).toHaveURL(/\/console\/users\/usr_ada/);
  await expect(page.getByRole("heading", { name: "Ada Lovelace", level: 1 })).toBeVisible();
});

test("Ban opens the reason dialog and sends the reason; tabs show workspaces and sessions", async ({ page }) => {
  await signUp(page, "Olive Operator");
  await mockConsoleMe(page, "admin");
  await mockUsers(page);
  let sent: unknown = null;
  await page.route("**/api/console/users/usr_ada/ban", async (r) => {
    sent = r.request().postDataJSON();
    await r.fulfill({ json: { ok: true, banned: true, banReason: "Spam run", banExpires: null, sessionsEnded: 1 } });
  });
  await page.goto("/console/users/usr_ada");
  await expect(page.getByRole("heading", { name: "Ada Lovelace", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-users-email")).toHaveText("ada@acme.example");

  await page.getByTestId("console-users-tab-workspaces").click();
  await expect(page).toHaveURL(/[?&]tab=workspaces/);
  await expect(page.getByTestId("console-users-workspace-link")).toHaveAttribute("href", "/console/workspaces/org_acme");
  await page.getByTestId("console-users-tab-sessions").click();
  await expect(page.getByText("Chrome on macOS")).toBeVisible();
  await expect(page.getByTestId("console-users-revoke-session")).toBeVisible();

  await page.getByTestId("console-users-ban").click();
  const dialog = page.getByTestId("reason-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByText("They are signed out everywhere straight away")).toBeVisible();
  await dialog.getByTestId("console-users-ban-length").selectOption("7");
  await dialog.getByLabel("Reason").fill("Spam run reported by three workspaces");
  await dialog.getByRole("button", { name: "Ban account" }).click();
  await expect.poll(() => sent).toEqual({ reason: "Spam run reported by three workspaces", expiresInDays: 7 });
  await expect(dialog).toHaveCount(0);

  await page.getByTestId("console-users-more").click();
  await expect(page.getByRole("menuitem", { name: "Clear lockout" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Mark email verified" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete account" })).toBeVisible();
});

test("a read only operator sees the account but no actions", async ({ page }) => {
  await signUp(page, "Rory Readonly");
  await mockConsoleMe(page, "ops_readonly");
  await mockUsers(page);
  await page.goto("/console/users/usr_ada");
  await expect(page.getByRole("heading", { name: "Ada Lovelace", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-users-badges")).toContainText("Unverified");
  await expect(page.getByTestId("console-users-ban")).toHaveCount(0);
  await expect(page.getByTestId("console-users-more")).toHaveCount(0);
  await page.getByTestId("console-users-tab-sessions").click();
  await expect(page.getByText("Chrome on macOS")).toBeVisible();
  await expect(page.getByTestId("console-users-revoke-session")).toHaveCount(0);
});

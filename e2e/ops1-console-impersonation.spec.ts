import { test, expect, type Page, type Route } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";
import type { OperatorRole } from "../src/shared/operator-permissions";

/**
 * OPS1 impersonation in the browser. The console side: "View as" on a person's page and on a workspace's Members tab
 * opens the dialog (View only by default, Act only for roles that may act) and sends the mode and reason; the Operators
 * page's Support sessions tab lists active sessions and End session sends the reason. The app side: the banner an
 * operator sees at the top of the app while viewing or acting as someone, with a countdown and Stop. Everything under
 * /api/console is mocked, and so is the impersonation (GET /api/account/me gains session.impersonation); the server
 * side (cookies, blocks, expiry, audit) is covered by tests/console-impersonation.test.ts.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

/** Adds session.impersonation to the real /me answer. */
async function asImpersonation(page: Page, mode: "view" | "act", secondsLeft: number) {
  await page.route((u) => u.pathname === "/api/account/me", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.session = { ...(json.session ?? {}), impersonation: { mode, expiresAt: new Date(Date.now() + secondsLeft * 1000).toISOString(), secondsLeft, operatorEmail: "olive@example.com" } };
    await route.fulfill({ response: res, json });
  });
}

function mockStop(page: Page, calls: string[]) {
  return page.route((u) => u.pathname === "/api/console/impersonation/stop", async (route) => {
    calls.push(route.request().method());
    await route.fulfill({ json: { ok: true, signedOut: false, returnTo: "/console/users/usr_e2e_target" } });
  });
}

test("view mode: the banner names the person, counts down, and Stop returns to the console", async ({ page }) => {
  await signUp(page, "Tara Target");
  const calls: string[] = [];
  await asImpersonation(page, "view", 25 * 60);
  await mockStop(page, calls);
  await page.goto("/app/my-work");
  const banner = page.getByTestId("impersonation-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toHaveAttribute("data-mode", "view");
  await expect(page.getByTestId("impersonation-banner-text")).toContainText("Viewing as Tara Target");
  await expect(page.getByTestId("impersonation-banner-text")).toContainText("view only");
  await expect(page.getByTestId("impersonation-banner-countdown")).toHaveText(/^2[45]:\d\d$/);
  // Fixed at the top and above the app: it stays in view.
  const box = await banner.boundingBox();
  expect(box?.y ?? 99).toBeLessThanOrEqual(1);
  await page.getByTestId("impersonation-banner-stop").click();
  await expect(page).toHaveURL(/\/console\/users\/usr_e2e_target$/, { timeout: 15_000 });
  expect(calls).toEqual(["POST"]);
});

test("act mode says changes are made in their name", async ({ page }) => {
  await signUp(page, "Arlo Act");
  await asImpersonation(page, "act", 10 * 60);
  await page.goto("/app/my-work");
  await expect(page.getByTestId("impersonation-banner")).toHaveAttribute("data-mode", "act", { timeout: 15_000 });
  await expect(page.getByTestId("impersonation-banner-text")).toContainText("Acting as Arlo Act");
  await expect(page.getByTestId("impersonation-banner-text")).toContainText("made in their name");
});

test("when the time runs out the banner says so and goes back to the console", async ({ page }) => {
  await signUp(page, "Eve Expiry");
  const calls: string[] = [];
  await asImpersonation(page, "view", 2);
  await mockStop(page, calls);
  await page.goto("/app/my-work");
  await expect(page.getByTestId("impersonation-banner-text")).toContainText("Your 30 minute session ended", { timeout: 15_000 });
  await expect(page).toHaveURL(/\/console\/users\/usr_e2e_target$/, { timeout: 15_000 });
  expect(calls).toEqual(["POST"]);
});

test("nobody else sees the banner", async ({ page }) => {
  await signUp(page, "Nora Normal");
  await expect(page.getByTestId("impersonation-banner")).toHaveCount(0);
});

test("reloading the page keeps the session: the saved copy of /me does not end it", async ({ page }) => {
  await signUp(page, "Rhea Reload");
  const calls: string[] = [];
  await asImpersonation(page, "view", 25 * 60);
  await mockStop(page, calls);
  await page.goto("/app/my-work");
  await expect(page.getByTestId("impersonation-banner-countdown")).toHaveText(/^2[45]:\d\d$/, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId("impersonation-banner-countdown")).toHaveText(/^2[45]:\d\d$/, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("impersonation-banner-text")).toContainText("Viewing as Rhea Reload");
  expect(calls).toEqual([]);
});

test("on a phone the banner keeps Stop in reach and does not cover the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, "Pia Phone");
  await asImpersonation(page, "view", 20 * 60);
  await page.goto("/app/my-work");
  const banner = page.getByTestId("impersonation-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("impersonation-banner-stop")).toBeVisible();
  // The app starts below the bar: its top padding is at least the bar's height.
  const box = (await banner.boundingBox())!;
  const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".app-shell")!).paddingTop));
  expect(pad).toBeGreaterThanOrEqual(Math.floor(box.height));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

// ------------------------------------------------------------------------------------------ the console side

const now = new Date().toISOString();

const person = {
  profile: {
    id: "usr_ada", email: "ada@acme.example", name: "Ada Lovelace", emailVerified: true, image: null, role: "user", operator: false,
    banned: false, banReason: null, banExpires: null, lastLoginMethod: "email", timezone: "Europe/London", locale: "en", createdAt: now, updatedAt: now,
  },
  memberships: [{ memberId: "mem_1", orgId: "org_acme", orgName: "Acme Works", plan: "pro", effectivePlan: "pro", isDemo: false, suspendedAt: null, role: "owner", kind: "human", joinedAt: now }],
  accounts: [{ id: "acc_1", providerId: "credential", accountId: "usr_ada", hasPassword: true, scope: null, createdAt: now, updatedAt: now }],
  twoFactor: { enabled: true, configured: true, verified: true, failedAttempts: 0, lockedUntil: null },
  lockout: { locked: false, lockedUntil: null, failures: 0, windowStart: null },
  activeSessions: 1,
};

const workspace = {
  org: {
    id: "org_acme", name: "Acme Works", slug: null, plan: "pro", effectivePlan: "pro", compPlan: false, isDemo: false, timezone: "UTC", country: "GB",
    createdAt: now, stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: "active", billingInterval: "month", currentPeriodEnd: null,
    cancelAtPeriodEnd: false, pastDueSince: null, graceEndsAt: null, requireSso: false, suspendedAt: null, suspendedReason: null, sendCapDaily: null,
    meetingMinutesCap: null, channelsEnabled: true, legacyStorageMb: null,
  },
  owner: { userId: "usr_ada", email: "ada@acme.example", name: "Ada Lovelace" },
  limits: { domains: 5, mailboxes: 20, aliases: 50, storagePerMailboxMb: 10240, storageMb: 102400, dailySends: 2000, seats: 20, agentInboxes: 5, agentMessagesMonthly: 5000, agentDailySends: 200, automationRunsMonthly: 10000, agentMembers: 5 },
  addons: {},
  usage: { domains: 1, mailboxes: 2, agentInboxes: 0, aliases: 0, seats: 3, storageMb: 20, agentMessages: 0 },
  counts: { members: 3, agentMembers: 1, pendingInvites: 0, agents: 0, apiKeys: 0, webhookEndpoints: 0, webhookEndpointsDisabled: 0, activeOauthGrants: 0, sendsToday: 0, meetingMinutesThisMonth: 0 },
  writeBudget: { used: 10, budget: 50000, level: "ok", resetAt: now },
};

const member = (id: string, userId: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, userId, email: `${name.split(" ")[0]!.toLowerCase()}@acme.example`, name, role: "member", kind: "human", title: null, emailVerified: true,
  twoFactorEnabled: false, banned: false, lastLoginMethod: "email", disabledAt: null, joinedAt: now, ...extra,
});

const activeSession = {
  id: "oimp_1", operatorUserId: "usr_sam", operatorEmail: "sam@multies.example", operatorName: "Sam Support",
  targetUserId: "usr_ada", targetEmail: "ada@acme.example", targetName: "Ada Lovelace",
  orgId: "org_acme", orgName: "Acme Works", orgOwnerEmail: "ada@acme.example", mode: "view",
  reason: "Customer reports the inbox shows no new mail since Monday", startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 24 * 60_000 + 20_000).toISOString(), endedAt: null, endedReason: null, active: true,
};
const endedSession = {
  ...activeSession, id: "oimp_0", operatorUserId: "usr_olive", operatorEmail: "olive@example.com", operatorName: "Olive Operator", mode: "act",
  reason: "Fixing a broken mail rule with the customer on the phone", startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  expiresAt: new Date(Date.now() - 2.5 * 3600_000).toISOString(), endedAt: new Date(Date.now() - 2.8 * 3600_000).toISOString(), endedReason: "stopped", active: false,
};

interface Sent { path: string; body: unknown }

/** Every /api/console read these tests need, plus the impersonation start and end, recorded in `sent`. */
async function mockConsole(page: Page, sent: Sent[]) {
  await page.route((u) => u.pathname.startsWith("/api/console/") && u.pathname !== "/api/console/me" && u.pathname !== "/api/console/impersonation/stop", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() !== "GET") {
      sent.push({ path: p, body: req.postDataJSON() });
      if (p === "/api/console/impersonation") return route.fulfill({ status: 201, json: { ok: true, impersonation: { id: "oimp_new", mode: "view", expiresAt: now, userId: "usr_ada", orgId: "org_acme" } } });
      return route.fulfill({ json: { ok: true } });
    }
    if (p === "/api/console/users/usr_ada") return route.fulfill({ json: person });
    if (p === "/api/console/workspaces/org_acme") return route.fulfill({ json: workspace });
    if (p === "/api/console/workspaces/org_acme/members") {
      return route.fulfill({ json: { items: [
        member("mem_1", "usr_ada", "Ada Lovelace", { role: "owner", twoFactorEnabled: true }),
        member("mem_2", "usr_bob", "Bob Banned", { banned: true }),
        member("mem_3", "usr_bot", "Triage Bot", { kind: "agent", email: "" }),
        member("mem_4", "usr_e2e_ops", "Olive Operator"),
      ], nextCursor: null } });
    }
    if (p === "/api/console/impersonation") {
      const status = url.searchParams.get("status");
      const items = status === "active" ? [activeSession] : status === "ended" ? [endedSession] : [activeSession, endedSession];
      return route.fulfill({ json: { items, nextCursor: null } });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
}

async function openConsole(page: Page, role: OperatorRole, sent: Sent[]) {
  await signUp(page, "Olive Operator");
  await mockConsoleMe(page, role);
  await mockConsole(page, sent);
}

test("View as on a person's page: View only by default, sends the mode and the reason, then opens the app", async ({ page }) => {
  const sent: Sent[] = [];
  await openConsole(page, "admin", sent);
  await page.goto("/console/users/usr_ada?org=org_acme");
  await expect(page.getByRole("heading", { name: "Ada Lovelace", level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("console-impersonate-button").click();
  const dialog = page.getByTestId("reason-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByText("View as this person?")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /View only/ })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: /Act as this person/ })).not.toBeChecked();
  await dialog.getByLabel("Reason").fill("Customer says the inbox is empty");
  await dialog.getByRole("button", { name: "View as this person" }).click();
  await expect.poll(() => sent.find((s) => s.path === "/api/console/impersonation")?.body)
    .toEqual({ userId: "usr_ada", orgId: "org_acme", mode: "view", reason: "Customer says the inbox is empty" });
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 });
});

test("an operations admin can choose Act, which sends act", async ({ page }) => {
  const sent: Sent[] = [];
  await openConsole(page, "ops_admin", sent);
  await page.goto("/console/users/usr_ada");
  await page.getByTestId("console-impersonate-button").click({ timeout: 15_000 });
  const dialog = page.getByTestId("reason-dialog");
  await dialog.getByTestId("console-impersonate-mode-act").click();
  await expect(dialog.getByRole("radio", { name: /Act as this person/ })).toBeChecked();
  await dialog.getByLabel("Reason").fill("Fixing their mail rule together");
  await dialog.getByRole("button", { name: "Act as this person" }).click();
  await expect.poll(() => (sent.find((s) => s.path === "/api/console/impersonation")?.body as { mode?: string } | undefined)?.mode).toBe("act");
});

test("a support operator sees View only and no Act choice", async ({ page }) => {
  await openConsole(page, "ops_support", []);
  await page.goto("/console/users/usr_ada");
  await page.getByTestId("console-impersonate-button").click({ timeout: 15_000 });
  const dialog = page.getByTestId("reason-dialog");
  await expect(dialog.getByRole("radio", { name: /View only/ })).toBeChecked();
  await expect(dialog.getByTestId("console-impersonate-mode-act")).toHaveCount(0);
  await expect(dialog.getByRole("radio")).toHaveCount(1);
});

test("the Members tab has one small View as per person row, opening that workspace", async ({ page }) => {
  const sent: Sent[] = [];
  await openConsole(page, "ops_support", sent);
  await page.goto("/console/workspaces/org_acme/members");
  const members = page.getByTestId("console-workspaces-members");
  await expect(members.getByRole("link", { name: "Ada Lovelace" })).toBeVisible({ timeout: 15_000 });
  // Ada only: not the banned person, the agent member, or yourself.
  await expect(members.getByTestId("console-impersonate-button")).toHaveCount(1);
  await members.getByTestId("console-impersonate-button").click();
  const dialog = page.getByTestId("reason-dialog");
  await expect(dialog).toBeVisible();
  // A click inside the dialog stays in the dialog (the row would otherwise open the person's page).
  await page.getByText("View as this person?").click();
  await expect(page).toHaveURL(/\/console\/workspaces\/org_acme\/members$/);
  await dialog.getByLabel("Reason").fill("Owner asked us to check a setting");
  await dialog.getByRole("button", { name: "View as this person" }).click();
  await expect.poll(() => sent.find((s) => s.path === "/api/console/impersonation")?.body)
    .toEqual({ userId: "usr_ada", orgId: "org_acme", mode: "view", reason: "Owner asked us to check a setting" });
});

test("a read only operator sees no View as on the Members tab", async ({ page }) => {
  await openConsole(page, "ops_readonly", []);
  await page.goto("/console/workspaces/org_acme/members");
  await expect(page.getByTestId("console-workspaces-members").getByRole("link", { name: "Ada Lovelace" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-impersonate-button")).toHaveCount(0);
});

test("Support sessions lists who is viewing as whom, and End session sends the reason", async ({ page }) => {
  const sent: Sent[] = [];
  await openConsole(page, "admin", sent);
  await page.goto("/console/operators");
  await expect(page.getByRole("heading", { name: "Operators", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("tablist", { name: "Operator sections" }).getByRole("tab")).toHaveText(["Operators", "Support sessions"]);
  await page.getByTestId("console-operators-tab-sessions").click();
  await expect(page).toHaveURL(/\/console\/operators\?tab=sessions$/);
  const table = page.getByRole("region", { name: "Support sessions" });
  await expect(table.getByRole("link", { name: "Sam Support" })).toHaveAttribute("href", "/console/users/usr_sam");
  await expect(table.getByRole("link", { name: "Ada Lovelace" })).toHaveAttribute("href", "/console/users/usr_ada");
  await expect(table.getByRole("link", { name: "Acme Works" })).toHaveAttribute("href", "/console/workspaces/org_acme");
  await expect(table.getByText("View only")).toBeVisible();
  await expect(table.getByText("Customer reports the inbox shows no new mail since Monday")).toBeVisible();
  await expect(table.getByText("in 24 min")).toBeVisible();
  // Active now is the default: the ended session is not listed.
  await expect(table.getByText("Olive Operator")).toHaveCount(0);

  await table.getByTestId("console-sessions-end").click();
  const dialog = page.getByTestId("reason-dialog");
  await expect(page.getByText("End this support session?")).toBeVisible();
  const box = page.getByRole("dialog", { name: "End this support session?" });
  await expect(box).toContainText("Sam Support is viewing as Ada Lovelace");
  await expect(box).toContainText("at their next action they leave Ada Lovelace's account");
  await expect(box).toContainText("both record it");
  await dialog.getByLabel("Reason").fill("Customer asked us to stop");
  await dialog.getByRole("button", { name: "End session" }).click();
  await expect.poll(() => sent.find((s) => s.path === "/api/console/impersonation/oimp_1/end")?.body).toEqual({ reason: "Customer asked us to stop" });
  await expect(dialog).toHaveCount(0);

  await page.getByRole("combobox", { name: "Show" }).selectOption("ended");
  await expect(page).toHaveURL(/status=ended/);
  await expect(table.getByText("Acting")).toBeVisible();
  await expect(table.getByTestId("console-sessions-end-reason")).toHaveText("Stopped by the operator");
  await expect(table.getByTestId("console-sessions-end")).toHaveCount(0);
});

test("with nobody viewing as anyone, the tab says so", async ({ page }) => {
  await signUp(page, "Olive Operator");
  await mockConsoleMe(page, "admin");
  await page.route((u) => u.pathname === "/api/console/impersonation", (r) => r.fulfill({ json: { items: [], nextCursor: null } }));
  await page.goto("/console/operators?tab=sessions");
  await expect(page.getByText("Nobody is viewing as anyone right now.")).toBeVisible({ timeout: 15_000 });
});

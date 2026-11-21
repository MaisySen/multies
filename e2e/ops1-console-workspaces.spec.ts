import { test, expect, type Page, type Route } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";
import type { OperatorRole } from "../src/shared/operator-permissions";

/**
 * OPS1: the Workspaces section of the operator console. The list filters through the address bar and opens a
 * workspace; the detail page shows the header actions and tabs; Suspend asks for a reason and sends it; notes can be
 * added; a read only operator sees no actions. /api/console/* is mocked; the server's own checks are covered by
 * tests/console-workspaces-routes.test.ts and tests/console-rbac.test.ts.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const now = new Date().toISOString();
const row = {
  id: "org_e2e", name: "Zephyr Rockets", slug: null, plan: "pro", effectivePlan: "pro", compPlan: false, isDemo: false,
  subscriptionStatus: "active", pastDueSince: null, graceEndsAt: null, suspendedAt: null, suspendedReason: null, sendCapDaily: null,
  createdAt: now, ownerEmail: "boss@zephyr.example", ownerUserId: "usr_boss", members: 4, agentMembers: 1, domains: 2,
};
const suspendedRow = { ...row, id: "org_susp", name: "Spammy Ltd", plan: "starter", effectivePlan: "starter", suspendedAt: now, suspendedReason: "Phishing", ownerEmail: "ops@spammy.example", ownerUserId: "usr_spam" };
const limits = {
  domains: 5, mailboxes: 20, aliases: 50, storagePerMailboxMb: 10240, storageMb: 102400, dailySends: 2000, seats: 20, agentInboxes: 5,
  agentMessagesMonthly: 5000, agentDailySends: 200, automationRunsMonthly: 10000, agentMembers: 5,
};
const overview = {
  org: {
    id: "org_e2e", name: "Zephyr Rockets", slug: null, plan: "pro", effectivePlan: "pro", compPlan: false, isDemo: false, timezone: "UTC", country: "AU",
    createdAt: now, stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: "active", billingInterval: "month", currentPeriodEnd: null,
    cancelAtPeriodEnd: false, pastDueSince: null, graceEndsAt: null, requireSso: false, suspendedAt: null, suspendedReason: null, sendCapDaily: null,
    meetingMinutesCap: null, channelsEnabled: true, legacyStorageMb: null,
  },
  owner: { userId: "usr_boss", email: "boss@zephyr.example", name: "Bo Boss" },
  limits, addons: {},
  usage: { domains: 2, mailboxes: 6, agentInboxes: 1, aliases: 3, seats: 4, storageMb: 120, agentMessages: 40 },
  counts: { members: 4, agentMembers: 1, pendingInvites: 0, agents: 1, apiKeys: 2, webhookEndpoints: 1, webhookEndpointsDisabled: 0, activeOauthGrants: 0, sendsToday: 12, meetingMinutesThisMonth: 30 },
  writeBudget: { used: 1200, budget: 50000, level: "ok", resetAt: now },
};

const suspendedOverview = {
  ...overview,
  org: { ...overview.org, id: "org_susp", name: "Spammy Ltd", plan: "starter", effectivePlan: "starter", suspendedAt: now, suspendedReason: "Phishing" },
  owner: { userId: "usr_spam", email: "ops@spammy.example", name: "" },
};

interface Calls { method: string; path: string; body: unknown }

/** One handler for every /api/console/workspaces request; records changes. */
async function mockWorkspaces(page: Page, calls: Calls[]) {
  await page.route((url) => url.pathname.startsWith("/api/console/workspaces"), async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() !== "GET") {
      calls.push({ method: req.method(), path: p, body: req.postDataJSON() });
      if (p.endsWith("/notes")) return route.fulfill({ status: 201, json: { note: { id: "onote_new", targetType: "workspace", targetId: "org_e2e", body: "x", pinned: false, authorUserId: "usr_e2e_ops", authorEmail: "olive@example.com", createdAt: now, updatedAt: now } } });
      return route.fulfill({ json: { ok: true } });
    }
    if (p === "/api/console/workspaces") {
      const state = url.searchParams.get("state");
      return route.fulfill({ json: { items: state === "suspended" ? [suspendedRow] : [row, suspendedRow], nextCursor: null } });
    }
    if (p === "/api/console/workspaces/notes") {
      return route.fulfill({ json: { items: [{ id: "onote_1", targetType: "workspace", targetId: "org_e2e", body: "Promised a call back on Monday", pinned: true, authorUserId: "usr_other", authorEmail: "sam@example.com", createdAt: now, updatedAt: now }], nextCursor: null } });
    }
    if (p === "/api/console/workspaces/org_e2e") return route.fulfill({ json: overview });
    if (p === "/api/console/workspaces/org_susp") return route.fulfill({ json: suspendedOverview });
    if (p === "/api/console/workspaces/org_e2e/mail") return route.fulfill({ status: 500, json: { error: { code: "internal", message: "The mail read failed." } } });
    if (p === "/api/console/workspaces/org_e2e/members") {
      return route.fulfill({ json: { items: [{ id: "mem_1", userId: "usr_boss", email: "boss@zephyr.example", name: "Bo Boss", role: "owner", kind: "human", title: null, emailVerified: true, twoFactorEnabled: true, banned: false, lastLoginMethod: "email", disabledAt: null, joinedAt: now }], nextCursor: null } });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
}

async function open(page: Page, role: OperatorRole, calls: Calls[]) {
  await signUp(page, "Olive Operator");
  await mockConsoleMe(page, role);
  await mockWorkspaces(page, calls);
}

test("the list filters through the address bar and a row opens the workspace", async ({ page }) => {
  const calls: Calls[] = [];
  await open(page, "admin", calls);
  await page.goto("/console/workspaces");
  await expect(page.getByRole("heading", { name: "Workspaces", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "Zephyr Rockets" })).toBeVisible();
  // The owner links to their console page (the service now returns the owner's user id).
  await expect(page.getByRole("link", { name: "boss@zephyr.example" })).toHaveAttribute("href", "/console/users/usr_boss");
  await expect(page.getByRole("combobox", { name: "State" }).locator("option[value=comp]")).toHaveText("Free Business plan");

  await page.getByRole("combobox", { name: "State" }).selectOption("suspended");
  await expect(page).toHaveURL(/state=suspended/);
  await expect(page.getByRole("link", { name: "Spammy Ltd" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Zephyr Rockets" })).toHaveCount(0);

  await page.getByRole("combobox", { name: "State" }).selectOption("");
  await page.getByRole("link", { name: "Zephyr Rockets" }).click();
  await expect(page).toHaveURL(/\/console\/workspaces\/org_e2e$/);
  await expect(page.getByRole("heading", { name: "Zephyr Rockets", level: 1 })).toBeVisible();
  await expect(page.getByTestId("console-workspaces-id")).toContainText("org_e2e");
  await expect(page.getByRole("button", { name: "Copy workspace id" })).toBeVisible();
  await expect(page.getByTestId("console-workspaces-owner").getByRole("link", { name: "Bo Boss" })).toHaveAttribute("href", "/console/users/usr_boss");
  await expect(page.getByTestId("console-back-link")).toHaveText("All workspaces");
});

test("Suspend asks for a reason and sends it; the sending switch and notes work", async ({ page }) => {
  const calls: Calls[] = [];
  await open(page, "admin", calls);
  await page.goto("/console/workspaces/org_e2e");
  await expect(page.getByRole("heading", { name: "Zephyr Rockets", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-workspaces-overview")).toBeVisible();

  await page.getByTestId("console-workspaces-suspend").click();
  const dialog = page.getByRole("dialog", { name: "Suspend Zephyr Rockets?" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill("Phishing reports from three people");
  await dialog.getByRole("button", { name: "Suspend workspace" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => calls.find((c) => c.path.endsWith("/org_e2e/suspend"))?.body).toEqual({ reason: "Phishing reports from three people" });

  await page.getByTestId("admin-sending-toggle").click();
  const off = page.getByRole("dialog", { name: "Turn sending off for Zephyr Rockets?" });
  await off.getByLabel("Reason").fill("Spam wave");
  await off.getByRole("button", { name: "Confirm" }).click();
  await expect(off).toBeHidden();
  await expect.poll(() => calls.find((c) => c.path.endsWith("/org_e2e/sending"))?.body).toEqual({ enabled: false, reason: "Spam wave" });

  await page.getByRole("link", { name: "Members" }).click();
  await expect(page).toHaveURL(/\/console\/workspaces\/org_e2e\/members$/);
  await expect(page.getByTestId("console-workspaces-members").getByRole("link", { name: "Bo Boss" })).toHaveAttribute("href", "/console/users/usr_boss?org=org_e2e");

  await page.getByRole("link", { name: "Notes" }).click();
  await expect(page.getByText("Promised a call back on Monday")).toBeVisible();
  await page.getByTestId("console-notes-input").fill("Called them about the bounce rate");
  await page.getByTestId("console-notes-add").click();
  await expect.poll(() => calls.find((c) => c.path.endsWith("/notes"))?.body).toEqual({ targetType: "workspace", targetId: "org_e2e", body: "Called them about the bounce rate", pinned: false });
});

test("a suspended workspace shows sending stopped; tabs are merged; a failed tab keeps the header", async ({ page }) => {
  const calls: Calls[] = [];
  await open(page, "admin", calls);
  await page.goto("/console/workspaces/org_susp");
  await expect(page.getByRole("heading", { name: "Spammy Ltd", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-workspaces-sending-state")).toContainText("Stopped while suspended");
  await expect(page.getByTestId("admin-sending-toggle")).toBeDisabled();
  await expect(page.getByTestId("console-workspaces-restore")).toBeVisible();
  await page.getByTestId("console-workspaces-more").click();
  await expect(page.getByRole("menuitem", { name: "Change daily send cap" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Turn sending/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Usage holds the old Trends, Audit reads Activity (its address stays /audit).
  const tabs = page.getByRole("navigation", { name: "Sections" }).getByRole("link");
  await expect(tabs).toHaveText(["Overview", "Members", "Billing", "Usage", "Mail", "Agents", "Developer", "Flags", "Activity", "Notes"]);
  await expect(page.getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/console/workspaces/org_susp/audit");
  await expect(page.getByTestId("console-workspaces-overview")).not.toContainText("Usage against limits");
  await expect(page.getByTestId("console-workspaces-overview")).not.toContainText("Counts");

  // A tab whose read fails shows the error in the tab; the header and back link stay.
  await page.goto("/console/workspaces/org_e2e/mail");
  await expect(page.getByTestId("console-load-error")).toContainText("The mail read failed.", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Zephyr Rockets", level: 1 })).toBeVisible();
  await expect(page.getByTestId("console-back-link")).toBeVisible();
});

test("a read only operator sees the workspace but no actions", async ({ page }) => {
  const calls: Calls[] = [];
  await open(page, "ops_readonly", calls);
  await page.goto("/console/workspaces/org_e2e");
  await expect(page.getByRole("heading", { name: "Zephyr Rockets", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-workspaces-overview")).toBeVisible();
  await expect(page.getByTestId("console-workspaces-suspend")).toHaveCount(0);
  await expect(page.getByTestId("console-workspaces-more")).toHaveCount(0);
  await expect(page.getByTestId("admin-sending-toggle")).toHaveCount(0);
  await page.getByRole("link", { name: "Notes" }).click();
  await expect(page.getByText("Promised a call back on Monday")).toBeVisible();
  await expect(page.getByTestId("console-notes-form")).toHaveCount(0);
  await expect(page.getByTestId("console-note-delete")).toHaveCount(0);
  expect(calls).toEqual([]);
});

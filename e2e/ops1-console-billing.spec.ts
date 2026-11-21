import { test, expect, type Page, type Route } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * OPS1: Billing in the operator console. The console API is mocked with page.route (as in r33-ui-admin.spec.ts), so
 * this checks the page and the workspace Billing tab only; the server's rules are in tests/console-billing-routes.test.ts.
 * The workspace tab tests open /console/workspaces/:id/billing, which the Workspaces section's detail page renders with
 * WorkspaceBillingTab. If that page reads its own workspace endpoint first, mock it here with that section's shape.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-billing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const page1 = <T>(items: T[]) => ({ items, nextCursor: null });

const pastDue = {
  orgId: "org_e2e_late", name: "Late Labs", plan: "pro", effectivePlan: "pro", comp: false, status: "past_due",
  stage: "paused", pastDueSince: iso(now - 9 * DAY), graceEndsAt: iso(now - 2 * DAY), sendingPaused: true, daysPastDue: 9,
  stripeCustomerId: "cus_e2e_late", stripeSubscriptionId: "sub_e2e_late",
};
const subscription = {
  orgId: "org_e2e_acme", name: "Acme Studio", plan: "pro", effectivePlan: "pro", comp: false, compUntil: null, compNote: null,
  status: "active", interval: "month", currentPeriodEnd: iso(now + 20 * DAY), cancelAtPeriodEnd: false, pastDue: false,
  stripeCustomerId: "cus_e2e_acme", stripeSubscriptionId: "sub_e2e_acme", createdAt: iso(now - 90 * DAY),
};
const workspaceBilling = {
  orgId: "org_e2e_acme", name: "Acme Studio", currency: "aud",
  billing: { enabled: true, testMode: true }, plan: "pro", effectivePlan: "pro",
  comp: { on: false, until: null, note: null, expirySupported: true },
  stripe: { customerId: "cus_e2e_acme", subscriptionId: "sub_e2e_acme" },
  subscription: { status: "active", interval: "month", currentPeriodEnd: iso(now + 20 * DAY), cancelAtPeriodEnd: false },
  dunning: null, addons: { domain: 1 },
  usage: { domains: 1, mailboxes: 4, agentInboxes: 0, aliases: 2, seats: 3, storageMb: 512, agentMessages: 10, sendsToday: 12 },
  limits: { domains: 6, mailboxes: 25, aliases: 200, storagePerMailboxMb: 10240, storageMb: 256000, dailySends: 2000, seats: 10, agentInboxes: 10, agentMessagesMonthly: 10000, agentDailySends: 500, automationRunsMonthly: 10000, agentMembers: 25, toolRunsMonthly: 1000, toolRunsDaily: 200, toolMaxBytes: 52428800, toolMaxMergeFiles: 20 },
  referralCode: null,
  invoices: [{ id: "in_e2e_1", number: "MM-0042", status: "paid", total: 2900, currency: "aud", createdAt: iso(now - 10 * DAY), periodStart: iso(now - 40 * DAY), periodEnd: iso(now - 10 * DAY) }],
  invoicesError: null,
  recentEvents: [{ id: "evt_e2e_1", type: "invoice.paid", orgId: "org_e2e_acme", orgName: "Acme Studio", summary: "Invoice MM-0042 paid: A$29.00", createdAt: iso(now - 10 * DAY) }],
  bounds: { creditMinCents: 1, creditMaxCents: 50000, trialDaysMax: 90, graceDaysMax: 30, compMaxDays: 1098, noteMax: 300 },
};

/** Billing reads, plus a plain workspace for the Workspaces section's own detail reads. */
async function mockBilling(page: Page, opts: { enabled: boolean }) {
  await page.route(/\/api\/console\/billing\/status$/, (r) => r.fulfill({ json: { enabled: opts.enabled, testMode: true, currency: "aud" } }));
  await page.route(/\/api\/console\/billing\/past-due(\?|$)/, (r) => r.fulfill({ json: page1([pastDue]) }));
  await page.route(/\/api\/console\/billing\/subscriptions(\?|$)/, (r) => r.fulfill({ json: page1([subscription]) }));
  await page.route(/\/api\/console\/billing\/events(\?|$)/, (r) => r.fulfill({ json: page1(workspaceBilling.recentEvents) }));
  await page.route(/\/api\/console\/billing\/referrals(\?|$)/, (r) => r.fulfill({ json: page1([]) }));
  await page.route(/\/api\/console\/billing\/workspaces\/org_e2e_acme$/, (r) => r.fulfill({ json: workspaceBilling }));
  // The Workspaces detail page reads the workspace before it shows any tab.
  await page.route(/\/api\/console\/workspaces\/org_e2e_acme$/, (r) => r.fulfill({ json: workspaceOverview }));
}

const workspaceOverview = {
  org: {
    id: "org_e2e_acme", name: "Acme Studio", slug: null, plan: "pro", effectivePlan: "pro", compPlan: false, isDemo: false, timezone: "UTC", country: "AU",
    createdAt: iso(now - 90 * DAY), stripeCustomerId: "cus_e2e_acme", stripeSubscriptionId: "sub_e2e_acme", subscriptionStatus: "active", billingInterval: "month",
    currentPeriodEnd: iso(now + 20 * DAY), cancelAtPeriodEnd: false, pastDueSince: null, graceEndsAt: null, requireSso: false, suspendedAt: null, suspendedReason: null,
    sendCapDaily: null, meetingMinutesCap: null, channelsEnabled: true, legacyStorageMb: null,
  },
  limits: workspaceBilling.limits, addons: workspaceBilling.addons,
  usage: { domains: 1, mailboxes: 4, agentInboxes: 0, aliases: 2, seats: 3, storageMb: 512, agentMessages: 10 },
  counts: { members: 3, agentMembers: 0, pendingInvites: 0, agents: 0, apiKeys: 0, webhookEndpoints: 0, webhookEndpointsDisabled: 0, activeOauthGrants: 0, sendsToday: 12, meetingMinutesThisMonth: 0 },
  writeBudget: { used: 100, budget: 50000, level: "ok", resetAt: iso(now + DAY) },
};

test("the billing page opens on Past due, says when billing is not connected, and a filter goes into the address", async ({ page }) => {
  await signUp(page, "Bea Billing");
  await mockConsoleMe(page, "ops_billing");
  await mockBilling(page, { enabled: false });
  await page.goto("/console/billing");
  await expect(page.getByRole("heading", { name: "Billing", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-billing-not-connected")).toBeVisible();
  await expect(page.getByTestId("console-billing-tab-past-due")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Late Labs" })).toBeVisible();
  await expect(page.getByText("Sending paused")).toBeVisible();

  await page.getByTestId("console-billing-tab-subscriptions").click();
  await expect(page).toHaveURL(/tab=subscriptions/);
  await expect(page.getByRole("link", { name: "Acme Studio" })).toBeVisible();
  const listCall = page.waitForRequest((req) => /\/api\/console\/billing\/subscriptions\?.*status=past_due/.test(req.url()));
  await page.getByRole("combobox", { name: "Status" }).selectOption("past_due");
  await expect(page).toHaveURL(/status=past_due/);
  await expect(page).toHaveURL(/tab=subscriptions/);
  await listCall;

  await page.getByTestId("console-billing-tab-events").click();
  await expect(page).toHaveURL(/tab=events/);
  await expect(page.getByText("Invoice MM-0042 paid: A$29.00")).toBeVisible();
});

test("adding credit on a workspace's Billing tab explains the charge, asks for a reason and sends cents", async ({ page }) => {
  await signUp(page, "Bea Billing");
  await mockConsoleMe(page, "ops_billing");
  await mockBilling(page, { enabled: true });
  let sent: Record<string, unknown> | null = null;
  await page.route(/\/api\/console\/billing\/workspaces\/org_e2e_acme\/credit$/, async (r: Route) => {
    sent = r.request().postDataJSON() as Record<string, unknown>;
    await r.fulfill({ json: { ok: true, transactionId: "cbtxn_e2e", amountCents: 2500, currency: "aud", balanceCents: -2500 } });
  });
  await page.goto("/console/workspaces/org_e2e_acme/billing");
  const tab = page.getByTestId("console-billing-workspace");
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await expect(tab.getByText("cus_e2e_acme")).toBeVisible();
  await expect(page.getByTestId("console-billing-invoices")).toContainText("A$29.00");

  await page.getByTestId("console-billing-action-credit").click();
  const dialog = page.getByTestId("reason-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByText(/Nothing is charged now/)).toBeVisible();
  await page.getByTestId("console-billing-credit-amount").fill("25");
  await page.getByTestId("console-billing-credit-note").fill("Credit for the outage");
  await dialog.getByLabel("Reason").fill("Outage on ticket 4411");
  await dialog.getByRole("button", { name: "Add A$25.00 credit" }).click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent).toMatchObject({ amountCents: 2500, note: "Credit for the outage", reason: "Outage on ticket 4411" });
  expect(typeof sent!.requestKey).toBe("string");
  await expect(page.getByText("Credit added")).toBeVisible();
});

test("a support operator sees the workspace's billing but no billing actions", async ({ page }) => {
  await signUp(page, "Sam Support");
  await mockConsoleMe(page, "ops_support");
  await mockBilling(page, { enabled: true });
  await page.goto("/console/workspaces/org_e2e_acme/billing");
  await expect(page.getByTestId("console-billing-workspace")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-billing-invoices")).toBeVisible();
  await expect(page.getByTestId("console-billing-actions")).toHaveCount(0);
  await expect(page.getByTestId("console-billing-action-credit")).toHaveCount(0);
  await expect(page.getByTestId("console-billing-action-comp")).toHaveCount(0);
});

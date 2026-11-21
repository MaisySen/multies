import { test, expect, type Page } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";
import type { OperatorRole } from "../src/shared/operator-permissions";

/**
 * OPS1: the Feature flags page at /console/flags. The list shows each flag's value for everyone and where it comes
 * from, a group chip updates the address, a row opens the flag's detail, and an owner's "Turn on for everyone" asks for
 * a reason and sends it. A read only operator sees no change buttons. The console API is mocked (page.route); the
 * server side is covered by tests/console-flags-routes.test.ts.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-flags-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const now = new Date().toISOString();
const base = { requires: [], globalOverride: null, workspaceOverrideCount: 0, features: false };
const flags = [
  { ...base, key: "mailArchive", env: "MAIL_ARCHIVE_R111", label: "Mail archive and retention", description: "Archive and retention settings for mail.", group: "Mail and inbox", scope: "workspace", runtime: true, bootReason: null, envDefault: false, effective: false, workspaceOverrideCount: 2 },
  { ...base, key: "mailSplitCounts", env: "MAIL_SPLIT_COUNTS", label: "Unread counts on split inbox tabs", description: "Counts unread mail on the tabs.", group: "Mail and inbox", scope: "global", runtime: true, bootReason: null, envDefault: true, effective: false,
    globalOverride: { value: false, locked: true, note: null, updatedBy: "usr_1", updatedByEmail: "olive@example.com", updatedAt: now } },
  { ...base, key: "chatPlus", env: "CHAT_PLUS", label: "Chat extras", description: "Topics, polls and live questions in chat.", group: "Chat and meetings", scope: "workspace", runtime: false, bootReason: "Its routes are added when the server starts, so a change needs a deploy.", envDefault: true, effective: true },
];
const detail = {
  flag: flags[0],
  overrides: { nextCursor: null, items: [
    { orgId: "org_e2e_a", workspaceName: "Harbour Studio", value: true, note: "Pilot", updatedByEmail: "olive@example.com", updatedAt: now, applies: true },
    { orgId: "org_e2e_b", workspaceName: "Pine Bakery", value: false, note: null, updatedByEmail: null, updatedAt: now, applies: true },
  ] },
};

/** Which flags the list answers for each Show choice ("modified" is the page's default when anything is changed). */
function listFor(state: string | null) {
  if (state === "modified") return flags.filter((f) => f.globalOverride || f.workspaceOverrideCount > 0);
  if (state === "deploy") return flags.filter((f) => !f.runtime);
  return flags;
}

async function mockFlags(page: Page, role: OperatorRole, opts: { nothingChanged?: boolean } = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  await mockConsoleMe(page, role);
  await page.route(/\/api\/console\/flags(\?.*)?$/, (r) => {
    const state = new URL(r.request().url()).searchParams.get("state");
    const items = opts.nothingChanged && state === "modified" ? [] : listFor(state);
    return r.fulfill({ json: { items, nextCursor: null } });
  });
  await page.route(/\/api\/console\/flags\/mailArchive(\?.*)?$/, (r) => r.fulfill({ json: detail }));
  await page.route(/\/api\/console\/flags\/mailArchive\/(global|workspaces\/[^/?]+)$/, async (r) => {
    calls.push({ method: r.request().method(), url: r.request().url(), body: r.request().postDataJSON() });
    await r.fulfill({ json: { ok: true, override: { value: true, locked: false } } });
  });
  return calls;
}

test("an owner sees the flags, filters by group, opens a flag and turns it on for everyone with a reason", async ({ page }) => {
  await signUp(page, "Olive Operator");
  const calls = await mockFlags(page, "admin");
  await page.goto("/console/flags");
  await expect(page.getByRole("heading", { name: "Feature flags", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-flags-propagation")).toContainText("up to a minute");

  // Something is changed, so the list opens on "Changed from default" and the chip says so; the address stays clean.
  const show = page.getByRole("combobox", { name: "Show" });
  await expect(show).toHaveValue("modified");
  await expect(page.getByTestId("console-flags-state-mailArchive")).toBeVisible();
  await expect(page.getByTestId("console-flags-state-chatPlus")).toHaveCount(0);
  expect(page.url()).not.toContain("state=");
  // Picking another choice is kept in the address.
  await show.selectOption("all");
  await expect(page).toHaveURL(/state=all/);
  await expect(show).toHaveValue("all");

  await expect(page.getByTestId("console-flags-state-mailArchive")).toContainText("Off");
  await expect(page.getByTestId("console-flags-state-mailArchive")).toContainText("default");
  await expect(page.getByTestId("console-flags-state-mailSplitCounts")).toContainText("locked for everyone");
  await expect(page.getByTestId("console-flags-state-chatPlus")).toContainText("On");
  await expect(page.getByTestId("console-flags-deploy-note")).toHaveCount(1);
  await expect(page.getByTestId("console-flags-deploy-note")).toHaveAttribute("title", /needs a deploy/);
  // A platform wide flag shows a small tag with the reason in its title, not a count.
  await expect(page.getByText("Platform only")).toHaveAttribute("title", /one setting for the whole platform/);

  // A group chip goes into the address, so the filtered list can be shared.
  await page.getByRole("combobox", { name: "Group" }).selectOption("Mail and inbox");
  await expect(page).toHaveURL(/group=Mail\+and\+inbox/);
  await expect(page).toHaveURL(/state=all/);

  // The row opens its detail, named in the address.
  await page.getByTestId("console-flags-row-mailArchive").click();
  await expect(page).toHaveURL(/flag=mailArchive/);
  const panel = page.getByTestId("console-flags-detail");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Default from deploy settings")).toBeVisible();
  await expect(panel.getByTestId("console-flags-overrides")).toContainText("Harbour Studio");
  await expect(panel.getByTestId("console-flags-overrides")).toContainText("Pine Bakery");
  await expect(panel.getByTestId("console-flags-global-reset")).toBeDisabled();

  await panel.getByTestId("console-flags-global-on").click();
  const form = page.getByTestId("reason-dialog");
  await expect(form).toBeVisible();
  await form.getByTestId("console-flags-lock").check();
  await form.getByLabel("Reason").fill("Roll out archive to everyone");
  await form.getByRole("button", { name: "Save for everyone" }).click();
  await expect(form).toBeHidden();
  await expect.poll(() => calls.find((c) => c.url.endsWith("/flags/mailArchive/global"))).toMatchObject({
    method: "PUT", body: { value: true, locked: true, reason: "Roll out archive to everyone" },
  });
});

test("a read only operator sees the flags but no change buttons", async ({ page }) => {
  await signUp(page, "Rory Readonly");
  await mockFlags(page, "ops_readonly");
  await page.goto("/console/flags?flag=mailArchive");
  const panel = page.getByTestId("console-flags-detail");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText("Only owners can change the setting for everyone.")).toBeVisible();
  await expect(panel.getByTestId("console-flags-global-on")).toHaveCount(0);
  await expect(panel.getByTestId("console-flags-overrides")).toContainText("Harbour Studio");
  await expect(panel.getByRole("button", { name: "Remove" })).toHaveCount(0);
});

test("with nothing changed the list opens on all flags", async ({ page }) => {
  await signUp(page, "Nina Nochange");
  await mockFlags(page, "ops_readonly", { nothingChanged: true });
  await page.goto("/console/flags");
  await expect(page.getByRole("heading", { name: "Feature flags", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("combobox", { name: "Show" })).toHaveValue("all");
  await expect(page.getByTestId("console-flags-state-chatPlus")).toBeVisible();
  expect(page.url()).not.toContain("state=");
});

// ------------------------------------------------------------------ a workspace's Flags tab

const wsOrg = {
  id: "org_e2e", name: "Zephyr Rockets", slug: null, plan: "pro", effectivePlan: "pro", compPlan: false, isDemo: false, timezone: "UTC", country: "AU",
  createdAt: now, stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: "active", billingInterval: "month", currentPeriodEnd: null,
  cancelAtPeriodEnd: false, pastDueSince: null, graceEndsAt: null, requireSso: false, suspendedAt: null, suspendedReason: null, sendCapDaily: null,
  meetingMinutesCap: null, channelsEnabled: true, legacyStorageMb: null,
};
const wsOverview = {
  org: wsOrg,
  limits: { domains: 5, mailboxes: 20, aliases: 50, storagePerMailboxMb: 10240, storageMb: 102400, dailySends: 2000, seats: 20, agentInboxes: 5, agentMessagesMonthly: 5000, agentDailySends: 200, automationRunsMonthly: 10000, agentMembers: 5 },
  addons: {},
  usage: { domains: 2, mailboxes: 6, agentInboxes: 1, aliases: 3, seats: 4, storageMb: 120, agentMessages: 40 },
  counts: { members: 4, agentMembers: 1, pendingInvites: 0, agents: 1, apiKeys: 2, webhookEndpoints: 1, webhookEndpointsDisabled: 0, activeOauthGrants: 0, sendsToday: 12, meetingMinutesThisMonth: 30 },
  writeBudget: { used: 1200, budget: 50000, level: "ok", resetAt: now },
};
const wsBase = { description: "What it does.", group: "Mail and inbox", scope: "workspace", runtime: true, bootReason: null, envDefault: false, global: null, platformValue: false, workspaceOverride: null, effective: false, source: "default", blocked: null };
const wsRows = [
  { ...wsBase, key: "mailArchive", label: "Mail archive and retention", workspaceOverride: { value: true, note: null, updatedAt: now, applies: true }, effective: true, source: "workspace" },
  { ...wsBase, key: "oneInbox", label: "One inbox" },
  { ...wsBase, key: "mailSplitCounts", label: "Unread counts on split inbox tabs", scope: "global", blocked: "global_only" },
  { ...wsBase, key: "chatPlus", label: "Chat extras", runtime: false, bootReason: "Its routes are added when the server starts, so a change needs a deploy.", effective: true, blocked: "deploy" },
  { ...wsBase, key: "pushNotify", label: "Push notifications to phones", global: { value: false, locked: true }, source: "locked", blocked: "locked" },
];

async function mockWorkspaceFlags(page: Page, opts: { noOwn?: boolean } = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  await page.route((url) => url.pathname.startsWith("/api/console/workspaces"), (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p === "/api/console/workspaces/org_e2e") return r.fulfill({ json: wsOverview });
    return r.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.route((url) => url.pathname === "/api/console/flags/workspaces/org_e2e", (r) => {
    const state = new URL(r.request().url()).searchParams.get("state");
    const items = state === "own" ? (opts.noOwn ? [] : wsRows.filter((x) => x.workspaceOverride)) : wsRows;
    return r.fulfill({ json: { workspace: { id: "org_e2e", name: "Zephyr Rockets" }, items, nextCursor: null } });
  });
  await page.route((url) => /^\/api\/console\/flags\/[^/]+\/workspaces\/org_e2e$/.test(url.pathname), async (r) => {
    calls.push({ method: r.request().method(), url: r.request().url(), body: r.request().postDataJSON() });
    await r.fulfill({ json: { ok: true, override: { value: true } } });
  });
  return calls;
}

test("a workspace's Flags tab opens on its own settings, shows all on request, and tags what cannot change", async ({ page }) => {
  await signUp(page, "Olive Operator");
  await mockConsoleMe(page, "admin");
  const calls = await mockWorkspaceFlags(page);
  await page.goto("/console/workspaces/org_e2e/flags");
  const tab = page.getByTestId("console-workspace-flags");
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await expect(tab.getByRole("combobox", { name: "Show" })).toHaveValue("own");
  await expect(page.getByTestId("console-flags-ws-state-mailArchive")).toContainText("this workspace");
  await expect(page.getByTestId("console-flags-ws-state-oneInbox")).toHaveCount(0);

  await page.getByTestId("console-flags-ws-show-all").click();
  await expect(page).toHaveURL(/state=all/);
  await expect(page.getByTestId("console-flags-ws-state-oneInbox")).toBeVisible();
  await expect(page.getByTestId("console-flags-ws-show-all")).toHaveCount(0);
  // Rows that cannot change here carry a small tag (reason in the title) instead of a disabled button.
  await expect(page.getByTestId("console-flags-ws-blocked-mailSplitCounts")).toHaveText("Platform only");
  await expect(page.getByTestId("console-flags-ws-blocked-mailSplitCounts")).toHaveAttribute("title", /whole platform/);
  await expect(page.getByTestId("console-flags-ws-blocked-chatPlus")).toHaveText("Set at deploy");
  await expect(page.getByTestId("console-flags-ws-blocked-pushNotify")).toHaveText("Locked");
  await expect(page.getByTestId("console-flags-ws-set-mailSplitCounts")).toHaveCount(0);
  await expect(tab.locator("button:disabled")).toHaveCount(0);

  await page.getByTestId("console-flags-ws-set-oneInbox").click();
  const form = page.getByTestId("reason-dialog");
  await expect(form).toBeVisible();
  await form.getByLabel("Reason").fill("Customer pilot for one inbox");
  await form.getByRole("button", { name: "Save for this workspace" }).click();
  await expect.poll(() => calls.find((c) => c.url.endsWith("/flags/oneInbox/workspaces/org_e2e"))).toMatchObject({
    method: "PUT", body: { value: true, reason: "Customer pilot for one inbox" },
  });
});

test("a workspace with no own settings says so and offers all flags", async ({ page }) => {
  await signUp(page, "Rory Readonly");
  await mockConsoleMe(page, "ops_readonly");
  await mockWorkspaceFlags(page, { noOwn: true });
  await page.goto("/console/workspaces/org_e2e/flags");
  const tab = page.getByTestId("console-workspace-flags");
  await expect(tab.getByText("This workspace uses the default for every flag.")).toBeVisible({ timeout: 15_000 });
  await tab.getByRole("button", { name: "Show all flags" }).last().click();
  await expect(page).toHaveURL(/state=all/);
  await expect(page.getByTestId("console-flags-ws-state-chatPlus")).toBeVisible();
  // A read only operator gets the deploy tag beside the value and no change buttons.
  await expect(tab.getByTestId("console-flags-deploy-note")).toHaveText("Set at deploy");
  await expect(page.getByTestId("console-flags-ws-set-oneInbox")).toHaveCount(0);
});

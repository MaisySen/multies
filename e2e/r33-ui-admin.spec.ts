import { test, expect } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * R33 premium pass for admins and guests: the operator console asks for a suspend reason and a send cap in
 * themed dialogs (no window.prompt), checks the input before it saves, and destructive row actions take two taps.
 * Since the OPS1 polish, suspend and the send cap live on the workspace's own console page (the Overview lists only
 * what needs attention). The workspace, the overview and the operator (OPS1: /api/console/me) are mocked so no
 * platform admin account is needed.
 */
const overview = {
  attention: [],
  totals: { users: 1204, workspaces: 12, domains: 9, mailboxes: 23, deliveries24h: 310 },
  newest: [{ id: "org_e2e", name: "Harbour Studio", plan: "pro", isDemo: false, createdAt: new Date().toISOString(), suspendedAt: null, pastDueSince: null, ownerUserId: "usr_owner", ownerEmail: "owner@harbour.test" }],
};

const limits = { domains: 5, mailboxes: 10, aliases: 20, storagePerMailboxMb: 1000, storageMb: 10000, dailySends: 500, seats: 10, agentInboxes: 2, agentMessagesMonthly: 1000, agentDailySends: 50, automationRunsMonthly: 100, agentMembers: 2 };
const workspace = {
  org: {
    id: "org_e2e", name: "Harbour Studio", slug: "harbour", plan: "pro", effectivePlan: "pro", compPlan: false, isDemo: false,
    timezone: "Australia/Sydney", country: "AU", createdAt: new Date().toISOString(), stripeCustomerId: null, stripeSubscriptionId: null,
    subscriptionStatus: null, billingInterval: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, pastDueSince: null, graceEndsAt: null,
    requireSso: false, suspendedAt: null, suspendedReason: null, sendCapDaily: null, meetingMinutesCap: null, channelsEnabled: true, legacyStorageMb: null,
  },
  limits, addons: {},
  usage: { domains: 2, mailboxes: 4, agentInboxes: 1, aliases: 0, seats: 4, storageMb: 10, agentMessages: 0 },
  counts: { members: 4, agentMembers: 1, pendingInvites: 0, agents: 1, apiKeys: 0, webhookEndpoints: 0, webhookEndpointsDisabled: 0, activeOauthGrants: 0, sendsToday: 12, meetingMinutesThisMonth: 0 },
  writeBudget: { used: 10, budget: 5000, level: "ok", resetAt: new Date(Date.now() + 3600_000).toISOString() },
};

async function signUp(page: import("@playwright/test").Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-uiadm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

test("operator console: stat tiles, then suspend and send cap in themed dialogs on the workspace page", async ({ page }) => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  await page.route("**/api/console/overview", (r) => r.fulfill({ json: overview })); // OPS1: the console's Overview
  await mockConsoleMe(page, "admin");
  await page.route((u) => u.pathname.startsWith("/api/console/workspaces/org_e2e"), async (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "GET") return path === "/api/console/workspaces/org_e2e" ? r.fulfill({ json: workspace }) : r.fulfill({ status: 404, json: { error: { code: "not_found", message: "Not found." } } });
    calls.push({ method: req.method(), url: path, body: req.postDataJSON() });
    return r.fulfill({ json: { ok: true } });
  });
  let nativeDialog = false;
  page.on("dialog", (d) => { nativeDialog = true; void d.dismiss(); });
  await signUp(page, "Olive Operator");
  await page.goto("/console"); // OPS1: was /app/admin
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("1,204", { exact: true })).toBeVisible(); // grouped digits on the Users tile
  await expect(page.getByTestId("console-attention-clear")).toContainText("All clear");

  // The newest workspace opens its console page, where the controls are.
  await page.getByTestId("console-overview-newest").getByRole("link", { name: "Harbour Studio" }).click();
  await expect(page).toHaveURL(/\/console\/workspaces\/org_e2e$/);
  await expect(page.getByRole("heading", { name: "Harbour Studio", level: 1 })).toBeVisible({ timeout: 15_000 });

  // Suspend: an empty reason is refused inside the dialog, then a real reason is sent.
  await page.getByTestId("console-workspaces-suspend").click();
  const suspend = page.getByRole("dialog", { name: "Suspend Harbour Studio?" });
  await expect(suspend).toBeVisible();
  await suspend.getByRole("button", { name: "Suspend workspace" }).click();
  await expect(suspend.getByRole("alert")).toHaveText("Give a short reason (at least 3 characters).");
  await suspend.getByLabel("Reason").fill("Unusual sending volume");
  await suspend.getByRole("button", { name: "Suspend workspace" }).click();
  await expect(suspend).toBeHidden();
  await expect.poll(() => calls.find((c) => c.url.endsWith("/suspend"))?.body).toEqual({ reason: "Unusual sending volume" });

  // Send cap: a negative number can't be saved, a whole number is sent with the reason.
  await page.getByTestId("console-workspaces-send-cap").click();
  const cap = page.getByRole("dialog", { name: "Change the daily send cap for Harbour Studio?" });
  await expect(cap).toBeVisible();
  await cap.getByTestId("console-workspaces-send-cap-input").fill("-5");
  await expect(cap.getByRole("button", { name: "Save send cap" })).toBeDisabled();
  await cap.getByTestId("console-workspaces-send-cap-input").fill("250");
  await cap.getByLabel("Reason").fill("Ramp up slowly");
  await cap.getByRole("button", { name: "Save send cap" }).click();
  await expect(cap).toBeHidden();
  await expect.poll(() => calls.find((c) => c.url.endsWith("/send-cap"))).toEqual({ method: "PUT", url: "/api/console/workspaces/org_e2e/send-cap", body: { cap: 250, reason: "Ramp up slowly" } });
  expect(nativeDialog).toBe(false);
});

test("team: revoking a pending invitation takes two taps and shows Revoke? in between", async ({ page }) => {
  await signUp(page, "Tara Team");
  const headers = { origin: new URL(page.url()).origin };
  const r = await page.request.post("/api/team/invites", { data: { email: `revoke-${Date.now()}@example.com`, role: "member", mailboxIds: [] }, headers });
  expect(r.status()).toBe(201);
  await page.goto("/app/settings/team");
  const revoke = page.getByRole("button", { name: /^Revoke invitation for revoke-/ });
  await expect(revoke).toBeVisible({ timeout: 15_000 });
  await revoke.click();
  await expect(revoke).toHaveText("Revoke?");
  await expect(page.getByText(/^revoke-.*@example\.com/)).toBeVisible(); // still there after one tap
  await revoke.click();
  await expect(page.getByText("No pending invitations")).toBeVisible();
});

test("invite page: workspace mark, role and expiry in one summary", async ({ page, browser }) => {
  await signUp(page, "Ines Inviter");
  const headers = { origin: new URL(page.url()).origin };
  const email = `join-${Date.now()}@example.com`;
  const inv = await (await page.request.post("/api/team/invites", { data: { email, role: "admin", mailboxIds: [] }, headers })).json();
  const token = JSON.stringify(inv).match(/invite\/([A-Za-z0-9_-]+)/)?.[1];
  expect(token).toBeTruthy();
  const anon = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const p = await anon.newPage();
  await p.goto(`/invite/${token}`);
  await expect(p.getByRole("heading", { level: 1 })).toContainText("Join ");
  await expect(p.getByText("Ines Inviter invited you to work together in Multies.")).toBeVisible();
  await expect(p.getByText("Admin", { exact: true })).toBeVisible();
  await expect(p.getByText("Link works until")).toBeVisible();
  await expect(p.getByRole("link", { name: "Create your account" })).toBeVisible();
  await anon.close();
});

test("guest: project header shows the key and an empty state; a dead link explains itself", async ({ page, browser }) => {
  await signUp(page, "Gus Guesthost");
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  const project = (await (await page.request.post("/api/projects", { data: { name: "Harbour fit out", key: "HFO" }, headers })).json()).project as { id: string };
  const gi = await (await page.request.post("/api/guests", { data: { projectId: project.id, email: `maria-${Date.now()}@example.com`, name: "Maria" }, headers })).json();
  const g = await browser.newContext({ baseURL: origin });
  const gp = await g.newPage();
  await gp.goto(new URL(gi.inviteUrl).pathname);
  await expect(gp).toHaveURL(/\/guest$/, { timeout: 15_000 });
  await expect(gp.getByTestId("guest-project")).toHaveText("Harbour fit out");
  await expect(gp.getByText("HFO", { exact: true })).toBeVisible();
  await expect(gp.getByText("No tasks yet")).toBeVisible();
  await gp.goto("/g/not-a-real-token");
  await expect(gp.getByRole("heading", { name: "This invite link doesn't work" })).toBeVisible();
  await expect(gp.getByRole("link", { name: "Go to Multies" })).toBeVisible();
  await g.close();
});

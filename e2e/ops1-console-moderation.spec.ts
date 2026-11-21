import { test, expect, type Page } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * OPS1: /console/moderation. Reports open first with an age badge; the status filter lives in the address; Dismiss asks
 * for a reason and sends it; the Abuse signals tab shows the per workspace summary with Suspend workspace; the lockouts
 * tab lists locked accounts. A read only operator sees the same lists without the buttons. The console API is mocked.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-mod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const report = {
  id: "rpt_e2e_1", status: "open", action: "none", targetType: "message", context: "chat", reason: "harassment", note: "Third time this week",
  orgId: "org_e2e", workspaceName: "Harbour Studio", messageId: "msg_1", snapshotText: "You are all useless, quit now",
  reporter: { id: "usr_rep", name: "Olive Owner", email: "olive@harbour.test" },
  target: { id: "usr_sam", name: "Sam Lee", email: "sam@harbour.test", suspended: false },
  createdAt: hoursAgo(30), ageHours: 30, resolvedAt: null, resolutionNote: null,
};

const summary = [{ orgId: "org_spam", workspaceName: "Spammy Ltd", openEvents: 4, topScore: 12, lastEventAt: hoursAgo(1), suspended: false }];
const events = [{ id: "abe_1", orgId: "org_spam", workspaceName: "Spammy Ltd", kind: "outbound_flagged", score: 12, detail: "Mismatched links (+4)", createdAt: hoursAgo(1), resolvedAt: null }];
const lockouts = [{ email: "locked@harbour.test", userId: "usr_locked", failures: 10, windowStart: hoursAgo(0.2), lockedUntil: new Date(Date.now() + 9 * 60_000).toISOString(), locked: true, unlocksInMs: 9 * 60_000 }];

async function mockModeration(page: Page) {
  const calls: { url: string; body: unknown }[] = [];
  const reportQueries: string[] = [];
  await page.route("**/api/console/moderation/reports?*", (r) => { reportQueries.push(r.request().url()); return r.fulfill({ json: { items: [report], nextCursor: null } }); });
  await page.route("**/api/console/moderation/reports/counts", (r) => r.fulfill({ json: { open: 1, olderThan12h: 1, olderThan24h: 1, oldestAt: report.createdAt } }));
  await page.route("**/api/console/moderation/abuse?*", (r) => r.fulfill({ json: { items: events, nextCursor: null } }));
  await page.route("**/api/console/moderation/abuse/summary", (r) => r.fulfill({ json: { items: summary } }));
  await page.route("**/api/console/moderation/suspended?*", (r) => r.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route("**/api/console/system/lockouts?*", (r) => r.fulfill({ json: { items: lockouts, nextCursor: null } }));
  const record = async (r: import("@playwright/test").Route) => { calls.push({ url: r.request().url(), body: r.request().postDataJSON() }); await r.fulfill({ json: { ok: true } }); };
  await page.route("**/api/console/moderation/reports/*/action", record);
  await page.route("**/api/console/moderation/workspaces/*/suspend", record);
  await page.route("**/api/console/system/lockouts/clear", record);
  return { calls, reportQueries };
}

test("an operator filters reports, dismisses one with a reason, and suspends a workspace from its abuse signals", async ({ page }) => {
  await mockConsoleMe(page, "ops_support");
  const { calls, reportQueries } = await mockModeration(page);
  await signUp(page, "Olive Operator");
  await page.goto("/console/moderation");
  await expect(page.getByRole("heading", { name: "Moderation", level: 1 })).toBeVisible({ timeout: 15_000 });
  const card = page.getByTestId("moderation-report").filter({ hasText: "You are all useless" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Harassment or bullying");
  await expect(card).toContainText("30 h");
  await expect(page.getByTestId("console-moderation-late")).toBeVisible();
  expect(reportQueries[0]).toContain("status=open");
  // Resolve and Dismiss come first together; the danger actions sit apart after them.
  const actions = card.getByTestId("report-actions");
  await expect(actions.getByRole("button").nth(0)).toHaveText("Resolve");
  await expect(actions.getByRole("button").nth(1)).toHaveText("Dismiss");
  await expect(card.getByTestId("report-danger-actions").getByRole("button")).toHaveText(["Remove message", "Suspend user"]);
  await expect(card.getByRole("link", { name: "Sam Lee" })).toHaveAttribute("href", "/console/users/usr_sam");
  await expect(card.getByRole("link", { name: "Harbour Studio" })).toHaveAttribute("href", "/console/workspaces/org_e2e");

  // The status filter goes into the address and the request.
  await page.getByRole("combobox", { name: "Status" }).selectOption("all");
  await expect(page).toHaveURL(/status=all/);
  await expect.poll(() => reportQueries.some((u) => u.includes("status=all"))).toBe(true);

  // Dismiss asks for a reason and sends it.
  await card.getByTestId("report-dismiss").click();
  const dialog = page.getByRole("dialog", { name: "Dismiss this report?" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill("Reviewed, banter between friends");
  await dialog.getByRole("button", { name: "Dismiss report" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => calls.find((c) => c.url.includes("/reports/rpt_e2e_1/action"))?.body).toEqual({ action: "dismiss", reason: "Reviewed, banter between friends" });

  // Abuse signals: the summary first, Suspend workspace asks for a reason.
  await page.getByTestId("console-moderation-tab-abuse").click();
  await expect(page).toHaveURL(/tab=abuse/);
  await expect(page.getByTestId("console-abuse-summary")).toContainText("Spammy Ltd");
  await expect(page.getByText("Outbound flagged")).toBeVisible();
  await page.getByTestId("console-abuse-suspend").click();
  const suspend = page.getByRole("dialog", { name: "Suspend Spammy Ltd?" });
  await suspend.getByLabel("Reason").fill("Phishing links in outbound mail");
  await suspend.getByRole("button", { name: "Suspend workspace" }).click();
  await expect(suspend).toBeHidden();
  await expect.poll(() => calls.find((c) => c.url.includes("/workspaces/org_spam/suspend"))?.body).toEqual({ reason: "Phishing links in outbound mail" });

  // Suspended workspaces: an empty list says so; lockouts list locked accounts with Clear.
  await page.getByTestId("console-moderation-tab-suspended").click();
  await expect(page.getByText("No suspended workspaces")).toBeVisible();
  await page.getByTestId("console-moderation-tab-lockouts").click();
  await expect(page).toHaveURL(/tab=lockouts/);
  await expect(page.getByRole("link", { name: "locked@harbour.test" })).toBeVisible();
  await page.getByTestId("console-lockout-clear").click();
  const clear = page.getByRole("dialog", { name: "Clear the lockout for locked@harbour.test?" });
  await clear.getByLabel("Reason").fill("Customer called and proved who they are");
  await clear.getByRole("button", { name: "Clear lockout" }).click();
  await expect.poll(() => calls.find((c) => c.url.endsWith("/lockouts/clear"))?.body).toEqual({ email: "locked@harbour.test", reason: "Customer called and proved who they are" });
});

test("a read only operator sees the queue and signals without action buttons", async ({ page }) => {
  await mockConsoleMe(page, "ops_readonly");
  await mockModeration(page);
  await signUp(page, "Rory Readonly");
  await page.goto("/console/moderation");
  const card = page.getByTestId("moderation-report").filter({ hasText: "You are all useless" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId("report-dismiss")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Suspend user" })).toHaveCount(0);
  await page.getByTestId("console-moderation-tab-abuse").click();
  await expect(page.getByTestId("console-abuse-summary")).toContainText("Spammy Ltd");
  await expect(page.getByTestId("console-abuse-suspend")).toHaveCount(0);
  await expect(page.getByTestId("console-abuse-dismiss")).toHaveCount(0);
  await page.getByTestId("console-moderation-tab-lockouts").click();
  await expect(page.getByRole("link", { name: "locked@harbour.test" })).toBeVisible();
  await expect(page.getByTestId("console-lockout-clear")).toHaveCount(0);
});

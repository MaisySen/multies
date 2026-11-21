import { test, expect, type Page, type Route } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";
import type { OperatorRole } from "../src/shared/operator-permissions";

/**
 * OPS1: Jobs and maintenance at /console/jobs. The queue numbers, the per type breakdown and the job list (opening on
 * jobs that failed for good), a status filter in the address bar, replay one / selected / all through the reason
 * dialog, the Data moves tab, and a read only role that sees no actions. /api/console/* is mocked; the server's rules
 * are covered by tests/console-jobs-routes.test.ts and tests/console-rbac.test.ts.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-jobs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const now = Date.now();
const iso = (agoMs: number) => new Date(now - agoMs).toISOString();

const stats = {
  byStatus: { pending: 2, running: 1, done: 40, dead: 3 },
  byStatusAndType: [
    { status: "dead", type: "mail.deliver", count: 3, oldestRunAt: iso(86_400_000), newestUpdatedAt: iso(3_600_000) },
    { status: "pending", type: "webhook.deliver", count: 2, oldestRunAt: iso(20 * 60_000), newestUpdatedAt: iso(60_000) },
    { status: "running", type: "webhook.deliver", count: 1, oldestRunAt: iso(60_000), newestUpdatedAt: iso(60_000) },
    { status: "done", type: "mail.deliver", count: 40, oldestRunAt: iso(86_400_000), newestUpdatedAt: iso(60_000) },
  ],
  oldestPendingAgeMs: 20 * 60_000,
  at: new Date(now).toISOString(),
};

const job = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id, type: "mail.deliver", status, orgId: "org_e2e", workspaceName: "Harbour Studio", attempts: 8, maxAttempts: 8,
  runAt: iso(86_400_000), lockedUntil: null, createdAt: iso(2 * 86_400_000), updatedAt: iso(3_600_000),
  lastError: "Remote server said 550 mailbox unavailable", payloadPreview: "{\"messageId\":\"msg_e2e1\",\"body\":\"<string 120>\"}", ...over,
});

const moves = [{
  id: "dm_e2e", orgId: "org_e2e", workspaceName: "Harbour Studio", kind: "import", source: "csv", status: "failed", total: 10, done: 4,
  error: "Row 5 has no email", createdByUserId: null, createdAt: iso(7_200_000), updatedAt: iso(3_600_000), finishedAt: null, lastStepAt: iso(3_600_000), expiresAt: null,
}];

interface Call { method: string; path: string; search: string; body: unknown }

async function mockJobs(page: Page, role: OperatorRole) {
  const calls: Call[] = [];
  await mockConsoleMe(page, role);
  await page.route((url) => url.pathname.startsWith("/api/console/jobs"), async (r: Route) => {
    const req = r.request();
    const url = new URL(req.url());
    calls.push({ method: req.method(), path: url.pathname, search: url.search, body: req.method() === "POST" ? req.postDataJSON() : null });
    if (req.method() === "POST") {
      if (url.pathname.endsWith("/mark-dead")) return r.fulfill({ json: { id: "job_wait", previousStatus: "pending", status: "dead" } });
      return r.fulfill({ json: { requested: 1, replayed: 1 } });
    }
    if (url.pathname === "/api/console/jobs/stats") return r.fulfill({ json: stats });
    if (url.pathname === "/api/console/jobs/data-moves") return r.fulfill({ json: { items: moves, nextCursor: null } });
    const status = url.searchParams.get("status") ?? "dead";
    const items = status === "pending" ? [job("job_wait", "pending", { attempts: 1, type: "webhook.deliver", orgId: null, workspaceName: null, lastError: null })] : status === "dead" ? [job("job_1", "dead"), job("job_2", "dead")] : [];
    return r.fulfill({ json: { items, nextCursor: null } });
  });
  return calls;
}

test("an operator sees the queue, filters by status and replays through the reason dialog", async ({ page }) => {
  const calls = await mockJobs(page, "admin");
  await signUp(page, "Olive Operator");
  await page.goto("/console/jobs");
  await expect(page.getByRole("heading", { name: "Jobs", level: 1 })).toBeVisible({ timeout: 15_000 });

  // Numbers: plain words, and the oldest waiting job is flagged once it is old.
  const tiles = page.getByTestId("console-jobs-stats");
  await expect(tiles).toContainText("Waiting");
  await expect(tiles).toContainText("Failed for good");
  await expect(tiles).toContainText("Done recently");
  await expect(page.getByTestId("console-jobs-oldest")).toHaveText("Oldest waiting 20 min");
  await expect(page.getByTestId("console-jobs-oldest")).toHaveClass(/text-warn/);
  await expect(page.getByTestId("console-jobs-by-type")).toContainText("webhook.deliver");

  // The list opens on jobs that failed for good, with the workspace linked and the payload as structure only.
  await expect(page.getByRole("link", { name: "Harbour Studio" }).first()).toHaveAttribute("href", "/console/workspaces/org_e2e");
  await expect(page.getByText("Remote server said 550 mailbox unavailable").first()).toBeVisible();
  await page.getByTestId("console-jobs-preview").first().locator("summary").click();
  await expect(page.getByTestId("console-jobs-preview").first().locator("pre")).toContainText("messageId");

  // Replay one.
  await page.getByTestId("console-jobs-replay").first().click();
  const one = page.getByRole("dialog", { name: "Replay this mail.deliver job?" });
  await expect(one).toBeVisible();
  await one.getByLabel("Reason").fill("Mail provider is back");
  await one.getByRole("button", { name: "Replay job" }).click();
  await expect(one).toBeHidden();
  await expect.poll(() => calls.find((c) => c.path === "/api/console/jobs/job_1/replay")?.body).toEqual({ reason: "Mail provider is back" });

  // Replay selected.
  await page.getByRole("checkbox", { name: "Select mail.deliver job job_2" }).check();
  await page.getByTestId("console-jobs-replay-selected").click();
  const sel = page.getByRole("dialog", { name: "Replay 1 selected job?" });
  await sel.getByLabel("Reason").fill("Retry after the fix");
  await sel.getByRole("button", { name: "Replay selected", exact: true }).click();
  await expect(sel).toBeHidden();
  await expect.poll(() => calls.find((c) => c.path === "/api/console/jobs/replay")?.body).toEqual({ ids: ["job_2"], reason: "Retry after the fix" });

  // Replay all says how many will be retried.
  await expect(page.getByTestId("console-jobs-replay-all")).toHaveText("Replay all failed jobs (3)");
  await page.getByTestId("console-jobs-replay-all").click();
  const all = page.getByRole("dialog", { name: "Replay all failed jobs?" });
  await expect(all).toContainText("3 jobs that failed for good will be retried");
  await all.getByLabel("Reason").fill("Outage is over");
  await all.getByRole("button", { name: "Replay all", exact: true }).click();
  await expect(all).toBeHidden();
  await expect.poll(() => calls.find((c) => c.path === "/api/console/jobs/replay-all")?.body).toEqual({ reason: "Outage is over" });

  // A status filter goes in the address bar and reloads the list.
  await page.getByRole("combobox", { name: "Status" }).selectOption("pending");
  await expect(page).toHaveURL(/status=pending/);
  await expect.poll(() => calls.some((c) => c.method === "GET" && c.path === "/api/console/jobs" && c.search.includes("status=pending"))).toBe(true);
  await expect(page.getByText("No workspace", { exact: true })).toBeVisible();
  await page.getByTestId("console-jobs-mark-dead").click();
  const stop = page.getByRole("dialog", { name: "Stop this webhook.deliver job?" });
  await stop.getByLabel("Reason").fill("Stuck on a dead endpoint");
  await stop.getByRole("button", { name: "Mark failed for good" }).click();
  await expect(stop).toBeHidden();
  await expect.poll(() => calls.find((c) => c.path === "/api/console/jobs/job_wait/mark-dead")?.body).toEqual({ reason: "Stuck on a dead endpoint" });

  // Data moves tab.
  await page.getByTestId("console-jobs-tab-moves").click();
  await expect(page).toHaveURL(/tab=moves/);
  await expect(page.getByText("Import", { exact: true })).toBeVisible();
  await expect(page.getByText("4 of 10 (40%)")).toBeVisible();
  await expect(page.getByText("Row 5 has no email")).toBeVisible();
});

test("a read only operator sees the queue but no actions", async ({ page }) => {
  await mockJobs(page, "ops_readonly");
  await signUp(page, "Rory Readonly");
  await page.goto("/console/jobs");
  await expect(page.getByRole("heading", { name: "Jobs", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Remote server said 550 mailbox unavailable").first()).toBeVisible();
  await expect(page.getByTestId("console-jobs-replay-all")).toHaveCount(0);
  await expect(page.getByTestId("console-jobs-replay-selected")).toHaveCount(0);
  await expect(page.getByTestId("console-jobs-replay")).toHaveCount(0);
  await expect(page.getByTestId("console-jobs-select")).toHaveCount(0);
});

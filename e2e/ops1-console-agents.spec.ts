import { test, expect, type Page, type Route } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * OPS1: Agents and AI in the operator console (/console/agents). The operator and every /api/console/agents call are
 * mocked; the server's own rules are covered by tests/console-agents-routes.test.ts. Checks: the runs tab opens on
 * runs needing attention, a filter lands in the address, Cancel asks for a reason and sends it, the tabs switch, and
 * a read only operator sees no buttons.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-agents-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

const runs = [
  {
    id: "run_failed", orgId: "org_alpha", workspaceName: "Alpha Works", taskId: "tsk_1", agentUserId: "usr_bot", agentName: "Alpha Bot",
    status: "failed", triggerId: null, createdByUserId: null, stepCount: 4, startedAt: iso(3_600_000), finishedAt: iso(3_000_000),
    createdAt: iso(3_600_000), updatedAt: iso(3_000_000), durationMs: 600_000, longRunning: false,
  },
  {
    id: "run_long", orgId: "org_beta", workspaceName: "Beta Labs", taskId: "tsk_2", agentUserId: "usr_bot2", agentName: "Beta Helper",
    status: "running", triggerId: null, createdByUserId: null, stepCount: 12, startedAt: iso(7_200_000), finishedAt: null,
    createdAt: iso(7_200_000), updatedAt: iso(60_000), durationMs: 7_200_000, longRunning: true,
  },
];

const triggers = [
  {
    id: "trg_on", orgId: "org_alpha", workspaceName: "Alpha Works", name: "Hourly sweep", kind: "schedule", enabled: true,
    agentUserId: "usr_bot", agentName: "Alpha Bot", nextRunAt: new Date(Date.now() + 3_600_000).toISOString(), lastFiredAt: iso(600_000), fireCount: 41,
    createdAt: iso(86_400_000), updatedAt: iso(600_000),
  },
];

interface Seen { runs: string[]; triggers: string[]; posts: { url: string; body: unknown }[] }

async function mockAgents(page: Page): Promise<Seen> {
  const seen: Seen = { runs: [], triggers: [], posts: [] };
  const json = (r: Route, body: unknown) => r.fulfill({ json: body });
  await page.route(/\/api\/console\/agents\/runs(\?.*)?$/, (r) => { seen.runs.push(r.request().url()); return json(r, { items: runs, nextCursor: null }); });
  await page.route(/\/api\/console\/agents\/triggers(\?.*)?$/, (r) => { seen.triggers.push(r.request().url()); return json(r, { items: triggers, nextCursor: null }); });
  await page.route(/\/api\/console\/agents\/approvals(\?.*)?$/, (r) => json(r, { items: [], nextCursor: null }));
  await page.route(/\/api\/console\/agents\/ai-usage(\?.*)?$/, (r) => json(r, {
    items: [{ orgId: "org_alpha", workspaceName: "Alpha Works", units: 1200, calls: 80, days: 5 }], nextCursor: null,
    window: { from: "2026-11-15", to: "2026-11-21" }, account: { units: 1500, calls: 95 },
  }));
  await page.route(/\/api\/console\/agents\/ai-key-problems(\?.*)?$/, (r) => json(r, { items: [], nextCursor: null }));
  await page.route(/\/api\/console\/agents\/(runs|triggers)\/[^/]+\/(cancel|pause|resume)$/, (r) => {
    seen.posts.push({ url: r.request().url(), body: r.request().postDataJSON() });
    return json(r, { ok: true });
  });
  return seen;
}

test("runs needing attention: filter in the address, Cancel asks for a reason and sends it", async ({ page }) => {
  await mockConsoleMe(page, "admin");
  const seen = await mockAgents(page);
  await signUp(page, "Olive Operator");
  await page.goto("/console/agents");

  await expect(page.getByRole("heading", { name: "Agents and AI", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-agents-tab-runs")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Alpha Works")).toBeVisible();
  await expect(page.getByText("Running a long time")).toBeVisible();
  expect(seen.runs.at(-1)).toContain("status=attention");

  await page.getByRole("combobox", { name: "Status" }).selectOption("failed");
  await expect(page).toHaveURL(/status=failed/);
  await expect.poll(() => seen.runs.at(-1)).toContain("status=failed");

  // Only the running run can be cancelled.
  const cancel = page.getByTestId("console-agents-run-cancel");
  await expect(cancel).toHaveCount(1);
  await cancel.click();
  const dialog = page.getByTestId("reason-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByText("Cancel this run of Beta Helper?")).toBeVisible();
  await dialog.getByLabel("Reason").fill("Stuck for two hours");
  await dialog.getByRole("button", { name: "Cancel run" }).click();
  await expect.poll(() => seen.posts.length).toBe(1);
  expect(seen.posts[0].url).toContain("/api/console/agents/runs/run_long/cancel");
  expect(seen.posts[0].body).toEqual({ reason: "Stuck for two hours" });
  await expect(page.getByText("Run cancelled")).toBeVisible();
});

test("tabs switch through the address, and AI usage shows the account totals", async ({ page }) => {
  await mockConsoleMe(page, "admin");
  const seen = await mockAgents(page);
  await signUp(page, "Olive Operator");
  await page.goto("/console/agents");
  await expect(page.getByRole("heading", { name: "Agents and AI", level: 1 })).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("console-agents-tab-triggers").click();
  await expect(page).toHaveURL(/tab=triggers/);
  await expect(page.getByText("Hourly sweep")).toBeVisible();
  await page.getByRole("combobox", { name: "State" }).selectOption("false");
  await expect(page).toHaveURL(/enabled=false/);
  await expect.poll(() => seen.triggers.at(-1)).toContain("enabled=false");

  await page.getByTestId("console-agents-trigger-pause").click();
  const dialog = page.getByTestId("reason-dialog");
  await dialog.getByLabel("Reason").fill("Runaway schedule");
  await dialog.getByRole("button", { name: "Pause trigger" }).click();
  await expect.poll(() => seen.posts.length).toBe(1);
  expect(seen.posts[0].url).toContain("/api/console/agents/triggers/trg_on/pause");
  expect(seen.posts[0].body).toEqual({ reason: "Runaway schedule" });

  await page.getByTestId("console-agents-tab-approvals").click();
  await expect(page).toHaveURL(/tab=approvals/);
  await expect(page.getByText("Nothing is waiting")).toBeVisible();

  await page.getByTestId("console-agents-tab-usage").click();
  await expect(page.getByTestId("console-agents-usage-units")).toContainText("1.5K");
  await expect(page.getByTestId("console-agents-usage-calls")).toContainText("95");
  await expect(page.getByText("Alpha Works")).toBeVisible();

  await page.getByTestId("console-agents-tab-keys").click();
  await expect(page.getByText("No AI key problems")).toBeVisible();
});

test("a read only operator sees the lists but no Cancel or Pause", async ({ page }) => {
  await mockConsoleMe(page, "ops_readonly");
  await mockAgents(page);
  await signUp(page, "Rory Readonly");
  await page.goto("/console/agents");
  await expect(page.getByText("Running a long time")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-agents-run-cancel")).toHaveCount(0);
  await page.getByTestId("console-agents-tab-triggers").click();
  await expect(page.getByText("Hourly sweep")).toBeVisible();
  await expect(page.getByTestId("console-agents-trigger-pause")).toHaveCount(0);
});

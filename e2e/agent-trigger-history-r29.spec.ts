import { mkdirSync } from "node:fs";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R29: an admin edits an agent's trigger from the Triggers dialog (the Add form, filled in), fires it with Run now,
 * and opens its History: the fire, and a refused unsigned webhook call, newest first.
 */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1280, height: 900 } });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.95.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

test("admin edits a trigger, runs it and sees its history", async () => {
  const made = await page.request.post("/api/team/agents", { data: { name: "Nightwatch" } });
  expect(made.status()).toBe(201);
  const agentUserId = (await made.json()).member.userId as string;
  const projectId = (await (await page.request.get("/api/projects")).json()).projects[0].id as string;
  const sched = await page.request.post("/api/agent-triggers", { data: { agentUserId, kind: "schedule", name: "Morning check", projectId, dailyAt: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] } });
  expect(sched.status()).toBe(201);
  const hook = await page.request.post("/api/agent-triggers", { data: { agentUserId, kind: "webhook", name: "Alerts", projectId } });
  const hookId = (await hook.json()).trigger.id as string;

  await page.goto("/app/settings/team");
  await page.getByRole("button", { name: "Actions for Nightwatch" }).click();
  await page.getByRole("menuitem", { name: "Triggers" }).click();
  const dialog = page.getByRole("dialog", { name: "Triggers for Nightwatch" });
  const row = dialog.getByTestId("agent-trigger").filter({ hasText: "Morning check" });
  await expect(row).toContainText("Daily at 09:00, weekdays");

  // Edit: the form opens with the trigger's values; change the name, time, days and zone.
  await row.getByRole("button", { name: "Edit Morning check" }).click();
  const form = dialog.getByRole("form", { name: "Edit Morning check" });
  await expect(form.getByLabel("Name")).toHaveValue("Morning check");
  await expect(form.getByLabel("Starts")).toBeDisabled();
  await form.getByLabel("Name").fill("Weekend check");
  await form.getByLabel("Time", { exact: true }).fill("10:30");
  for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) await form.getByRole("button", { name: d, exact: true }).click();
  await expect(form.getByRole("button", { name: "Sat", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(form.getByRole("button", { name: "Mon", exact: true })).toHaveAttribute("aria-pressed", "false");
  await form.getByLabel("Time zone").fill("Australia/Sydney");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toBeHidden();
  const edited = dialog.getByTestId("agent-trigger").filter({ hasText: "Weekend check" });
  await expect(edited).toContainText("Daily at 10:30, Sat, Sun");

  // Run now, then History shows the fire with a link to the run's task.
  await edited.getByRole("button", { name: "Run Weekend check now" }).click();
  await expect(edited.getByTestId("trigger-times")).toContainText("Last fired");
  await edited.getByRole("button", { name: "History of Weekend check" }).click();
  const history = edited.getByTestId("trigger-history-" + (await (await page.request.get(`/api/agent-triggers?agentUserId=${agentUserId}`)).json()).triggers.find((t: { name: string }) => t.name === "Weekend check").id);
  await expect(history.getByTestId("trigger-history-entry")).toHaveCount(1);
  await expect(history.getByTestId("trigger-history-entry").first()).toHaveAttribute("data-outcome", "fired");
  await expect(history).toContainText("Fired, queued a run on");
  await expect(history).toContainText("Run now");
  await expect(history.getByRole("link", { name: "Open run" })).toBeVisible();

  // An unsigned call to the webhook is refused and shows in that trigger's History.
  expect((await page.request.post(`/api/hooks/agent-runs/${hookId}`, { data: "{}", headers: { "content-type": "application/json" } })).status()).toBe(401);
  const alerts = dialog.getByTestId("agent-trigger").filter({ hasText: "Alerts" });
  await alerts.getByRole("button", { name: "History of Alerts" }).click();
  const alertsHistory = alerts.getByTestId(`trigger-history-${hookId}`);
  await expect(alertsHistory.getByTestId("trigger-history-entry").first()).toHaveAttribute("data-outcome", "refused");
  await expect(alertsHistory).toContainText("Refused: the request was not signed");
  await expect(alertsHistory).toContainText("Webhook");

  mkdirSync(`${SHOTS_ROOT}/multies-r29`, { recursive: true });
  await dialog.screenshot({ path: `${SHOTS_ROOT}/multies-r29/agent-trigger-history.png` });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
});

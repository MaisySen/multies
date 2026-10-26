import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * R28 (DF-3 slice 3): an admin opens an agent's Triggers from People, adds a weekday morning schedule and a webhook
 * trigger, copies the secret shown once, and a signed POST queues a run the agent's own key can pick up.
 */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1280, height: 900 } });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.94.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

test("admin adds schedule and webhook triggers for an agent; a signed webhook queues a run", async () => {
  const made = await page.request.post("/api/team/agents", { data: { name: "Dispatcher", title: "Runs the morning triage", bio: "Reads new mail and files tasks." } });
  expect(made.status()).toBe(201);
  const agentKey = (await made.json()).secret as string;

  await page.goto("/app/settings/team");
  await page.getByRole("button", { name: "Actions for Dispatcher" }).click();
  await page.getByRole("menuitem", { name: "Triggers" }).click();
  const dialog = page.getByRole("dialog", { name: "Triggers for Dispatcher" });
  await expect(dialog.getByText("No triggers yet")).toBeVisible();

  // A weekday morning schedule that makes a new task each time.
  await dialog.getByRole("button", { name: "Add trigger" }).click();
  const form = dialog.getByRole("form", { name: "New trigger" });
  await form.getByLabel("Name").fill("Morning triage");
  await form.getByLabel("Instructions for the agent").fill("Read new support mail and file a task for each bug.");
  await form.getByRole("button", { name: "Save trigger" }).click();
  const morning = dialog.getByTestId("agent-trigger").filter({ hasText: "Morning triage" });
  await expect(morning).toContainText("Daily at 09:00, weekdays");
  await expect(morning.getByTestId("trigger-times")).toContainText("Next run");
  await expect(morning.getByTestId("trigger-times")).toContainText("Never fired");

  // A webhook trigger: the URL and the secret show once.
  await dialog.getByRole("button", { name: "Add trigger" }).click();
  await form.getByLabel("Name").fill("Deploy failed");
  await form.getByLabel("Starts").selectOption("webhook");
  await form.getByRole("button", { name: "Save trigger" }).click();
  const box = dialog.getByTestId("trigger-secret");
  await expect(box).toBeVisible();
  const codes = box.locator("code");
  const url = (await codes.nth(0).textContent())!.trim();
  const secret = (await codes.nth(1).textContent())!.trim();
  expect(url).toMatch(/\/api\/hooks\/agent-runs\/trg_/);
  expect(secret).toMatch(/^mtw_/);
  await expect(dialog.getByTestId("agent-trigger")).toHaveCount(2);
  mkdirSync("/home/user/tab/files/multies-r28", { recursive: true });
  await dialog.screenshot({ path: "/home/user/tab/files/multies-r28/agent-triggers.png" });

  // A signed POST queues a run; an unsigned one is refused.
  const path = new URL(url).pathname;
  const body = JSON.stringify({ service: "api", sha: "abc123" });
  expect((await page.request.post(path, { data: body, headers: { "content-type": "application/json" } })).status()).toBe(401);
  const ts = Math.floor(Date.now() / 1000);
  const sig = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
  const fired = await page.request.post(path, { data: body, headers: { "content-type": "application/json", "x-multies-timestamp": String(ts), "x-multies-signature": sig } });
  expect(fired.status()).toBe(202);
  const mine = await (await page.request.get("/api/v1/agents/me/runs?status=queued", { headers: { authorization: `Bearer ${agentKey}` } })).json();
  expect(mine.runs).toHaveLength(1);
  expect(mine.runs[0].input).toMatchObject({ source: "webhook", triggerName: "Deploy failed", payload: { service: "api" } });

  // Turn the morning trigger off: no next run.
  await morning.getByRole("switch", { name: "Morning triage on" }).click();
  await expect(morning.getByTestId("trigger-times")).toContainText("Off");
  await dialog.getByRole("button", { name: "Done" }).click();
});

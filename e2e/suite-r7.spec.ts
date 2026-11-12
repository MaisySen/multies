import { test, expect, type Page } from "@playwright/test";

/**
 * Round 7 end to end: a timer entry on a task, a public form submission that makes a task,
 * the reports dashboard, and starting a meeting (with video switched off, the config-off path).
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.78.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
  // The sample seed's second part (docs, deals, fields, forms) lands a moment after the tasks.
  await expect.poll(async () => {
  await page.request.post("/api/account/demo/seed", { headers: { origin: new URL(page.url()).origin } }).catch(() => null);
  return ((await (await page.request.get("/api/docs")).json().catch(() => ({}))).docs ?? []).length;
  }, { timeout: 30_000 }).toBeGreaterThan(0);
}

test("start and stop a timer on a task, and see it on the timesheet", async ({ page }) => {
  await demo(page);
  const tasks = (await (await page.request.get("/api/tasks?q=Point MX")).json()).tasks;
  await page.goto(`/app/tasks?view=list&task=${tasks[0].id}`);
  const panel = page.getByRole("dialog", { name: "Task" });
  await panel.getByTestId("timer-start").click();
  await expect(panel.getByTestId("timer-stop")).toBeVisible();
  await expect(page.getByTestId("timer-chip")).toBeVisible();
  await page.waitForTimeout(1500);
  await panel.getByTestId("timer-stop").click();
  await expect(panel.getByTestId("timer-start")).toBeVisible();
  const entries = (await (await page.request.get(`/api/time?taskId=${tasks[0].id}`)).json()).entries;
  expect(entries[0].running).toBe(false);
  expect(entries[0].seconds).toBeGreaterThanOrEqual(1);
  // Dependencies show on the same panel: the demo's MX task waits on the DNS check.
  await expect(panel.getByTestId("dependencies").getByText("Check SPF, DKIM and DMARC on blueharbor.co")).toBeVisible();
  await page.goto("/app/time");
  await expect(page.getByTestId("timesheet")).toBeVisible();
  await expect(page.getByTestId("timesheet").getByText("Blue Harbor move").first()).toBeVisible();
});

test("a public form submission makes a task", async ({ page, browser }) => {
  await demo(page);
  const forms = (await (await page.request.get("/api/forms")).json()).forms;
  const form = forms.find((f: { name: string }) => f.name === "Website enquiry");
  expect(form).toBeTruthy();
  const subject = `Quote for 6 mailboxes ${Date.now()}`;
  const outsider = await browser.newPage();
  await outsider.goto(new URL(form.url).pathname);
  const f = outsider.getByTestId("public-form");
  await f.getByLabel("Your name").fill("Grace Lee");
  await f.getByLabel("Email").fill("grace@harbourcoffee.com.au");
  await f.getByLabel("What do you need?").fill(subject);
  await f.getByLabel("Details (optional)").fill("We move in November.");
  await outsider.waitForTimeout(1600);
  await f.getByRole("button", { name: "Send" }).click();
  await expect(outsider.getByTestId("form-done")).toBeVisible();
  await expect.poll(async () => ((await (await page.request.get(`/api/tasks?q=${encodeURIComponent(subject)}`)).json()).tasks ?? []).length).toBe(1);
  // AIS1 (PR 24): the answer waits in Triage until a person accepts it, and search shows it with that state.
  const found = (await (await page.request.get(`/api/tasks?q=${encodeURIComponent(subject)}`)).json()).tasks;
  expect(found[0].triage).toMatchObject({ state: "pending", source: "form" });
  await page.goto("/app/forms");
  await expect(page.getByTestId("form-row").filter({ hasText: "Website enquiry" })).toContainText("1 answer");
});

test("the reports dashboard renders its charts", async ({ page }) => {
  await demo(page);
  await page.goto("/app/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByTestId("chart-status").locator(".recharts-bar-rectangle").first()).toBeVisible();
  await expect(page.getByTestId("chart-deals").locator(".recharts-bar-rectangle").first()).toBeVisible();
  await expect(page.getByText("Open tasks", { exact: true })).toBeVisible();
});

test("start a meeting from a task, with video switched off", async ({ page }) => {
  await demo(page);
  const tasks = (await (await page.request.get("/api/tasks?q=Confirm cutover")).json()).tasks;
  await page.goto(`/app/tasks?view=list&task=${tasks[0].id}`);
  const panel = page.getByRole("dialog", { name: "Task" });
  await panel.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Start a meeting" }).click();
  await expect(page).toHaveURL(/\/app\/meetings\/mtg_/);
  await expect(page.getByTestId("meeting-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Confirm cutover time with Maria" })).toBeVisible();
  await expect(page.getByTestId("meetings-off")).toBeVisible();
  await expect(page.getByTestId("join-meeting")).toBeDisabled();
  const guestUrl = await page.getByLabel("Guest link").inputValue();
  await page.goto(new URL(guestUrl).pathname);
  await expect(page.getByTestId("guest-meeting")).toContainText("Confirm cutover time with Maria");
});

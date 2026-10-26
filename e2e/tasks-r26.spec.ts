import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R26 end to end: a checklist inside a task (add with Enter, tick, see "1 of 3" and the card chip), and the task
 * query box (type a query with suggestions, see the filtered list, save it as a view and open it again).
 */
let visitor = 0;
const ip = () => `10.126.${test.info().workerIndex % 200}.${++visitor}`;
const SHOTS = "/home/user/tab/files/multies-r26";

test("checklist in the task panel and a task query saved as a view", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1360, height: 900 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Planner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const project = (await (await page.request.post("/api/projects", { data: { name: "Website relaunch", key: "WEB" }, headers })).json()).project as { id: string };
  const seed: [string, Record<string, unknown>][] = [
    ["Launch the new pricing page", { labels: ["launch"], priority: "high" }],
    ["Fix the checkout crash on Safari", { labels: ["bug"], priority: "urgent", type: "bug" }],
    ["Old IE layout glitch", { labels: ["bug", "wontfix"], priority: "low", type: "bug" }],
    ["Write the launch announcement", { labels: ["launch"] }],
    ["Refresh product screenshots", {}],
  ];
  for (const [title, extra] of seed) expect((await page.request.post("/api/tasks", { data: { title, projectId: project.id, ...extra }, headers })).status()).toBe(201);

  // Checklist: open the task, add three items with Enter, tick one.
  await page.goto(`/app/tasks?view=board&project=${project.id}`);
  await page.getByRole("button", { name: "Launch the new pricing page", exact: true }).click();
  const panel = page.getByRole("region", { name: "Checklist" });
  const add = panel.getByRole("textbox", { name: "New checklist item" });
  for (const item of ["Final copy from marketing", "Plan comparison table", "Stripe prices in AUD"]) {
    await add.fill(item);
    await add.press("Enter");
    await expect(panel.getByRole("button", { name: `Rename ${item}` })).toBeVisible();
  }
  await expect(add).toBeFocused();
  await panel.getByRole("checkbox", { name: "Tick Final copy from marketing" }).click();
  await expect(panel.getByTestId("checklist-progress")).toHaveText("1 of 3");
  // Rename inline.
  await panel.getByRole("button", { name: "Rename Plan comparison table" }).click();
  const edit = panel.getByRole("textbox", { name: "Item title" });
  await edit.fill("Plan comparison table with yearly prices");
  await edit.press("Enter");
  await expect(panel.getByRole("button", { name: "Rename Plan comparison table with yearly prices" })).toBeVisible();
  // Keyboard reorder: Alt+Up moves the last item to the middle.
  await panel.getByRole("checkbox", { name: "Tick Stripe prices in AUD" }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(panel.getByRole("listitem").nth(1)).toContainText("Stripe prices in AUD");
  mkdirSync(SHOTS, { recursive: true });
  await panel.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await panel.getByRole("listitem").nth(2).hover();
  await page.screenshot({ path: `${SHOTS}/work-checklist.png` });
  await page.keyboard.press("Escape");
  await page.goto(`/app/tasks?view=board&project=${project.id}`);
  await expect(page.getByLabel("Checklist 1 of 3")).toBeVisible();

  // Query box: suggestions, a bad query explained, then a real query.
  await page.goto(`/app/tasks?view=list&project=${project.id}`);
  const box = page.getByRole("combobox", { name: "Search tasks" });
  await box.click();
  await box.pressSequentially("lab");
  await expect(page.getByRole("option", { name: /label:/ })).toBeVisible();
  await box.press("Tab");
  await expect(box).toHaveValue("label:");
  await box.pressSequentially("bu");
  await expect(page.getByRole("option", { name: /^bug/ })).toBeVisible();
  await box.press("Tab");
  await box.pressSequentially("-label:wontfix colour:red");
  await expect(page.getByRole("alert")).toContainText('Unknown key "colour"');
  for (let i = 0; i < " colour:red".length; i++) await box.press("Backspace");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await box.press("Enter");
  await expect(page).toHaveURL(/q=label/);
  const rows = page.getByRole("table").getByRole("row");
  await expect(page.getByText("Fix the checkout crash on Safari")).toBeVisible();
  await expect(page.getByText("Old IE layout glitch")).toHaveCount(0);
  await expect(page.getByText("Launch the new pricing page")).toHaveCount(0);
  await expect(rows).toHaveCount(2); // header and one task
  // The screenshot shows the suggestions for a second key while the filtered list is on screen.
  await box.click();
  await box.press("End");
  await box.pressSequentially(" priority:");
  await expect(page.getByRole("option", { name: /^urgent/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/work-query.png` });
  for (let i = 0; i < " priority:".length; i++) await box.press("Backspace");

  // Save it as a view, clear, and open the view again.
  page.once("dialog", (d) => void d.accept("Open bugs"));
  await page.getByRole("button", { name: "Saved views" }).click();
  await page.getByRole("menuitem", { name: "Save this view" }).click();
  await expect.poll(async () => (await (await page.request.get("/api/tasks/views")).json()).views.map((v: { name: string; filters: Record<string, string> }) => `${v.name}|${v.filters.q}`)).toContain("Open bugs|label:bug -label:wontfix");
  await page.getByRole("button", { name: "Clear the query" }).click();
  await expect(page.getByText("Old IE layout glitch")).toBeVisible();
  await page.getByRole("button", { name: "Saved views" }).click();
  await page.getByRole("menuitem", { name: "Open bugs" }).click();
  await expect(box).toHaveValue("label:bug -label:wontfix");
  await expect(page.getByText("Old IE layout glitch")).toHaveCount(0);
  await expect(page.getByText("Fix the checkout crash on Safari")).toBeVisible();
  await ctx.close();
});

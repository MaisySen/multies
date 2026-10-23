import { test, expect, type Page } from "@playwright/test";

/**
 * Round 8 end to end: a custom field set on a task and used as a filter, a guest invited to a
 * project who sees only that project, and the portfolio table. Co-editing is in collab.spec.ts.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.88.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/);
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
  const projects = (await (await page.request.get("/api/projects")).json()).projects as { id: string; name: string }[];
  return projects.find((p) => p.name === "Blue Harbor move")!;
}

test("add a custom field, set it on a task and filter the list by it", async ({ page }) => {
  const project = await demo(page);
  await page.goto(`/app/tasks?project=${project.id}&view=list`);
  // The demo's fields show as columns.
  await expect(page.getByTestId("task-list").getByRole("columnheader", { name: "Budget" })).toBeVisible();
  await page.getByRole("button", { name: "Fields" }).click();
  const dialog = page.getByRole("dialog", { name: "Custom fields" });
  await dialog.getByLabel("New field name").fill("Region");
  await dialog.getByLabel("New field type").selectOption("select");
  await dialog.getByLabel("New field options").fill("NSW, VIC");
  await dialog.getByRole("button", { name: "Add field" }).click();
  await expect(dialog.getByLabel("Name of Region")).toBeVisible();
  await page.keyboard.press("Escape");

  const tasks = (await (await page.request.get(`/api/tasks?projectId=${project.id}`)).json()).tasks as { id: string; title: string }[];
  const target = tasks.find((t) => t.title.startsWith("Check SPF"))!;
  await page.goto(`/app/tasks?project=${project.id}&view=list&task=${target.id}`);
  const panel = page.getByRole("dialog", { name: "Task" });
  await panel.getByRole("combobox", { name: "Region" }).selectOption({ label: "VIC" });
  await expect.poll(async () => {
    const d = await (await page.request.get(`/api/tasks/${target.id}`)).json();
    const region = d.customFields.find((f: { name: string }) => f.name === "Region");
    return region && d.task.fields[region.id] ? region.options.find((o: { id: string }) => o.id === d.task.fields[region.id])?.label : null;
  }).toBe("VIC");
  await page.keyboard.press("Escape");
  await page.goto(`/app/tasks?project=${project.id}&view=list`);

  await page.getByRole("button", { name: "Field filter" }).click();
  const picker = page.getByRole("group", { name: "Field filter" });
  await picker.getByLabel("Filter field").selectOption({ label: "Region" });
  await picker.getByLabel("Filter value").selectOption({ label: "VIC" });
  await picker.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/field\./);
  await expect(page.getByText("Region is VIC")).toBeVisible();
  const rows = page.getByTestId("task-list").locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Check SPF");
});

test("invite a guest who sees only that project, and can comment", async ({ page, browser }) => {
  const project = await demo(page);
  await page.goto(`/app/tasks?project=${project.id}&view=list`);
  await page.getByRole("button", { name: "Guests" }).click();
  const dialog = page.getByRole("dialog", { name: /Guests on/ });
  await dialog.getByLabel("Guest email").fill("maria.guest@example.com");
  await dialog.getByLabel("Guest name").fill("Maria");
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/guests") && r.request().method() === "POST"),
    dialog.getByRole("button", { name: "Invite" }).click(),
  ]);
  const invite = await res.json();
  expect(invite.guest.status).toBe("pending");
  await expect(dialog.getByRole("list", { name: "Guests" })).toContainText("maria.guest@example.com");
  // No email provider in this run, so the link comes back to share by hand.
  const url: string = invite.inviteUrl;
  expect(url).toContain("/g/");

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(new URL(url).pathname);
  await expect(guest).toHaveURL(/\/guest$/);
  await expect(guest.getByTestId("guest-project")).toHaveText("Blue Harbor move");
  const all = (await (await page.request.get(`/api/tasks?projectId=${project.id}`)).json()).tasks.length;
  await expect(guest.getByTestId("guest-tasks").locator("li")).toHaveCount(all);
  // Nothing from the rest of the workspace.
  expect((await guest.request.get("/api/tasks")).status()).toBe(401);
  expect((await guest.request.get("/api/mail/messages")).status()).toBe(401);
  expect((await guest.request.get("/api/projects")).status()).toBe(401);

  await guest.getByTestId("guest-tasks").getByRole("button").first().click();
  const task = guest.getByTestId("guest-task");
  await task.getByLabel("Write a comment").fill("Cutover on Saturday works for us.");
  await task.getByRole("button", { name: "Comment" }).click();
  await expect(task.getByText("Cutover on Saturday works for us.")).toBeVisible();
  await expect(task.getByText("Maria (guest)")).toBeVisible();
  await guestCtx.close();
});

test("the portfolio shows every project with progress and health", async ({ page }) => {
  await demo(page);
  await page.goto("/app/portfolio");
  const table = page.getByTestId("portfolio-table");
  await expect(table).toBeVisible();
  const row = table.locator("tr", { hasText: "Blue Harbor move" });
  await expect(row.getByRole("combobox", { name: "Health of Blue Harbor move" })).toHaveValue("at_risk");
  await expect(row.getByRole("progressbar")).toBeVisible();
  await row.getByRole("combobox", { name: "Health of Blue Harbor move" }).selectOption("on_track");
  await expect.poll(async () => ((await (await page.request.get("/api/portfolio")).json()).projects as { name: string; health: string }[]).find((p) => p.name === "Blue Harbor move")?.health).toBe("on_track");
});

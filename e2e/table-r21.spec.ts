import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 21 (R21.2): the list view is a table. Edit a title in place and a status from the cell menu,
 * pick three rows, then set their assignee and a label from the bulk bar; the changes survive a reload.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.121.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

test("edits cells in place and changes three tasks at once from the bulk bar", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 });
  await demo(page);
  const headers = { origin: new URL(page.url()).origin };
  const me = await (await page.request.get("/api/account/me")).json();
  const project = (await (await page.request.post("/api/projects", { headers, data: { name: "Website launch" } })).json()).project as { id: string; key: string };
  const seed = [
    { title: "Draft the homepage copy", priority: "high", start: "2026-10-28", due: "2026-11-04", labels: ["copy"] },
    { title: "Pick hero photos", priority: "medium", start: "2026-10-30", due: "2026-11-06", labels: ["design"] },
    { title: "Set up the domain redirects", priority: "urgent", due: "2026-11-02", labels: ["ops"] },
    { title: "Write the launch email", priority: "low", start: "2026-11-05", due: "2026-11-10", labels: ["copy", "email"] },
    { title: "Check the pricing page on phones", priority: "none", due: null, labels: [] },
  ];
  const refs: string[] = [];
  for (const t of seed) refs.push((await (await page.request.post("/api/tasks", { headers, data: { ...t, projectId: project.id } })).json()).task.ref);

  await page.goto(`/app/tasks?project=${project.id}&view=list`);
  const table = page.getByTestId("task-table");
  await expect(table).toBeVisible();
  const row = (ref: string) => table.locator(`tr[data-task="${ref}"]`);
  await expect(row(refs[0])).toContainText("Draft the homepage copy");
  for (const h of ["Key", "Title", "Status", "Assignee", "Priority", "Due", "Labels", "Start"]) await expect(table.getByRole("columnheader", { name: h })).toBeVisible();

  // Title, in place: click, type, Enter.
  await row(refs[0]).getByRole("gridcell", { name: "Title" }).click();
  const title = row(refs[0]).getByRole("textbox", { name: "Title" });
  await title.fill("Write the homepage copy");
  await title.press("Enter");
  await expect(row(refs[0])).toContainText("Write the homepage copy");

  // Status, from the cell menu.
  await row(refs[1]).getByRole("gridcell", { name: "Status" }).click();
  await page.getByRole("listbox", { name: "Status" }).getByRole("option", { name: "In progress" }).click();
  await expect(row(refs[1]).getByRole("gridcell", { name: "Status" })).toContainText("In progress");

  // Escape cancels an edit.
  await row(refs[4]).getByRole("gridcell", { name: "Title" }).click();
  await row(refs[4]).getByRole("textbox", { name: "Title" }).fill("Nope");
  await row(refs[4]).getByRole("textbox", { name: "Title" }).press("Escape");
  await expect(row(refs[4])).toContainText("Check the pricing page on phones");

  // Sort by key (the status change moved a row), then three rows: one click, then Shift+click for the range.
  await table.getByRole("columnheader", { name: "Key" }).getByRole("button").click();
  await expect(table.getByRole("columnheader", { name: "Key" })).toHaveAttribute("aria-sort", "ascending");
  await row(refs[0]).getByRole("checkbox").click();
  await row(refs[2]).getByRole("checkbox").click({ modifiers: ["Shift"] });
  const bar = page.getByTestId("bulk-bar");
  await expect(bar).toContainText("3 selected");

  // Bulk: assign to me, then add a label. One request each.
  const bulkCalls: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/tasks/bulk") && r.method() === "POST") bulkCalls.push(r.postData() ?? ""); });
  await bar.getByRole("button", { name: "Assign to" }).click();
  await bar.getByRole("menuitem", { name: me.user.name }).click();
  await expect(row(refs[2]).getByRole("gridcell", { name: "Assignee" })).toContainText(me.user.name);
  await bar.getByRole("button", { name: "Labels" }).click();
  await bar.getByRole("textbox", { name: "Label" }).fill("launch");
  await bar.getByRole("button", { name: "Add label" }).click();
  for (const r of refs.slice(0, 3)) await expect(row(r).getByRole("gridcell", { name: "Labels" })).toContainText("launch");
  // Round 21 follow-up: set the type on all three in one call.
  await bar.getByRole("button", { name: "Type" }).click();
  await bar.getByRole("menuitem", { name: "Bug" }).click();
  for (const r of refs.slice(0, 3)) await expect(row(r).getByRole("gridcell", { name: "Type" })).toContainText("Bug");
  expect(bulkCalls).toHaveLength(3);

  mkdirSync(`${SHOTS_ROOT}/multies-r21`, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: process.env.E2E_SHOT ?? `${SHOTS_ROOT}/multies-r21/table.png` }).catch(() => {});

  // After a reload the server has it all.
  await page.reload();
  await expect(row(refs[0])).toContainText("Write the homepage copy");
  await expect(row(refs[1]).getByRole("gridcell", { name: "Status" })).toContainText("In progress");
  for (const r of refs.slice(0, 3)) {
    await expect(row(r).getByRole("gridcell", { name: "Assignee" })).toContainText(me.user.name);
    await expect(row(r).getByRole("gridcell", { name: "Labels" })).toContainText("launch");
  }
  await expect(row(refs[3]).getByRole("gridcell", { name: "Labels" })).not.toContainText("launch");

  // Cmd or Ctrl+A picks every visible row; Escape clears.
  await table.focus();
  await page.keyboard.press("ControlOrMeta+a");
  const visible = await table.locator("tbody tr[data-task]").count();
  expect(visible).toBeGreaterThanOrEqual(5);
  await expect(page.getByTestId("bulk-bar")).toContainText(`${visible} selected`);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
});

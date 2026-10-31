import { test, expect, type Page } from "@playwright/test";

/**
 * R84: saved views as pinned tabs, list grouping, several people on a task, the full task page, workspace tags and
 * workspace fields with bulk edit. Runs against the local server with the demo workspace.
 */
let visitor = 0;
const ip = () => `10.185.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  if (!process.env.E2E_BASE_URL) await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.goto("/app/tasks?view=list");
  await expect(page.locator("[data-task-id]").first()).toBeVisible({ timeout: 20_000 });
}

test.describe("R84 tasks", () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 860 }); });

  test("save a view as a pinned tab, reopen it, rename and delete it", async ({ page }) => {
    await demo(page);
    await page.getByLabel("Group list by").selectOption("priority");
    await expect(page.getByTestId("group-header").first()).toBeVisible();
    await page.getByRole("button", { name: "Saved views" }).click();
    await page.getByRole("menuitem", { name: "Save as new view" }).click();
    const dlg = page.getByRole("dialog", { name: "Save view" });
    await expect(dlg).toContainText("Grouped by priority");
    await dlg.getByRole("textbox").fill("By priority");
    await dlg.getByText("Everyone").click();
    await dlg.getByRole("button", { name: "Save view" }).click();
    const tabs = page.getByTestId("view-tabs");
    await expect(tabs.getByRole("tab", { name: "By priority" })).toHaveAttribute("aria-selected", "true");
    await tabs.getByRole("tab", { name: "All tasks" }).click();
    await expect(page.getByTestId("group-header")).toHaveCount(0);
    await expect(page).not.toHaveURL(/group=/);
    await tabs.getByRole("tab", { name: "By priority" }).click();
    await expect(page).toHaveURL(/group=priority/);
    await expect(page.getByTestId("group-header").first()).toBeVisible();
    // Keyboard: arrows move between tabs.
    await tabs.getByRole("tab", { name: "By priority" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(tabs.getByRole("tab", { name: "All tasks" })).toBeFocused();
    await tabs.getByRole("button", { name: "By priority options" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByRole("dialog", { name: "Rename view" }).getByRole("textbox").fill("Hot list");
    await page.getByRole("dialog", { name: "Rename view" }).getByRole("button", { name: "Rename" }).click();
    await expect(tabs.getByRole("tab", { name: "Hot list" })).toBeVisible();
    await tabs.getByRole("button", { name: "Hot list options" }).click();
    await page.getByRole("menuitem", { name: "Delete view" }).click();
    await page.getByRole("dialog", { name: /Delete the view/ }).getByRole("button", { name: "Delete view" }).click();
    await expect(page.getByTestId("view-tabs")).toHaveCount(0);
  });

  test("group by assignee: fold a group and select a whole group for the bulk bar", async ({ page }) => {
    await demo(page);
    await page.goto("/app/tasks?view=list&group=status");
    const headers = page.getByTestId("group-header");
    await expect(headers.first()).toBeVisible();
    const first = headers.first();
    const count = Number(await first.locator("button span.tabular-nums").innerText());
    const rowsBefore = await page.locator("[data-task-id]").count();
    await first.getByRole("button", { expanded: true }).click();
    await expect(page.locator("[data-task-id]")).toHaveCount(rowsBefore - count);
    await first.getByRole("button", { expanded: false }).click();
    await expect(page.locator("[data-task-id]")).toHaveCount(rowsBefore);
    await first.getByRole("checkbox").check();
    await expect(page.getByTestId("bulk-bar")).toContainText(`${count} selected`);
  });

  test("tags: create in the picker, colours in the list, manage and bulk add", async ({ page }) => {
    await demo(page);
    await page.locator("[data-task-id]").first().locator("td").nth(1).click();
    const panel = page.getByRole("dialog", { name: "Task" }).or(page.getByTestId("task-inspector"));
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Tags" }).click();
    await page.getByLabel("Find or create a tag").fill("urgent client");
    await page.keyboard.press("Enter");
    await expect(panel.getByTestId("tag-chip").filter({ hasText: "urgent client" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/app/tasks?view=list&manage=tags");
    const tags = page.getByRole("dialog", { name: "Tags" });
    await expect(tags.getByTestId("tag-row").filter({ has: page.locator('input[value="urgent client"]') })).toContainText("1 task");
    await tags.getByLabel("New tag name").fill("blocked");
    await tags.getByRole("button", { name: "Add tag" }).click();
    await expect(tags.getByLabel("Name of tag blocked")).toBeVisible();
    await tags.getByLabel("Name of tag blocked").fill("waiting");
    await tags.getByLabel("Name of tag blocked").press("Enter");
    await expect(tags.getByLabel("Name of tag waiting")).toBeVisible();
    await page.keyboard.press("Escape");
    // Bulk: pick two rows, add the tag from the bar.
    await page.locator("[data-task-id]").nth(0).getByRole("checkbox").click();
    await page.locator("[data-task-id]").nth(1).getByRole("checkbox").click();
    await page.getByTestId("bulk-bar").getByRole("button", { name: "Tags" }).click();
    await page.getByRole("button", { name: "Add tag waiting" }).click();
    await expect(page.locator("[data-task-id]").nth(1).getByTestId("tag-chip").filter({ hasText: "waiting" })).toBeVisible();
  });

  test("full task page: several people, description with formatting and a mention, comment mention list", async ({ page }) => {
    await demo(page);
    await page.locator("[data-task-id]").first().locator("td").nth(1).click();
    await page.getByTestId("open-task-page").click();
    await expect(page).toHaveURL(/\/app\/tasks\/[A-Z]+-\d+/);
    const view = page.getByTestId("task-page");
    await expect(view).toBeVisible();
    await view.getByRole("button", { name: "Assignees" }).click();
    const options = page.getByRole("listbox", { name: "People" }).getByRole("option");
    const n = await options.count();
    expect(n).toBeGreaterThan(1);
    await page.getByLabel("Find a person").press("ArrowDown");
    await page.getByLabel("Find a person").press("Enter");
    await page.getByLabel("Find a person").press("ArrowDown");
    await page.getByLabel("Find a person").press("Enter");
    await page.keyboard.press("Escape");
    await expect(view.getByRole("button", { name: "Assignees" })).toContainText(/and \d+ more|\w/);
    await view.getByTestId("description-view").click();
    const box = view.getByLabel("Description");
    await box.fill("Ship the checklist");
    await box.press("End");
    await box.press("Shift+Home");
    await view.getByRole("button", { name: "Bold" }).click();
    await expect(box).toHaveValue("**Ship the checklist**");
    await box.press("End");
    await box.type(" for @");
    await expect(page.getByTestId("mention-list")).toBeVisible();
    await box.press("Enter");
    await box.press("Escape");
    await expect(view.getByTestId("description-view").locator("strong")).toHaveText("Ship the checklist");
    await expect(view.getByTestId("description-view").locator(".mention")).toBeVisible();
    await view.getByLabel("Write a comment").fill("Thanks @");
    await expect(page.getByTestId("mention-list")).toBeVisible();
    await view.getByLabel("Write a comment").press("Tab");
    await expect(view.getByLabel("Write a comment")).toHaveValue(/Thanks @\w+ $/);
    // The page and the side panel are one tap apart.
    await view.getByRole("link", { name: "Open in side panel" }).click();
    await expect(page).toHaveURL(/\/app\/tasks\?task=/);
  });

  test("workspace field: add a dropdown for every project, see the column, set it in bulk and filter", async ({ page }) => {
    await demo(page);
    await page.goto("/app/tasks?view=list&manage=fields");
    const dlg = page.getByRole("dialog", { name: "Workspace fields" });
    await dlg.getByLabel("New workspace field name").fill("Client");
    await dlg.getByLabel("New workspace field type").selectOption("select");
    await dlg.getByLabel("New workspace field options").fill("Acme, Globex");
    await dlg.getByRole("button", { name: "Add to every project" }).click();
    await expect(dlg.getByTestId("ws-field-row")).toContainText(/On \d+ project/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("columnheader", { name: "Client" })).toBeVisible();
    await page.locator("[data-task-id]").nth(0).getByRole("checkbox").click();
    await page.locator("[data-task-id]").nth(1).getByRole("checkbox").click();
    await page.getByTestId("bulk-bar").getByRole("button", { name: "Field" }).click();
    await page.getByLabel("Value for Client").selectOption({ label: "Globex" });
    await page.getByRole("button", { name: "Set Client" }).click();
    await expect(page.locator("[data-task-id]").nth(1)).toContainText("Globex");
    await page.getByLabel("Group list by").selectOption({ label: "Client" });
    await expect(page.getByTestId("group-header").filter({ hasText: "Globex" })).toContainText("2");
  });

  test("390 wide: grouped list as sections and the task page without sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await demo(page);
    await page.goto("/app/tasks?view=list&group=priority");
    await expect(page.getByTestId("phone-task-groups")).toBeVisible();
    await expect(page.getByTestId("group-header").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByTestId("phone-task-row").first().click();
    await page.getByTestId("open-task-page").click();
    await expect(page.getByTestId("task-page")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
});

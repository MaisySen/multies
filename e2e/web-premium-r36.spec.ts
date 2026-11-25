import { test, expect, type Page } from "@playwright/test";

/**
 * R36 web premium round 3: (1) the task row title edits in place (click, type, Enter saves; Escape cancels) and the
 * board card title edits in place from its pencil; (2) the command menu opens on recent items and recent commands.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.36.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
}
const mod = process.platform === "darwin" ? "Meta" : "Control";

test("inline title edit on a task row and on a board card: Enter saves, Escape cancels", async ({ page }) => {
  test.setTimeout(120_000);
  await demo(page);
  const headers = { origin: new URL(page.url()).origin };
  const project = (await (await page.request.post("/api/projects", { headers, data: { name: "Inline edits", key: "INL" } })).json()).project as { id: string };
  const task = (await (await page.request.post("/api/tasks", { headers, data: { title: "Draft the brief", projectId: project.id } })).json()).task as { id: string };
  const titleOf = async () => ((await (await page.request.get(`/api/tasks/${task.id}`)).json()).task as { title: string }).title;

  // Task row (list view): click the title cell, type, Enter saves.
  await page.goto(`/app/tasks?view=list&project=${project.id}`);
  const row = page.getByRole("row").filter({ hasText: "Draft the brief" });
  await row.getByRole("gridcell", { name: "Draft the brief", exact: true }).click(); // W4: grid cells are named by what they hold
  // While editing, the title lives in the field's value, so find the field by its label.
  const input = page.getByRole("textbox", { name: "Title" });
  await input.fill("Draft the launch brief");
  await input.press("Enter");
  await expect(page.getByRole("row").filter({ hasText: "Draft the launch brief" })).toBeVisible();
  await expect.poll(titleOf).toBe("Draft the launch brief");
  // Escape cancels.
  await page.getByRole("row").filter({ hasText: "Draft the launch brief" }).getByRole("gridcell", { name: "Draft the launch brief", exact: true }).click();
  const again = page.getByRole("textbox", { name: "Title" });
  await again.fill("Should not stick");
  await again.press("Escape");
  await expect.poll(titleOf).toBe("Draft the launch brief");

  // Board card: the pencil opens the title in place, Enter saves; the priority popover sets priority.
  await page.goto(`/app/tasks?view=board&project=${project.id}`);
  const card = page.locator(`[data-testid=board-card][data-task-id="${task.id}"]`);
  await card.hover();
  await card.getByTestId("card-rename").click();
  const field = card.getByTestId("card-title-input");
  await field.fill("Ship the launch brief");
  await field.press("Enter");
  await expect(card).toContainText("Ship the launch brief");
  await expect.poll(titleOf).toBe("Ship the launch brief");
  await card.getByTestId("card-priority").click();
  await page.getByRole("menuitem", { name: "High" }).click();
  await expect.poll(async () => ((await (await page.request.get(`/api/tasks/${task.id}`)).json()).task as { priority: string }).priority).toBe("high");
  await card.hover();
  await card.getByTestId("card-rename").click();
  await card.getByTestId("card-title-input").fill("Nope");
  await card.getByTestId("card-title-input").press("Escape");
  await expect(card).toContainText("Ship the launch brief");
});

test("the command menu opens on recent items and recent commands", async ({ page }) => {
  test.setTimeout(90_000);
  await demo(page);
  await page.goto("/app/my-work");
  // First open from the sidebar button (the key handler is covered by commands-r31), then with the keys.
  let opened = false;
  const open = async () => {
    if (!opened) { await page.getByRole("button", { name: /^Search/ }).first().click(); opened = true; } else await page.keyboard.press(`${mod}+k`);
    await expect(page.locator("[cmdk-input]")).toBeVisible();
  };
  await open();
  await expect(page.getByTestId("palette-footer")).toBeVisible();
  await page.keyboard.type("Go to Docs");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/docs/);
  await open();
  await page.keyboard.type("DMARC");
  await page.getByTestId("search-result").first().waitFor({ timeout: 10_000 });
  const first = await page.getByTestId("search-result").first().getAttribute("data-url");
  await page.getByTestId("search-result").first().click();
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(first);
  await page.goto("/app/my-work");
  opened = false; // a fresh page load: open from the button again
  await open();
  await expect(page.getByTestId("palette-recent-items")).toBeVisible();
  await expect(page.getByTestId("palette-recent-commands")).toContainText("Docs");
  // Typing hides the recents; clearing brings them back.
  await page.keyboard.type("zz");
  await expect(page.getByTestId("palette-recent-items")).toHaveCount(0);
  await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace");
  await expect(page.getByTestId("palette-recent-items")).toBeVisible();
  // A recent item opens where it was.
  await page.getByTestId("palette-recent-items").locator("[cmdk-item]").first().click();
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(first);
});

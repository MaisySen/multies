import { test, expect, type Page } from "@playwright/test";

/**
 * R39 page history: save a named version, edit, compare against the page now, restore it (the page as it was is kept as
 * "Before restore"), keyboard open and close, and the phone layout (list, then compare with a back button).
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.39.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page, width = 1440, height = 900) {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.setViewportSize({ width, height });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function newDoc(page: Page, text: string) {
  const headers = { origin: new URL(page.url()).origin };
  return (await (await page.request.post("/api/docs", { headers, data: { title: "Launch plan", text } })).json()).doc as { id: string; version: number };
}
const body = (page: Page) => page.getByRole("textbox", { name: "Doc body" });
const saved = (page: Page) => expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 15_000 });

test("page history: save a version, compare with now, restore, and undo is kept", async ({ page }) => {
  test.setTimeout(120_000);
  await demo(page);
  const doc = await newDoc(page, "Ship the pricing page on Monday\nSend the newsletter on Tuesday");
  await page.goto(`/app/docs/${doc.id}`);
  await expect(body(page)).toContainText("Ship the pricing page on Monday");

  // Open with the keyboard; empty history shows the drawn empty state.
  await page.keyboard.press("Control+Alt+Shift+KeyH");
  const panel = page.getByTestId("doc-history-panel");
  await expect(panel.getByRole("heading", { name: "Page history" })).toBeVisible();
  await expect(panel.getByTestId("doc-version-current")).toContainText("Current page");
  await expect(panel.getByText("No earlier versions yet")).toBeVisible();

  // Save a named version.
  await panel.getByTestId("doc-version-save").click();
  const ask = page.getByRole("dialog", { name: "Save this version" });
  await ask.getByLabel("Name").fill("First draft");
  await ask.getByRole("button", { name: "Save version" }).click();
  await expect(panel.getByTestId("doc-version-row").first()).toContainText("First draft");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // Change the page in the editor.
  await body(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Ship the pricing page on Wednesday");
  await saved(page);

  // Compare: one line added, two removed against now.
  await page.getByRole("button", { name: "Page history" }).click();
  await panel.getByTestId("doc-version-row").first().click();
  const diff = panel.getByTestId("doc-version-diff");
  await expect(diff.locator('[data-op="add"]')).toHaveCount(1);
  await expect(diff.locator('[data-op="add"]')).toContainText("Ship the pricing page on Wednesday");
  await expect(diff.locator('[data-op="del"]')).toHaveCount(2);
  await expect(panel.getByTestId("doc-version-counts")).toContainText("1 added");

  // Restore it.
  await panel.getByTestId("doc-version-restore").click();
  await page.getByRole("dialog", { name: "Restore this version?" }).getByRole("button", { name: "Restore" }).click();
  await expect(panel).toBeHidden();
  await expect(body(page)).toContainText("Ship the pricing page on Monday", { timeout: 15_000 });
  await expect(body(page)).toContainText("Send the newsletter on Tuesday");

  // The page from before the restore is kept, so the restore can be undone.
  await page.getByRole("button", { name: "Page history" }).click();
  await expect(panel.getByTestId("doc-version-row").first()).toContainText("Before restore");
  const api = await (await page.request.get(`/api/docs/${doc.id}/versions`)).json();
  expect(api.versions.map((v: { reason: string }) => v.reason)).toEqual(["restore", "edit"]);
  const stored = await (await page.request.get(`/api/docs/${doc.id}`)).json();
  expect(stored.doc.text).toBe("Ship the pricing page on Monday\nSend the newsletter on Tuesday");
});

test("page history on a phone: list first, then compare with a back button, no sideways scroll", async ({ page }) => {
  test.setTimeout(90_000);
  await demo(page, 390, 844);
  const doc = await newDoc(page, "Agenda\nBudget");
  const headers = { origin: new URL(page.url()).origin };
  await page.request.post(`/api/docs/${doc.id}/versions`, { headers, data: { name: "Kickoff" } });
  await page.request.patch(`/api/docs/${doc.id}`, { headers, data: { text: "Agenda\nBudget agreed\nOwners", version: doc.version } });
  await page.goto(`/app/docs/${doc.id}`);
  await page.getByRole("button", { name: "Page history" }).click();
  const panel = page.getByTestId("doc-history-panel");
  await panel.getByTestId("doc-version-row").first().click();
  await expect(panel.getByTestId("doc-version-diff")).toBeVisible();
  await expect(panel.getByRole("navigation", { name: "Saved versions" })).toBeHidden();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(wide).toBe(false);
  await panel.getByRole("button", { name: "Back to versions" }).click();
  await expect(panel.getByRole("navigation", { name: "Saved versions" })).toBeVisible();
});

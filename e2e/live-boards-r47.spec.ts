import { test, expect, type Page } from "@playwright/test";

/**
 * R47 (MB-139): an open board shows a task another tab made in about a second, with its poll stretched to ten minutes,
 * so only the live socket's push can have brought it.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.147.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(180_000);

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}

test("a task made elsewhere shows on an open board without waiting for the poll", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __MULTIES_LIST_POLL_MS?: unknown }).__MULTIES_LIST_POLL_MS = { live: 600_000, fallback: 600_000 }; });
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(page);
  await page.goto("/app/tasks?view=board");
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __MULTIES_LIVE_CHANGES__?: { live: boolean } }).__MULTIES_LIVE_CHANGES__?.live ?? false), { timeout: 30_000 }).toBe(true);
  // The board shows one project (the picker's choice); the task goes there.
  const projects = (await (await page.request.get("/api/projects")).json()).projects as { id: string; name: string }[];
  const shown = (await page.getByRole("combobox", { name: "Project" }).locator("option:checked").textContent())?.trim();
  const project = projects.find((p) => p.id === shown || p.name === shown) ?? projects[0];
  const title = `Live card ${Date.now()}`;
  // Another tab of the same workspace (an API call outside this page's own cache) makes the task.
  const made = await page.request.post("/api/tasks", { data: { projectId: project.id, title } });
  expect(made.status()).toBe(201);
  const t0 = Date.now();
  await expect(page.getByTestId("board").getByText(title, { exact: true })).toBeVisible({ timeout: 10_000 });
  const ms = Date.now() - t0;
  test.info().annotations.push({ type: "live_ms", description: String(ms) });
  expect(ms).toBeLessThan(10_000);
});

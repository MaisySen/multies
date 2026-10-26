import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R34 (MB-186): board swimlanes and WIP limits. Turn on lanes by assignee, drag an unassigned card into a
 * person's lane (that assigns it), then set a limit of 1 on To do and see the over limit state.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.84.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
}

async function drag(page: Page, from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + 12);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + 20, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2 + 2, { steps: 2 });
  await page.mouse.up();
}

test("lanes by assignee: a drag into a person's lane assigns the card; a limit of 1 shows the over limit state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await demo(page);
  const headers = { origin: new URL(page.url()).origin };
  const project = (await (await page.request.post("/api/projects", { headers, data: { name: "Launch board", key: "LCH" } })).json()).project as { id: string; statuses: { id: string; name: string }[] };
  const me = ((await (await page.request.get("/api/tasks/assignees")).json()).assignees as { id: string; type: string; name: string; isAgent?: boolean }[]).find((p) => p.type === "member" && !p.isAgent)!;
  const mk = async (title: string, extra: Record<string, unknown> = {}) =>
    (await (await page.request.post("/api/tasks", { headers, data: { title, projectId: project.id, ...extra } })).json()).task as { id: string };
  await mk("Write the launch post", { assignee: { type: "member", id: me.id }, priority: "high" });
  const loose = await mk("Pick the launch date");

  await page.goto(`/app/tasks?view=board&project=${project.id}`);
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("swimlanes-select").selectOption("assignee");
  const lanes = page.getByTestId("lane-board");
  await expect(lanes).toBeVisible();
  const myLane = lanes.getByTestId("lane").filter({ has: page.getByText(me.name, { exact: true }) });
  const noLane = lanes.locator('[data-testid="lane"][data-lane-name="No assignee"]');
  await expect(myLane).toHaveCount(1);
  await expect(noLane.getByText("Pick the launch date")).toBeVisible();
  // "No assignee" is the last lane.
  await expect(lanes.getByTestId("lane").last()).toHaveAttribute("data-lane-name", "No assignee");

  // Drag the loose card into my lane, same column: it gets assigned to me.
  const todo = project.statuses[0]!.id;
  await drag(page, noLane.locator(`[data-task-id="${loose.id}"]`), myLane.locator(`[data-testid="lane-cell"][data-col="${todo}"]`));
  await expect(myLane.getByText("Pick the launch date")).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => ((await (await page.request.get(`/api/tasks/${loose.id}`)).json()).task?.assignee?.id), { timeout: 10_000 }).toBe(me.id);

  // The choice is saved with the board.
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${project.id}/board`)).json()).board.swimlanes).toBe("assignee");

  // A limit of 1 on To do: both cards sit there, so the header says 2 / 1 and Over limit.
  const header = lanes.getByTestId(`lane-col-${project.statuses[0]!.name}`);
  await header.getByTestId("column-limit-menu").click();
  await page.getByTestId("limit-preset-1").click();
  await expect(header).toHaveAttribute("data-over", "true");
  await expect(header.getByTestId("column-count")).toContainText("2 / 1");
  await expect(header.getByTestId("column-count")).toContainText("Over limit");
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${project.id}/board`)).json()).board.limits[todo]?.max).toBe(1);

  mkdirSync("/home/user/tab/files/multies-r34", { recursive: true });
  await page.screenshot({ path: "/home/user/tab/files/multies-r34/board-swimlanes.png" });

  // Fold a lane; it stays folded after a reload (this device only).
  await myLane.getByTestId("lane-toggle").click();
  await expect(myLane.getByTestId("lane-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(page.getByTestId("lane-board").getByTestId("lane").filter({ has: page.getByText(me.name, { exact: true }) }).getByTestId("lane-toggle")).toHaveAttribute("aria-expanded", "false", { timeout: 15_000 });

  // Phone width: the lane board scrolls inside itself, the page does not overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/tasks?view=board&project=${project.id}`);
  await expect(page.getByTestId("lane-board")).toBeVisible({ timeout: 15_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "/home/user/tab/files/multies-r34/board-swimlanes-390.png" });
});

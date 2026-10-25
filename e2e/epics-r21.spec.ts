import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Round 21 (R21.4): task types and epics. Make an epic, put two tasks in it, finish one and see
 * 50 percent; set a task's type to Bug and see the bug icon on the board.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.79.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  // Let the demo's sample seed finish first, so it doesn't land in the project made below.
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
  await expect.poll(async () => {
    await page.request.post("/api/account/demo/seed", { headers: { origin: new URL(page.url()).origin } }).catch(() => null);
    return ((await (await page.request.get("/api/docs")).json().catch(() => ({}))).docs ?? []).length;
  }, { timeout: 30_000 }).toBeGreaterThan(0);
}

test("an epic with two tasks shows 50 percent once one is done; a bug shows its icon on the board", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 });
  await demo(page);
  const headers = { origin: new URL(page.url()).origin };
  const project = (await (await page.request.post("/api/projects", { headers, data: { name: "Mobile app", key: "MOB" } })).json()).project as { id: string };
  const mk = async (title: string, extra: Record<string, unknown> = {}) =>
    (await (await page.request.post("/api/tasks", { headers, data: { title, projectId: project.id, ...extra } })).json()).task as { id: string; ref: string };
  const login = await mk("Sign in with a passkey", { type: "story", priority: "high" });
  const crash = await mk("App closes when the camera opens");
  await mk("Offline mode", { type: "epic" });
  const dark = await mk("Dark mode colours", { type: "story", due: "2026-11-20" });
  const push = await mk("Push notification copy");

  await page.goto(`/app/tasks?view=board&project=${project.id}`);
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 15_000 });

  // Make an epic from the Epics panel.
  await page.getByRole("button", { name: "Epics" }).click();
  const panel = page.getByTestId("epics-panel");
  await panel.getByRole("textbox", { name: "New epic" }).fill("Launch 1.0");
  await panel.getByRole("button", { name: "Add epic" }).click();
  const row = panel.getByTestId("epic-row").filter({ hasText: "Launch 1.0" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("epic-progress")).toHaveText("0 of 0 done, 0%");
  await row.click();

  // The epic's panel: add two tasks with the "Add to epic" picker.
  const section = page.getByTestId("epic-section");
  await expect(section).toBeVisible();
  const picker = section.getByRole("combobox", { name: "Add to epic" });
  await picker.selectOption({ label: `Story: ${login.ref} Sign in with a passkey` });
  await expect(section.getByText("Sign in with a passkey")).toBeVisible();
  await picker.selectOption({ label: `Task: ${crash.ref} App closes when the camera opens` });
  await expect(section.getByTestId("epic-progress")).toHaveText("0 of 2 done, 0%");

  // Finish one: 50 percent.
  await section.getByRole("button", { name: "Mark Sign in with a passkey as done" }).click();
  await expect(section.getByTestId("epic-progress")).toHaveText("1 of 2 done, 50%");
  await expect(section.getByRole("progressbar", { name: "Epic progress" })).toHaveAttribute("aria-valuenow", "50");

  // Open the other item and make it a Bug with the type picker.
  await section.getByRole("button", { name: "App closes when the camera opens", exact: true }).click();
  const types = page.getByRole("radiogroup", { name: "Type" });
  await expect(page.getByRole("combobox", { name: "Epic" })).toBeVisible();
  await types.getByRole("radio", { name: "Bug" }).click();
  await expect(types.getByRole("radio", { name: "Bug" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Close task" }).click();

  // The board card shows the bug icon before its key, and the list filter by type finds it.
  const card = page.getByTestId("board-card").filter({ hasText: "App closes when the camera opens" });
  await expect(card.getByTestId("type-icon-bug")).toBeVisible();
  await expect(page.getByTestId("board-card").filter({ hasText: "Sign in with a passkey" }).getByTestId("type-icon-story")).toBeVisible();
  await expect(page.getByTestId("board-card").filter({ hasText: "Offline mode" }).getByTestId("type-icon-epic")).toBeVisible();

  // The Epics panel shows the progress too.
  await page.getByRole("button", { name: "Epics" }).click();
  await expect(page.getByTestId("epic-row").filter({ hasText: "Launch 1.0" }).getByTestId("epic-progress")).toHaveText("1 of 2 done, 50%");
  await page.keyboard.press("Escape");

  // Two more items (one done) for the picture: 2 of 4, 50 percent, in the epic's own panel over the board.
  const epics = (await (await page.request.get(`/api/epics?project=${project.id}`)).json()).epics as { id: string; title: string }[];
  const launch = epics.find((e) => e.title === "Launch 1.0")!;
  expect((await page.request.post(`/api/epics/${launch.id}/items`, { headers, data: { ids: [dark.id, push.id] } })).status()).toBe(200);
  await page.request.patch(`/api/tasks/${push.id}`, { headers, data: { status: "done" } });
  await page.goto(`/app/tasks?view=board&project=${project.id}&task=${launch.id}`);
  await expect(page.getByTestId("epic-section").getByTestId("epic-progress")).toHaveText("2 of 4 done, 50%");
  await expect(page.getByTestId("board-card").first()).toBeVisible();
  await page.waitForTimeout(400);
  mkdirSync("/home/user/tab/files/multies-r21", { recursive: true });
  await page.screenshot({ path: "/home/user/tab/files/multies-r21/types.png" });

  await page.goto(`/app/tasks?view=list&project=${project.id}&type=bug`);
  await expect(page.getByTestId("task-list").getByText("App closes when the camera opens")).toBeVisible();
  await expect(page.getByTestId("task-list").getByText("Push notification copy")).toHaveCount(0);
});

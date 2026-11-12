import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R31: one command registry. G then T goes to Tasks; J focuses a task and S opens its status picker inside the
 * command menu; Cmd+K with a task focused leads with its actions; the ? sheet lists the task keys; E archives
 * the open email.
 */
const SHOTS = `${SHOTS_ROOT}/multies-r31`;
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.31.${test.info().workerIndex % 200}.${++visitor}` });
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

test("keys from the registry: G T, J then S picks a status, Cmd+K shows the task's actions, ? lists S", async ({ page }) => {
  test.setTimeout(120_000);
  await demo(page);
  const projects = (await (await page.request.get("/api/projects")).json()).projects as { id: string; statuses: { id: string; name: string; position: number }[] }[];
  const project = projects[0];
  const task = (await (await page.request.post("/api/tasks", { data: { projectId: project.id, title: "Aaa keyboard focus check" } })).json()).task as { id: string; ref: string; statusId: string };

  // G then T goes to Tasks, with the "G then" hint on the way.
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("heading", { name: "Overview", level: 1 }).click();
  await page.keyboard.press("g");
  await expect(page.getByTestId("sequence-hint")).toBeVisible();
  await page.keyboard.press("t");
  await expect(page).toHaveURL(/\/app\/tasks/);

  await page.goto(`/app/tasks?project=${project.id}&view=list`);
  const row = page.locator(`[data-task-id="${task.id}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await page.locator("h1").first().click().catch(() => null);
  // J walks the rows until our task has focus.
  for (let i = 0; i < 60; i++) {
    if (await row.getAttribute("data-kb-focus") !== null) break;
    await page.keyboard.press("j");
  }
  await expect(row).toHaveAttribute("data-kb-focus", "");

  // Cmd+K with a task focused: its actions lead.
  await page.keyboard.press(`${mod}+k`);
  const context = page.getByTestId("palette-context");
  await expect(context.getByText("Change status...")).toBeVisible({ timeout: 15_000 });
  await expect(context.getByText("Assign to...")).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/keys-task-actions.png` });
  await page.keyboard.press("Escape");
  await expect(context).toBeHidden();

  // S opens the status picker inside the menu; Backspace goes back; pick a status and it changes.
  const target = [...project.statuses].sort((a, b) => a.position - b.position).find((s) => s.id !== task.statusId)!;
  await page.keyboard.press("s");
  const picker = page.getByTestId("palette-picker");
  await expect(picker).toBeVisible();
  await expect(page.getByTestId("palette-crumb")).toContainText(task.ref);
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("palette-context")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("s");
  await expect(picker).toBeVisible();
  await picker.getByRole("option", { name: target.name, exact: false }).first().click();
  await expect(page.getByText(`Status set to ${target.name}`)).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${task.id}`)).json()).task.statusId).toBe(target.id);

  // ? lists the S key in the Tasks group, first on the Tasks page.
  await page.keyboard.press("?");
  const sheet = page.getByTestId("shortcuts-sheet");
  await expect(sheet).toBeVisible();
  const tasks = sheet.getByRole("region", { name: "Tasks" });
  await expect(tasks.getByText("Change status...")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/keys-sheet.png` });
});

test("E archives the open email", async ({ page }) => {
  test.setTimeout(90_000);
  await demo(page);
  await page.goto("/app/mail");
  const first = page.getByText("Launch checklist for Friday").first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await first.click();
  await expect(page).toHaveURL(/[?&]m=/);
  // The reader is open and the list knows the message (E acts on the open message).
  await expect(page.getByRole("heading", { name: "Launch checklist for Friday", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Archive (e)" })).toBeVisible();
  // R55: wait on the page's own signal that the list holds the open message (its row is the current one), not on
  // "networkidle": the mail page keeps a live connection and a presence beat open, so it never goes idle and the
  // old wait ran out the whole test timeout. Since R32 E goes through the bulk path, whose toast names the count.
  await expect(page.locator('button[aria-current="true"]').first()).toBeVisible({ timeout: 15_000 });
  const id = new URL(page.url()).searchParams.get("m")!;
  await page.keyboard.press("e");
  await expect(page.getByText("Archived 1 conversation", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Undo" }).first()).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/mail/messages/${id}`)).json()).message.folder, { timeout: 15_000 }).toBe("archive");
});

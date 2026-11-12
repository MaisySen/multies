import { test, expect, type Page, type Browser } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R54 (plan idea 8): the command menu acts on typed words. "assign BHM-3 to Ana due tomorrow" shows one
 * preview row in plain words; nothing changes until Enter; Enter patches the task once, a toast offers Undo,
 * and Undo puts the old assignee and due date back.
 */
const SHOTS = `${SHOTS_ROOT}/multies-r54/command-bar`;
const TAG = process.env.SHOTS_TAG ?? "after";
let visitor = 0;
const ip = () => `10.54.${test.info().workerIndex % 200}.${++visitor % 250}`;
const mod = process.platform === "darwin" ? "Meta" : "Control";

type Person = { id: string; type: string; name: string; email: string | null; isAgent?: boolean };
type TaskRow = { id: string; ref: string; assigneeId: string | null; due: string | null; title: string };

async function demo(page: Page) {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
}

/** A task and a person who is not its assignee, with a first name only that person has. */
async function pickTarget(page: Page) {
  const people = ((await (await page.request.get("/api/tasks/assignees")).json()).assignees as Person[]).sort((a, b) => Number(a.type !== "member" || !!a.isAgent) - Number(b.type !== "member" || !!b.isAgent));
  const firstCount = new Map<string, number>();
  for (const p of people) { const f = p.name.split(/\s+/)[0].toLowerCase(); firstCount.set(f, (firstCount.get(f) ?? 0) + 1); }
  const tasks = (await (await page.request.get("/api/tasks")).json()).tasks as TaskRow[];
  const task = tasks.find((t) => t.ref.startsWith("BHM-")) ?? tasks[0];
  const person = people.find((p) => p.id !== task.assigneeId && firstCount.get(p.name.split(/\s+/)[0].toLowerCase()) === 1)!;
  return { task, person, first: person.name.split(/\s+/)[0] };
}

async function openMenu(page: Page) {
  await page.goto("/app/tasks");
  await expect(page.locator("h1").first()).toBeVisible({ timeout: 20_000 });
  await page.locator("h1").first().click().catch(() => null);
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("shots: the command menu with typed action words, desktop and 390 px, light and dark", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await demo(page);
  const { task, first } = await pickTarget(page);
  for (const [vp, scheme, name] of [[{ width: 1440, height: 900 }, "light", "desktop-light"], [{ width: 1440, height: 900 }, "dark", "desktop-dark"], [{ width: 390, height: 844 }, "light", "phone-light"], [{ width: 390, height: 844 }, "dark", "phone-dark"]] as const) {
    await page.setViewportSize(vp);
    await page.emulateMedia({ colorScheme: scheme });
    await openMenu(page);
    await page.screenshot({ path: `${SHOTS}/${TAG}-${name}-empty.png` });
    await page.keyboard.type(`assign ${task.ref} to ${first} due tomorrow priority high`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/${TAG}-${name}-typed.png` });
    await page.keyboard.press("Escape");
  }
  await ctx.close();
});

test("typed words: preview, Enter applies once, Undo restores", async ({ browser }: { browser: Browser }) => {
  test.skip(TAG === "before", "the preview row is new in R54");
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await demo(page);
  const { task, person, first } = await pickTarget(page);
  const before = (await (await page.request.get(`/api/tasks/${task.id}`)).json()).task as TaskRow;

  await openMenu(page);
  await page.keyboard.type(`assign ${task.ref} to ${first} due tomorrow`);
  const row = page.getByTestId("palette-action-preview");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText(`${task.ref}: assign to ${person.name}`);
  await expect(row).toContainText("due ");
  // The row reads the preview to a screen reader, and it leads the list.
  await expect(row.getByRole("option")).toHaveAccessibleName(new RegExp(`${task.ref}: assign to ${person.name}, due`));
  await expect(row.getByRole("option")).toHaveAttribute("aria-selected", "true");
  // Nothing changed yet.
  expect(((await (await page.request.get(`/api/tasks/${task.id}`)).json()).task as TaskRow).assigneeId).toBe(before.assigneeId);

  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeHidden();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: task.ref });
  await expect(toast).toBeVisible();
  const want = new Date(); want.setDate(want.getDate() + 1);
  const ymd = `${want.getFullYear()}-${String(want.getMonth() + 1).padStart(2, "0")}-${String(want.getDate()).padStart(2, "0")}`;
  await expect.poll(async () => { const t = (await (await page.request.get(`/api/tasks/${task.id}`)).json()).task as TaskRow; return [t.assigneeId, (t.due ?? "").slice(0, 10)]; }).toEqual([person.id, ymd]);

  // The task page shows the new assignee.
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => { const t = (await (await page.request.get(`/api/tasks/${task.id}`)).json()).task as TaskRow; return [t.assigneeId, t.due ? t.due.slice(0, 10) : null]; }).toEqual([before.assigneeId, before.due ? before.due.slice(0, 10) : null]);

  // An unknown ref says so and does nothing.
  await openMenu(page);
  await page.keyboard.type("assign ZZZ-999 to me");
  await expect(page.getByTestId("palette-action-preview")).toContainText("ZZZ-999 was not found");
  await page.keyboard.press("Escape");

  // Ordinary words stay a search.
  await openMenu(page);
  await page.keyboard.type("quarterly report");
  await page.waitForTimeout(500);
  await expect(page.getByTestId("palette-action-preview")).toHaveCount(0);
  await ctx.close();
});

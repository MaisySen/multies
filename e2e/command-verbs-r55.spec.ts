import { test, expect, type Page, type Browser } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R55: more verbs in the command menu (status, label, move to another project). Each shows one preview row, Enter
 * sends one PATCH, and Undo in the toast puts the task back exactly (status, labels, project and its ref).
 * Snooze and archive are not task features today: the row says so and nothing changes.
 */
const SHOTS = "/home/user/tab/files/multies-r55/command-bar";
const TAG = process.env.SHOTS_TAG ?? "after";
let visitor = 0;
const ip = () => `10.55.${test.info().workerIndex % 200}.${++visitor % 250}`;
const mod = process.platform === "darwin" ? "Meta" : "Control";

type Status = { id: string; name: string; category: string; position: number };
type Project = { id: string; name: string; key: string; archived: boolean; statuses: Status[] };
type TaskRow = { id: string; ref: string; projectId: string; statusId: string; statusName: string; labels: string[]; title: string; status: string };

async function demo(page: Page) {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
}

const getTask = async (page: Page, id: string) => (await (await page.request.get(`/api/tasks/${id}`)).json()).task as TaskRow;

/** An open task, a status of its project it is not in, another project, and a label some other task has. */
async function pick(page: Page) {
  const projects = ((await (await page.request.get("/api/projects")).json()).projects as Project[]).filter((p) => !p.archived);
  const tasks = (await (await page.request.get("/api/tasks")).json()).tasks as TaskRow[];
  const task = tasks.find((t) => t.status !== "done" && projects.some((p) => p.id !== t.projectId) && !t.labels.length) ?? tasks.find((t) => t.status !== "done")!;
  const project = projects.find((p) => p.id === task.projectId)!;
  const status = project.statuses.slice().sort((a, b) => a.position - b.position).find((s) => s.id !== task.statusId && s.category !== "done")
    ?? project.statuses.find((s) => s.id !== task.statusId)!;
  const other = projects.find((p) => p.id !== task.projectId)!;
  const known = [...new Set(tasks.flatMap((t) => t.labels))].filter((l) => /^[a-z]+$/i.test(l));
  return { task, project, status, other, label: known[0] ?? "design" };
}

async function openMenu(page: Page) {
  await page.goto("/app/tasks");
  await expect(page.locator("h1").first()).toBeVisible({ timeout: 20_000 });
  await page.locator("h1").first().click().catch(() => null);
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function typeIn(page: Page, words: string) {
  await openMenu(page);
  await page.keyboard.type(words);
}

test("shots: the command menu with status and label verbs, desktop and 390 px, light and dark", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await demo(page);
  const { task, status, label, other } = await pick(page);
  for (const [vp, scheme, name] of [[{ width: 1280, height: 860 }, "light", "desktop-light"], [{ width: 1280, height: 860 }, "dark", "desktop-dark"], [{ width: 390, height: 844 }, "light", "phone-light"], [{ width: 390, height: 844 }, "dark", "phone-dark"]] as const) {
    await page.setViewportSize(vp);
    await page.emulateMedia({ colorScheme: scheme });
    await openMenu(page);
    await page.screenshot({ path: `${SHOTS}/${TAG}-${name}-empty.png` });
    await page.keyboard.press("Escape");
    for (const [what, words] of [["status", `move ${task.ref} to ${status.name.toLowerCase()}`], ["label", `${task.ref} +${label} +urgent`], ["move", `move ${task.ref} to ${other.name}`]] as const) {
      await typeIn(page, words);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${SHOTS}/${TAG}-${name}-${what}.png` });
      await page.keyboard.press("Escape");
    }
  }
  await ctx.close();
});

async function applyAndUndo(page: Page, words: string, expectRow: RegExp, after: (t: TaskRow) => void, id: string) {
  const before = await getTask(page, id);
  await typeIn(page, words);
  const row = page.getByTestId("palette-action-preview");
  await expect(row).toContainText(expectRow, { timeout: 10_000 });
  await expect(row.getByRole("option")).not.toHaveAttribute("data-blocked", "");
  // Nothing changed yet.
  expect((await getTask(page, id)).statusId).toBe(before.statusId);
  let patches = 0;
  page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes("/api/tasks/")) patches++; });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeHidden();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: /updated/ }).last();
  await expect(toast).toBeVisible();
  await expect.poll(async () => { try { after(await getTask(page, id)); return true; } catch { return false; } }, { timeout: 10_000 }).toBe(true);
  expect(patches).toBe(1);
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => { const t = await getTask(page, id); return [t.ref, t.projectId, t.statusId, [...t.labels].sort().join(",")]; }, { timeout: 10_000 })
    .toEqual([before.ref, before.projectId, before.statusId, [...before.labels].sort().join(",")]);
  page.removeAllListeners("request");
}

for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone 390", { width: 390, height: 844 }]] as const) {
  test(`verbs on ${label}: status, label and move apply with one request and Undo puts them back`, async ({ browser }: { browser: Browser }) => {
    test.skip(TAG === "before", "the new verbs are R55");
    test.setTimeout(180_000);
    const ctx = await browser.newContext({ viewport, extraHTTPHeaders: { "x-forwarded-for": ip() } });
    const page = await ctx.newPage();
    await demo(page);
    const { task, status, label, other } = await pick(page);

    // status
    await applyAndUndo(page, `move ${task.ref} to ${status.name.toLowerCase()}`, new RegExp(`${task.ref}: status ${status.name}`), (t) => expect(t.statusId).toBe(status.id), task.id);
    // label: add one the workspace has and a new one (the row says it is new), remove later
    await typeIn(page, `${task.ref} +${label} +r55new`);
    await expect(page.getByTestId("palette-action-preview")).toContainText("label r55new (a new label)");
    await page.keyboard.press("Escape");
    await applyAndUndo(page, `label ${task.ref} ${label}`, new RegExp(`${task.ref}: label ${label}`), (t) => expect(t.labels).toContain(label), task.id);
    // move to another project: the row names the status it lands in
    await applyAndUndo(page, `move ${task.ref} to ${other.name}`, new RegExp(`${task.ref}: move to ${other.name}`), (t) => expect(t.projectId).toBe(other.id), task.id);

    // snooze and archive say so and change nothing
    await typeIn(page, `archive ${task.ref}`);
    await expect(page.getByTestId("palette-action-preview")).toContainText("can't be archived");
    await expect(page.getByTestId("palette-action-preview").getByRole("option")).toHaveAttribute("data-blocked", "");
    await page.keyboard.press("Escape");
    // A word that is not a verb stays a search.
    await typeIn(page, "quarterly report");
    await page.waitForTimeout(500);
    await expect(page.getByTestId("palette-action-preview")).toHaveCount(0);
    // No sideways scroll on the phone sheet.
    if (viewport.width < 500) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await ctx.close();
  });
}

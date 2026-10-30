import { test, expect, type Page } from "@playwright/test";

/**
 * R58 (MB-246): in the command menu a move says the ref will change, and a label no task has yet is made only after
 * a second Enter (the first Enter asks). Local only.
 */
test.skip(!!process.env.E2E_BASE_URL, "local only");
let visitor = 0;
const ip = () => `10.160.${test.info().workerIndex % 200}.${++visitor % 250}`;
const mod = process.platform === "darwin" ? "Meta" : "Control";
type Project = { id: string; name: string; key: string; archived: boolean };
type TaskRow = { id: string; ref: string; projectId: string; labels: string[]; status: string };

async function typeIn(page: Page, words: string) {
  await page.goto("/app/tasks");
  await expect(page.locator("h1").first()).toBeVisible({ timeout: 20_000 });
  await page.locator("h1").first().click().catch(() => null);
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.type(words);
}

test("a move says the ref changes, and a new label asks before it is made", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
  const projects = ((await (await page.request.get("/api/projects")).json()).projects as Project[]).filter((p) => !p.archived);
  const tasks = (await (await page.request.get("/api/tasks")).json()).tasks as TaskRow[];
  const task = tasks.find((t) => t.status !== "done" && projects.some((p) => p.id !== t.projectId))!;
  const other = projects.find((p) => p.id !== task.projectId)!;

  // A move: the row says the ref changes. Nothing is sent until Enter.
  await typeIn(page, `move ${task.ref} to ${other.name}`);
  const row = page.getByTestId("palette-action-preview");
  await expect(row).toContainText(`${task.ref} gets a new ${other.key} number`, { timeout: 10_000 });
  await page.screenshot({ path: "/home/user/tab/files/multies-r58/command-after-move-ref-desktop-light.png" });
  await page.keyboard.press("Escape");

  // A new label: the first Enter asks, the second makes it.
  let patches = 0;
  page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes("/api/tasks/")) patches++; });
  await typeIn(page, `${task.ref} +r58fresh`);
  await expect(page.getByTestId("palette-new-label")).toHaveText("No task has the label r58fresh yet. Press Enter to check.", { timeout: 10_000 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette-new-label")).toHaveText("Make the new label r58fresh? Press Enter again to apply.");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(patches).toBe(0);
  await page.screenshot({ path: "/home/user/tab/files/multies-r58/command-after-new-label-ask-desktop-light.png" });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(async () => ((await (await page.request.get(`/api/tasks/${task.id}`)).json()).task as TaskRow).labels, { timeout: 10_000 }).toContain("r58fresh");
  expect(patches).toBe(1);
  await ctx.close();
});

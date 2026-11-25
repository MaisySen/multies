import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 20: search everything from Cmd+K and the My Work page, on the seeded demo.
 * A word that is in a doc, a task and a chat message opens each at its real page.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.78.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
  await expect.poll(async () => {
    await page.request.post("/api/account/demo/seed", { headers: { origin: new URL(page.url()).origin } }).catch(() => null);
    return ((await (await page.request.get("/api/docs")).json().catch(() => ({}))).docs ?? []).length;
  }, { timeout: 30_000 }).toBeGreaterThan(0);
}

const palette = (page: Page) => page.getByRole("dialog", { name: "Command menu" });
async function openSearch(page: Page, q: string) {
  const dialog = palette(page);
  await expect(page.getByRole("button", { name: /^Search (Ctrl|⌘)/ })).toBeVisible();
  // The shortcut, once the app's key handler is in place.
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await dialog.getByRole("combobox").fill(q);
  return dialog;
}

test("Cmd+K finds a word in a doc, a task and a chat message and opens each; My Work shows what is due", async ({ page }) => {
  await demo(page);
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  const me = await (await page.request.get("/api/account/me")).json();
  // "Today" is the person's day in their own (or the workspace's) time zone, as My Work counts it.
  const today = (await (await page.request.get("/api/my-work")).json()).date as string;
  // The demo has "Blue Harbor" in its tasks and docs; say it in chat too, and give me a task due today.
  const channels = (await (await page.request.get("/api/chat/channels")).json()).channels as { id: string; name: string }[];
  const general = channels.find((c) => c.name === "general")!;
  expect((await page.request.post(`/api/chat/channels/${general.id}/messages`, { headers, data: { body: "Blue Harbor cutover went fine, thanks all" } })).status()).toBe(201);
  expect((await page.request.post("/api/tasks", { headers, data: { title: "Call Blue Harbor about invoices", assignee: `member:${me.user.id}`, due: today } })).status()).toBe(201);

  // Query time on the seeded demo, as the server measured it.
  const times: Record<string, number> = {};
  for (const q of ["harbor", "maria", "cutover", "dmarc", "invoice", "zzqx"]) {
    const t0 = Date.now();
    const r = await (await page.request.get(`/api/search?q=${q}`)).json();
    times[q] = r.tookMs;
    times[`${q} (round trip)`] = Date.now() - t0;
    expect(r.tookMs).toBeLessThan(300);
  }
  const mw = await (await page.request.get("/api/my-work")).json();
  console.log("search ms on the seeded demo", JSON.stringify(times), "my work ms", mw.tookMs);

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({ timeout: 15_000 });
  let dialog = await openSearch(page, "harbor");
  for (const type of ["tasks", "docs", "chat"]) await expect(dialog.getByTestId(`search-group-${type}`)).toBeVisible();
  mkdirSync(`${SHOTS_ROOT}/multies-r20`, { recursive: true });
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r20/search-mywork.png` });

  // The doc, by mouse.
  await dialog.getByTestId("search-group-docs").getByTestId("search-result").first().click();
  await expect(page).toHaveURL(/\/app\/docs\/doc_/);
  await expect(dialog).toBeHidden();

  // The task.
  dialog = await openSearch(page, "harbor");
  const taskResult = dialog.getByTestId("search-group-tasks").getByTestId("search-result").first();
  const taskUrl = await taskResult.getAttribute("data-url");
  await taskResult.click();
  await expect(page).toHaveURL(/\/app\/tasks\?project=.+&task=tsk_/);
  expect(page.url()).toContain(taskUrl!.split("task=")[1]);
  // R79: task details open in the side panel on a desktop.
  await expect(page.getByRole("complementary", { name: "Task details" }).getByLabel("Title")).toBeVisible();

  // The chat message, by keyboard: arrows to it, Enter opens it.
  await page.keyboard.press("Escape");
  dialog = await openSearch(page, "harbor cutover went");
  const chat = dialog.getByTestId("search-group-chat").getByTestId("search-result").first();
  await expect(chat).toBeVisible();
  // W4: the arrows can pass every result (R98 lists more groups than when this was written), so up to that many presses.
  const results = await dialog.getByTestId("search-result").count();
  for (let i = 0; i <= results && (await chat.getAttribute("data-selected")) !== "true"; i++) await page.keyboard.press("ArrowDown");
  await expect(chat).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/app/chat/${general.id}\\?thread=`));
  await expect(page.getByText("Blue Harbor cutover went fine, thanks all").first()).toBeVisible();

  // Too short a query searches nothing; nothing found says so.
  dialog = await openSearch(page, "zzqx nothing here");
  await expect(dialog.getByText(/Nothing matches|No results for/).first()).toBeVisible(); // R98 copy when SEARCH_R98 is on
  await page.keyboard.press("Escape");

  // My Work: first in the nav (named Home there since the R121 menu), my task due today is there and opens.
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /^Home/ }).click();
  await expect(page).toHaveURL(/\/app\/my-work/);
  await expect(page.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
  await expect(page.getByText("My Work", { exact: true }).last()).toBeVisible();
  const due = page.getByTestId("mywork-due");
  await expect(due.getByText("Call Blue Harbor about invoices")).toBeVisible();
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r20/my-work.png`, fullPage: true });
  await due.getByText("Call Blue Harbor about invoices").click();
  await expect(page).toHaveURL(/\/app\/tasks\?project=.+&task=tsk_/);
});

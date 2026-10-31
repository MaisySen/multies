import path from "node:path";
import Database from "better-sqlite3";
import { test, expect, type Page } from "@playwright/test";

/**
 * R46 ui helper.
 * Archive older mail stays offered on an empty Inbox tab (Important empty, Other has mail): the sheet counts the whole
 * Inbox and says so. The sprint header and the backlog selection bar at 390 and 360: one row each, no wrapping, and
 * the selection bar sits at the foot of the screen on a phone like a native toolbar. SHOTS=before|after writes shots to
 * /home/user/tab/files/multies-r46/.
 */
const SHOTS = process.env.SHOTS;
const DIR = "/home/user/tab/files/multies-r46";
let visitor = 0;
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.146.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(180_000);

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}
async function seedOld(page: Page, tag: string, n: number) {
  const overview = await (await page.request.get("/api/mail/overview")).json();
  const mb = [...overview.mailboxes].sort((a, b) => (b.folders.inbox?.total ?? 0) - (a.folders.inbox?.total ?? 0))[0] as { id: string };
  const db = new Database(path.resolve(".data/e2e.db"), { fileMustExist: true });
  const orgId = (db.prepare("select org_id from mailboxes where id = ?").get(mb.id) as { org_id: string }).org_id;
  const now = Date.now();
  const ins = db.prepare("insert into messages (id, org_id, mailbox_id, folder, thread_id, from_address, from_name, subject, snippet, date, created_at) values (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(`msg_${tag}_${i}`, orgId, mb.id, `thr_${tag}_${i}`, `old${i}@r46-older.test`, `Old sender ${i}`, `Old note ${i}`, "Seeded for archive older", now - 400 * 86_400_000 - i * 1000, now - 60_000);
  })();
  db.close();
  return mb.id;
}
/** The Important tab reads back empty (as when all Inbox mail sits in Other); the rest of the API is real. */
async function emptyImportant(page: Page) {
  await page.route(/\/api\/mail\/messages\?/, (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get("folder") === "inbox" && u.searchParams.get("split") === "important" && !u.searchParams.get("q")) {
      return route.fulfill({ json: { messages: [], nextCursor: null, asOf: new Date().toISOString() } });
    }
    return route.fallback();
  });
}

test.describe("Archive older on an empty Inbox tab", () => {
  for (const [w, h, kind] of [[1280, 860, "desktop"], [390, 844, "phone"]] as const) {
    test(`Important is empty, Inbox has old mail: Archive older is offered and counts the whole Inbox (${kind})`, async ({ page }) => {
      test.skip(!!SHOTS, "behaviour, not shots");
      await page.setViewportSize({ width: w, height: h });
      await demo(page);
      const mailboxId = await seedOld(page, `r46empty${kind}`, 4);
      await emptyImportant(page);
      await page.goto(`/app/mail?mailbox=${mailboxId}`);
      await expect(page.getByText("Nothing in this tab")).toBeVisible({ timeout: 20_000 });
      const open = page.getByRole("button", { name: "Archive older" });
      await expect(open).toBeVisible();
      await open.click();
      const sheet = page.getByRole("dialog", { name: "Archive older mail" });
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("every Inbox tab");
      await sheet.getByText("1 year").click();
      await expect(sheet.getByTestId("archive-older-count")).toHaveText(/\d+ emails? moves? to Archive, counted across every Inbox tab/, { timeout: 10_000 });
    });
  }
});

const SPRINT = { id: "r46_sprint", name: "Sprint 46", status: "planned", goal: null, startAt: "2026-10-26T00:00:00.000Z", endAt: "2026-11-08T23:59:59.000Z", carriedOver: 0 };
const SPRINT_B = { ...SPRINT, id: "r46_sprint_b", name: "Sprint 47" };
const N = 400;
async function backlog(page: Page) {
  const moved: { to: string; ids: string[] }[] = [];
  await page.route(/\/api\/sprints\?/, (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { sprints: [SPRINT, SPRINT_B], unit: "points" } }) : route.fallback());
  await page.route(/\/api\/sprints\/r46_sprint(_b)?(\?.*)?$/, (route) => route.fulfill({ json: { sprint: route.request().url().includes("_b") ? SPRINT_B : SPRINT, unit: "points", tasks: [],
    burndown: { unit: "points", timeZone: "UTC", start: 0, days: [], scope: 0, done: 0, remaining: 0 } } }));
  await page.route(/\/api\/sprints\/(r46_sprint(_b)?)\/tasks$/, async (route) => {
    moved.push({ to: route.request().url().split("/").at(-2)!, ids: (route.request().postDataJSON() as { taskIds: string[] }).taskIds });
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/sprints\/backlog\?/, async (route) => {
    const res = await route.fetch();
    const body = await res.json().catch(() => null) as { tasks: Record<string, unknown>[] } | null;
    if (!body) return route.fallback().catch(() => {});
    const b = body.tasks[0] ?? { status: "todo", statusName: "To do", type: "task" };
    const tasks = Array.from({ length: N }, (_, i) => ({ ...b, id: `r46b_${i}`, ref: `B-${i + 1}`, number: i + 1, title: `Backlog task ${i + 1}`, points: (i % 3) + 1, status: "todo", position: i }));
    await route.fulfill({ response: res, json: { ...body, tasks } });
  });
  return moved;
}
async function openBacklog(page: Page) {
  await demo(page);
  const moved = await backlog(page);
  await page.goto("/app/tasks?view=sprints");
  const panel = page.locator("[aria-label=Backlog]").first();
  await expect(panel.getByText("Backlog task 1", { exact: true })).toBeVisible({ timeout: 60_000 });
  return { panel, moved };
}
async function pick3(page: Page, panel: ReturnType<Page["locator"]>) {
  await panel.getByRole("checkbox", { name: "Select Backlog task 2", exact: true }).focus();
  for (let i = 0; i < 2; i++) await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByRole("toolbar", { name: "Selected backlog tasks" }).getByText(/^3 selected/)).toBeVisible();
}
/** Children of the element sit on one line: same top within 4 px. */
async function oneRow(page: Page, sel: string) {
  return page.locator(sel).first().evaluate((el) => {
    // Status and dates under the sprint picker may wrap to their own line by design (data-header-meta).
    const kids = [...el.children].filter((c) => !c.hasAttribute("data-header-meta") && (c as HTMLElement).offsetParent !== null && c.getBoundingClientRect().width > 4 && c.getBoundingClientRect().height > 4
      && getComputedStyle(c).opacity !== "0" && !["absolute", "fixed"].includes(getComputedStyle(c).position));
    const tops = kids.map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2));
    const ok = tops.length > 0 && Math.max(...tops) - Math.min(...tops) <= 4;
    if (!ok) throw new Error(`not one row: ${JSON.stringify(kids.map((c) => [c.tagName, c.className.slice(0, 50), Math.round(c.getBoundingClientRect().top), Math.round(c.getBoundingClientRect().height)]))}`);
    return ok;
  });
}

for (const width of [390, 360] as const) {
  test(`phone ${width}: sprint header and backlog bars stay on one row, the selection bar sits at the foot and moves`, async ({ page }) => {
    test.skip(!!SHOTS, "behaviour, not shots");
    await page.setViewportSize({ width, height: 844 });
    const { panel, moved } = await openBacklog(page);
    expect(await oneRow(page, "[data-testid=sprint-header-row]")).toBeTruthy();
    expect(await oneRow(page, "[data-testid=backlog-header]")).toBeTruthy();
    await pick3(page, panel);
    const bar = page.getByRole("toolbar", { name: "Selected backlog tasks" });
    await page.waitForTimeout(400); // the bar's 150 ms entrance scale has settled
    expect(await oneRow(page, "[data-testid=backlog-selection-bar]")).toBeTruthy();
    const box = (await bar.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(844 - 120);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    for (const b of await bar.getByRole("button").all()) expect(((await b.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await bar.getByRole("button", { name: /Move 3 to Sprint 46/ }).click();
    await expect.poll(() => moved.at(-1)).toEqual({ to: "r46_sprint", ids: ["r46b_1", "r46b_2", "r46b_3"] });
    await expect(bar).toHaveCount(0);
  });
}

test("desktop: header overflow holds Edit and Plan sprint, selection bar stays in the card, Clear works", async ({ page }) => {
  test.skip(!!SHOTS, "behaviour, not shots");
  await page.setViewportSize({ width: 1280, height: 800 });
  const { panel } = await openBacklog(page);
  await expect(page.getByRole("button", { name: "Start sprint" })).toBeVisible();
  await pick3(page, panel);
  const bar = page.getByRole("toolbar", { name: "Selected backlog tasks" });
  const pbox = (await panel.boundingBox())!;
  const bbox = (await bar.boundingBox())!;
  expect(bbox.x).toBeGreaterThanOrEqual(pbox.x - 1);
  expect(bbox.x + bbox.width).toBeLessThanOrEqual(pbox.x + pbox.width + 1);
  await bar.getByRole("button", { name: /Clear selection/ }).click();
  await expect(bar).toHaveCount(0);
});

for (const width of [390, 360] as const) {
  test(`phone ${width}: the board header is two tidy rows and the project actions sit in one More menu`, async ({ page }) => {
    test.skip(!!SHOTS, "behaviour, not shots");
    await page.setViewportSize({ width, height: 844 });
    await demo(page);
    await page.goto("/app/tasks?view=board");
    await expect(page.getByTestId("board")).toBeVisible({ timeout: 30_000 });
    const header = page.getByTestId("tasks-header");
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(110);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.getByRole("button", { name: "Project actions" }).click();
    for (const name of ["Project settings", "Fields", "Guests", "Epics", "New project"]) await expect(page.getByRole("menuitem", { name })).toBeVisible();
    await page.getByRole("menuitem", { name: "Fields" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`shots: sprint header and backlog with 3 selected, desktop and phone (${scheme})`, async ({ page }) => {
    test.skip(!SHOTS, "screenshots only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript((t) => { try { localStorage.setItem("multies-theme", t); } catch { /* private mode */ } }, scheme);
    for (const [w, h, kind] of [[1280, 800, "desktop"], [390, 844, "phone"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.context().clearCookies();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const { panel } = await openBacklog(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${DIR}/backlog-${SHOTS}-header-${kind}-${scheme}.png` });
      await pick3(page, panel);
      await page.evaluate(() => (document.querySelector("[aria-label=Backlog]") as HTMLElement).scrollIntoView({ block: "start" }));
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${DIR}/backlog-${SHOTS}-select3-${kind}-${scheme}.png` });
    }
    // The board header, desktop and phone.
    for (const [w, h, kind] of [[1280, 800, "desktop"], [390, 844, "phone"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/app/tasks?view=board");
      await expect(page.getByTestId("board")).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/board-${SHOTS}-header-${kind}-${scheme}.png` });
    }
    // The empty Important tab with old Inbox mail, phone width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.context().clearCookies();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await demo(page);
    const mailboxId = await seedOld(page, `r46shot${scheme}`, 3);
    await emptyImportant(page);
    await page.goto(`/app/mail?mailbox=${mailboxId}`);
    await expect(page.getByRole("heading", { level: 2, name: /Inbox zero|Nothing in this tab/ })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${DIR}/mail-${SHOTS}-empty-tab-archive-older-phone-${scheme}.png` });
  });
}

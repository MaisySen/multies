import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * R37: every keyboard shortcut the ? sheet lists, pressed for real. Global keys and every G then key,
 * the mail list and open message keys (checked against the server where the key changes state), the
 * notifications keys, the Triage keys and the task list keys. Keys that only work inside an editor (chat Enter
 * and Shift+Enter, doc slash, checklist Alt+Up and Enter, comment Cmd+Enter, saved reply Tab) and the meeting
 * pre-join Enter have their own specs (chat, docs, tasks, comments, saved replies and meeting lobby e2e).
 */
const SHOTS = "/home/user/tab/files/multies-r37";
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.37.${test.info().workerIndex % 200}.${++visitor}` });
});
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function demo(page: Page) {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
/**
 * R44: a real ready signal instead of network idle. Mail keeps one live heartbeat open (POST /api/connections/live, a
 * long poll of up to 25 s, sent again the moment it answers; src/web/lib/live-mail.ts), so the network is never idle
 * there and waitForLoadState("networkidle"), which has no timeout of its own, waited until the 420 s test timeout. The
 * page itself was idle the whole time (renderer under 2% CPU); the error then surfaced at the next blur() on a closed page.
 * Ready means loaded, no skeleton left, and two frames for layout to settle (as phone-r25 does since R42).
 */
async function settled(page: Page) {
  await page.waitForLoadState("load");
  await expect(page.locator(".skeleton")).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}
/** Click a neutral spot so keys go to the page, not an input. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  const h1 = page.locator("main h1").first();
  if (await h1.isVisible().catch(() => false)) await h1.click({ timeout: 3_000 }).catch(() => null);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}

const GO: [string, RegExp][] = [
  ["w", /\/app\/my-work/], ["o", /\/app\/?(\?|$)/], ["n", /\/app\/notifications/], ["i", /\/app\/mail/],
  ["u", /\/app\/inbox/], ["c", /\/app\/chat/], ["t", /\/app\/tasks/], ["d", /\/app\/docs/], ["m", /\/app\/meetings/],
  ["p", /\/app\/contacts/], ["a", /\/app\/agents/], ["r", /\/app\/triage/], ["s", /\/app\/settings/],
];

test("global keys: Cmd+K, ?, Esc and every G then key", async ({ page }) => {
  test.setTimeout(240_000);
  await demo(page);
  await page.goto("/app/my-work");
  await settled(page);
  for (const [key, url] of GO) {
    await blur(page);
    await page.keyboard.press("g");
    await page.keyboard.press(key);
    await expect(page, `G then ${key.toUpperCase()}`).toHaveURL(url, { timeout: 15_000 });
    await settled(page);
  }
  await page.goto("/app/my-work");
  await blur(page);
  const palette = page.getByRole("dialog", { name: "Command menu" });
  // The menu's key handler mounts with the app shell; press again until it is in place (as search-r20 does).
  await expect(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press(`${mod}+k`);
    await expect(palette).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await blur(page);
  await page.keyboard.press("?");
  const sheet = page.getByTestId("shortcuts-sheet");
  await expect(sheet).toBeVisible();
  for (const group of ["General", "Go to", "Mail", "Tasks"]) await expect(sheet.getByRole("region", { name: group })).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/keys-after-sheet-desktop-light.png` });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

type Msg = { id: string; isStarred?: boolean; isRead?: boolean; folder?: string };
async function message(page: Page, id: string): Promise<Msg> {
  return (await (await page.request.get(`/api/mail/messages/${id}`)).json()).message;
}

test("mail keys: J K C / and, on an open message, S U R A F T X H # Esc and Cmd+Z", async ({ page }) => {
  test.setTimeout(420_000);
  await demo(page);
  await page.goto("/app/mail");
  const first = page.getByText("Launch checklist for Friday").first();
  // A loaded box can take a while to build the mail page the first time; reload once if it is still blank.
  if (!(await first.isVisible({ timeout: 45_000 }).catch(() => false))) await page.reload();
  await expect(first).toBeVisible({ timeout: 60_000 });
  await settled(page);

  // C opens Compose; Esc closes it.
  await blur(page);
  await page.keyboard.press("c");
  const compose = page.getByRole("dialog", { name: "New message" });
  await expect(compose).toBeVisible();
  await page.keyboard.press("Escape");
  await compose.getByRole("button", { name: /close|discard/i }).first().click({ timeout: 3_000 }).catch(() => null);

  // / focuses search.
  await blur(page);
  await page.keyboard.press("/");
  await expect(page.getByRole("textbox", { name: "Search mail" })).toBeFocused();
  await page.keyboard.press("Escape");

  // J opens the next conversation in the list and K goes back.
  await blur(page);
  await page.keyboard.press("j");
  await expect(page).toHaveURL(/[?&]m=/, { timeout: 10_000 });
  const a = new URL(page.url()).searchParams.get("m");
  await page.keyboard.press("j");
  await expect.poll(() => new URL(page.url()).searchParams.get("m")).not.toBe(a);
  await page.keyboard.press("k");
  await expect.poll(() => new URL(page.url()).searchParams.get("m")).toBe(a);

  // Open the known message.
  await first.click();
  await expect(page.getByRole("heading", { name: "Launch checklist for Friday", level: 1 })).toBeVisible({ timeout: 15_000 });
  await settled(page);
  const id = new URL(page.url()).searchParams.get("m")!;
  const before = await message(page, id);

  await blur(page);
  await page.keyboard.press("s");
  await expect.poll(async () => (await message(page, id)).isStarred, { timeout: 10_000 }).toBe(!before.isStarred);
  // The key reads the star from the list, which refetches after the change; a person never presses twice inside it.
  await page.waitForTimeout(1500);
  await page.keyboard.press("s");
  await expect.poll(async () => (await message(page, id)).isStarred, { timeout: 10_000 }).toBe(!!before.isStarred);

  // U flips read and unread (reading the message back over the API marks it read, so the toast is the check).
  await page.keyboard.press("u");
  await expect(page.getByText("Marked unread").first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("u");
  await expect(page.getByText("Marked read").first()).toBeVisible({ timeout: 10_000 });

  for (const [key, label] of [["r", /reply|send/i], ["a", /reply|send/i], ["f", /forward|send/i]] as const) {
    await blur(page);
    await page.keyboard.press(key);
    const box = page.getByRole("dialog", { name: "New message" });
    await expect(box, `key ${key}`).toBeVisible({ timeout: 10_000 });
    await expect(box.getByRole("button", { name: label }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await box.getByRole("button", { name: /close|discard/i }).first().click({ timeout: 3_000 }).catch(() => null);
    await expect(box).toBeHidden({ timeout: 10_000 });
  }

  // T makes a task from the open email: a toast names it and the task chip shows on the message.
  await blur(page);
  await page.keyboard.press("t");
  await expect(page.getByText(/ created$/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("linked-task").first()).toBeVisible({ timeout: 15_000 });

  // X selects the conversation; H then opens the snooze menu for the selection; Esc clears it.
  await blur(page);
  await page.keyboard.press("x");
  await expect(page.getByTestId("mail-select").first()).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
  await page.keyboard.press("h");
  await expect(page.getByRole("menu", { name: "Snooze until" })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await blur(page);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="mail-select"][aria-checked="true"]')).toHaveCount(0, { timeout: 10_000 });

  // # moves it to the trash and Cmd+Z brings it back.
  await first.click();
  await expect(page.getByRole("heading", { name: "Launch checklist for Friday", level: 1 })).toBeVisible({ timeout: 15_000 });
  await blur(page);
  await page.keyboard.press("#");
  await expect.poll(async () => (await message(page, id)).folder, { timeout: 15_000 }).toBe("trash");
  await blur(page);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(async () => (await message(page, id)).folder, { timeout: 15_000 }).not.toBe("trash");

  // E archives the open message and Cmd+Z undoes that too.
  await page.goto(`/app/mail?m=${id}`);
  await expect(page.getByRole("heading", { name: "Launch checklist for Friday", level: 1 })).toBeVisible({ timeout: 30_000 });
  const folderBefore = (await message(page, id)).folder;
  await blur(page);
  await page.keyboard.press("e");
  await expect.poll(async () => (await message(page, id)).folder, { timeout: 15_000 }).toBe("archive");
  await blur(page);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(async () => (await message(page, id)).folder, { timeout: 15_000 }).toBe(folderBefore);
});

test("mail list keys: Shift+X, Cmd+A, Esc and Tab or Shift+Tab between Inbox splits", async ({ page }) => {
  test.setTimeout(300_000);
  await demo(page);
  await page.goto("/app/mail");
  const rows = page.getByTestId("mail-select");
  if (!(await rows.first().isVisible({ timeout: 45_000 }).catch(() => false))) await page.reload();
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  const checked = page.locator('[data-testid="mail-select"][aria-checked="true"]');

  // J puts the cursor on a row; Shift+X selects it.
  await blur(page);
  await page.keyboard.press("j");
  await expect(page).toHaveURL(/[?&]m=/, { timeout: 10_000 });
  await blur(page);
  await page.keyboard.press("Shift+X");
  await expect(checked).not.toHaveCount(0, { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(checked).toHaveCount(0, { timeout: 10_000 });

  // Cmd+A selects every conversation in the list; Esc clears it.
  await page.goto("/app/mail");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const total = await rows.count();
  await blur(page);
  await page.keyboard.press(`${mod}+a`);
  await expect(checked).toHaveCount(total, { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(checked).toHaveCount(0, { timeout: 10_000 });

  // Tab and Shift+Tab step through the Inbox splits when the list has focus.
  const tabs = page.getByTestId("split-tabs").getByRole("tab");
  if ((await tabs.count()) < 2) {
    test.info().annotations.push({ type: "note", description: "fewer than two Inbox splits, Tab not pressed" });
    return;
  }
  const selected = () => page.getByTestId("split-tabs").getByRole("tab", { selected: true }).textContent();
  const start = await selected();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press("Tab");
  await expect.poll(selected, { timeout: 10_000 }).not.toBe(start);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press("Shift+Tab");
  await expect.poll(selected, { timeout: 10_000 }).toBe(start);
});

test("task keys: J K, then S A P L D open their pickers, Shift+L folds board lanes", async ({ page }) => {
  test.setTimeout(300_000);
  await demo(page);
  const projects = (await (await page.request.get("/api/projects")).json()).projects as { id: string }[];
  const project = projects[0];
  await page.goto(`/app/tasks?project=${project.id}&view=list`);
  const rows = page.locator("[data-task-id]");
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  await blur(page);
  await page.keyboard.press("j");
  await expect(page.locator("[data-task-id][data-kb-focus]")).toHaveCount(1);
  const firstId = await page.locator("[data-task-id][data-kb-focus]").getAttribute("data-task-id");
  await page.keyboard.press("j");
  await expect.poll(() => page.locator("[data-task-id][data-kb-focus]").getAttribute("data-task-id")).not.toBe(firstId);
  await page.keyboard.press("k");
  await expect.poll(() => page.locator("[data-task-id][data-kb-focus]").getAttribute("data-task-id")).toBe(firstId);
  for (const key of ["s", "a", "p", "l", "d"]) {
    await page.keyboard.press(key);
    await expect(page.getByTestId("palette-picker"), `key ${key}`).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-picker")).toBeHidden();
  }

  // Shift+L folds every swimlane on the board, and pressing it again opens them.
  await page.goto(`/app/tasks?project=${project.id}&view=board&lanes=assignee`);
  const toggles = page.getByTestId("lane-toggle");
  if (!(await toggles.first().isVisible({ timeout: 30_000 }).catch(() => false))) {
    test.info().annotations.push({ type: "note", description: "this board shows no swimlanes, Shift+L not pressed" });
    return;
  }
  await blur(page);
  await page.keyboard.press("Shift+L");
  await expect(page.locator('[data-testid="lane-toggle"][aria-expanded="true"]')).toHaveCount(0, { timeout: 10_000 });
  await blur(page);
  await page.keyboard.press("Shift+L");
  await expect(page.locator('[data-testid="lane-toggle"][aria-expanded="false"]')).toHaveCount(0, { timeout: 10_000 });
});

test("notification keys: J K U H E Shift+E and O", async ({ page }) => {
  test.setTimeout(300_000);
  await demo(page);
  // R45: the test seeds its own three notifications (rows for the signed in person, pointing at real tasks) instead of
  // skipping when the demo happens to have fewer than two. Written straight into the local e2e database.
  await seedNotifications(page, 3);
  await page.goto("/app/notifications");
  const rows = page.getByTestId("notification-row");
  await expect(page.getByTestId("notifications-list")).toBeVisible({ timeout: 60_000 });
  await settled(page);
  await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  const current = page.locator('[data-testid="notification-row"][aria-current="true"]');
  await blur(page);
  await page.keyboard.press("j");
  await expect(current).toHaveCount(1);
  const a = await current.getAttribute("data-id");
  await page.keyboard.press("j");
  await expect.poll(() => current.getAttribute("data-id")).not.toBe(a);
  await page.keyboard.press("k");
  await expect.poll(() => current.getAttribute("data-id")).toBe(a);
  // U flips read on the focused row (the server's list is the check).
  const readOf = async () => ((await (await page.request.get("/api/notifications?view=inbox&limit=100")).json()).notifications as { id: string; read: boolean }[]).find((x) => x.id === a)?.read;
  const r0 = await readOf();
  await page.keyboard.press("u");
  await expect.poll(readOf, { timeout: 10_000 }).toBe(!r0);
  await page.keyboard.press("u");
  await expect.poll(readOf, { timeout: 10_000 }).toBe(r0);
  // H opens the snooze menu; Esc closes it.
  await page.keyboard.press("h");
  await expect(page.getByTestId("snooze-menu")).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("snooze-menu")).toBeHidden();
  // E marks the focused one done and it leaves the list; Shift+E brings it back.
  // R44: checked by the row's id, not the list's length. The demo keeps adding notifications while the test runs (its
  // seed lands in parts, and every refetch can bring a new one), so "n - 1" and "n" from a count taken earlier flaked.
  await blur(page);
  const gone = await current.getAttribute("data-id");
  const row = page.locator(`[data-testid="notification-row"][data-id="${gone}"]`);
  await page.keyboard.press("e");
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  // Shift+E undoes the last done once the server has taken it (the toast says so).
  await expect(page.getByText("Marked done").first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Shift+E");
  await expect(page.getByText("Back in the inbox").first()).toBeVisible({ timeout: 10_000 });
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  // O opens the focused notification (it leaves the notifications page).
  await blur(page);
  await page.keyboard.press("j");
  await expect(current).toHaveCount(1);
  await page.keyboard.press("o");
  await expect(page).not.toHaveURL(/\/app\/notifications(\?|$)/, { timeout: 15_000 });
});

test("triage keys: J K, then A D H M open their bars and dialogs, O opens the task", async ({ page }) => {
  test.setTimeout(300_000);
  await demo(page);
  await page.goto("/app/triage");
  const rows = page.getByTestId("triage-row");
  // R38: the demo seeds three requests into Triage (form, mail, api), so these keys are always pressed for real.
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  const current = page.locator('[data-testid="triage-row"][aria-current="true"]');
  await blur(page);
  if ((await rows.count()) > 1) {
    const a = await current.textContent();
    await page.keyboard.press("j");
    await expect.poll(() => current.textContent()).not.toBe(a);
    await page.keyboard.press("k");
    await expect.poll(() => current.textContent()).toBe(a);
  }
  // A and D open the comment bar (accept or decline with a note); Esc or Cancel closes it.
  for (const key of ["a", "d"]) {
    await blur(page);
    await page.keyboard.press(key);
    const bar = page.getByRole("button", { name: /cancel/i }).first();
    await expect(bar, `key ${key}`).toBeVisible({ timeout: 10_000 });
    await bar.click();
    await expect(bar).toBeHidden({ timeout: 10_000 });
  }
  // H opens snooze and M opens merge as a duplicate; both are dialogs.
  for (const key of ["h", "m"]) {
    await blur(page);
    await page.keyboard.press(key);
    const dialog = page.getByRole("dialog").first();
    await expect(dialog, `key ${key}`).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  }
  await blur(page);
  await page.keyboard.press("o");
  await expect(page).toHaveURL(/\/app\/tasks\?task=/, { timeout: 15_000 });
});

test("timeline key: Shift+D opens the date clashes sheet", async ({ page }) => {
  test.setTimeout(240_000);
  await demo(page);
  const projects = (await (await page.request.get("/api/projects")).json()).projects as { id: string }[];
  await page.goto(`/app/tasks?view=timeline&project=${projects[0].id}`);
  await expect(page.getByTestId("schedule-clash-pill").or(page.getByTestId("schedule-ok-pill")).first()).toBeVisible({ timeout: 60_000 });
  await blur(page);
  await page.keyboard.press("Shift+D");
  const sheet = page.getByRole("dialog").first();
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden({ timeout: 10_000 });
});

/** R45: inserts `count` unread notifications for the signed in person, each pointing at one of their workspace's tasks. */
async function seedNotifications(page: Page, count: number) {
  const me = (await (await page.request.get("/api/account/me")).json()) as { user: { id: string }; organization: { id: string } };
  const res = await page.request.get("/api/tasks");
  const tasks = (((await res.json()) as { tasks?: { id: string; title: string }[] }).tasks ?? []).slice(0, 5);
  expect(tasks.length, `the demo workspace has tasks to point at (GET /api/tasks ${res.status()})`).toBeGreaterThan(0);
  const db = new Database(path.resolve(".data/e2e.db"), { fileMustExist: true, timeout: 10_000 });
  try {
    const insert = db.prepare("insert into notifications (id, org_id, user_id, type, entity_type, entity_id, title, actor_name, created_at) values (?, ?, ?, 'task.mentioned', 'task', ?, ?, 'Test seed', ?)");
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const t = tasks[i % tasks.length];
      insert.run(`ntf_e2eseed${now.toString(36)}${i}`, me.organization.id, me.user.id, t.id, `Test seed mentioned you on ${t.title}`, now - i * 1000);
    }
  } finally { db.close(); }
}

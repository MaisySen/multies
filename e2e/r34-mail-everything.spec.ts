import path from "node:path";
import Database from "better-sqlite3";
import { test, expect, type Page } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R34: snooze over everything runs as the same server job, a big job asks first (count, place, action; Esc cancels,
 * Enter confirms), and Undo clears the snooze so every thread is back in Inbox.
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
type Item = { id: string };
async function list(page: Page, mailboxId: string, extra: string) {
  const out: Item[] = [];
  let cursor = "";
  for (let i = 0; i < 40; i++) {
    const r = await (await page.request.get(`/api/mail/messages?mailboxId=${mailboxId}&${extra}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
    out.push(...r.messages);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

test("select everything, snooze asks first, Esc cancels, Enter runs the job, Undo brings every thread back", async ({ page }) => {
  test.setTimeout(300_000);
  await demo(page);
  const overview = await (await page.request.get("/api/mail/overview")).json();
  const mb = [...overview.mailboxes].sort((a, b) => (b.folders.inbox?.total ?? 0) - (a.folders.inbox?.total ?? 0))[0] as { id: string };
  // 600 Inbox messages (over the 500 that asks first), straight into the local E2E database.
  const db = new Database(path.resolve(".data/e2e.db"), { fileMustExist: true });
  const orgId = (db.prepare("select org_id from mailboxes where id = ?").get(mb.id) as { org_id: string }).org_id;
  const now = Date.now();
  const ins = db.prepare("insert into messages (id, org_id, mailbox_id, folder, thread_id, from_address, from_name, subject, snippet, date, created_at) values (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < 600; i++) ins.run(`msg_r34snz_${i}`, orgId, mb.id, `thr_r34snz_${i}`, `sender${i}@r34-snooze.test`, `Sender ${i}`, `Snooze note ${i}`, "Seeded for the snooze test", now - 3_600_000 - i * 1000, now - 60_000);
  })();
  db.close();
  const seeded = (await list(page, mb.id, "folder=inbox&split=other")).filter((m) => m.id.startsWith("msg_r34snz_"));
  const split = seeded.length === 600 ? "other" : "important";
  const before = (await list(page, mb.id, `folder=inbox&split=${split}`)).length;
  expect(before).toBeGreaterThan(500);

  await page.goto(`/app/mail?mailbox=${mb.id}${split === "other" ? "&split=other" : ""}`);
  const rows = page.getByTestId("mail-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByTestId("bulk-select-everything").click();
  await expect(page.getByTestId("bulk-count")).toContainText("All");

  // Archive asks first; Esc cancels and nothing moves.
  await page.keyboard.press("e");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/Archive every message in .*\?|Archive [\d,]+ messages/);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect((await list(page, mb.id, `folder=inbox&split=${split}`)).length).toBe(before);

  // Snooze until tomorrow: the confirm names the action and the time; Enter runs it.
  if (!(await page.getByTestId("bulk-select-everything").isVisible()) && !(await page.getByTestId("bulk-count").textContent())?.includes("All")) {
    await page.keyboard.press("ControlOrMeta+a");
    await page.getByTestId("bulk-select-everything").click();
  }
  await expect(page.getByTestId("bulk-count")).toContainText("All");
  await page.getByTestId("bulk-bar").getByRole("button", { name: "Snooze", exact: true }).click();
  await page.getByRole("menuitem", { name: "Tomorrow" }).click();
  await expect(dialog).toContainText(/Snooze .* until tomorrow\?/);
  await expect(dialog).toContainText("You can undo it.");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r34/mail-everything-confirm.png` });
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Snoozed [\d,]+ conversations/)).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await list(page, mb.id, `folder=inbox&split=${split}`)).filter((m) => m.id.startsWith("msg_r34snz_")).length, { timeout: 60_000 }).toBe(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone")).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await list(page, mb.id, `folder=inbox&split=${split}`)).length, { timeout: 60_000 }).toBe(before);
});

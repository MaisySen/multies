import path from "node:path";
import Database from "better-sqlite3";
import { test, expect, type Page } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R33: "select all" past what is loaded runs as ONE server job. Select every row (Cmd/Ctrl+A), then "Select all ...",
 * untick one, archive with E: every matching conversation moves except the unticked one and a message that arrived
 * after the person looked. The toast says Archived, Undo brings everything back (Undoing..., then Undone).
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
type Item = { id: string; subject: string; folder: string };
async function list(page: Page, mailboxId: string, extra: string) {
  const out: Item[] = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const r = await (await page.request.get(`/api/mail/messages?mailboxId=${mailboxId}&${extra}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
    out.push(...r.messages);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

test("select all across pages archives as one job, leaves a mid job arrival and an unticked row, and Undo restores", async ({ page }) => {
  test.setTimeout(240_000);
  await demo(page);
  const overview = await (await page.request.get("/api/mail/overview")).json();
  const mb = [...overview.mailboxes].sort((a, b) => (b.folders.inbox?.total ?? 0) - (a.folders.inbox?.total ?? 0))[0] as { id: string };

  // 120 more Inbox messages (the list loads 50 at a time), written straight into the local E2E database.
  const db = new Database(path.resolve(".data/e2e.db"), { fileMustExist: true });
  const orgId = (db.prepare("select org_id from mailboxes where id = ?").get(mb.id) as { org_id: string }).org_id;
  const now = Date.now();
  const ins = db.prepare("insert into messages (id, org_id, mailbox_id, folder, thread_id, from_address, from_name, subject, snippet, date, created_at) values (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < 120; i++) ins.run(`msg_r33bulk_${i}`, orgId, mb.id, `thr_r33bulk_${i}`, `sender${i}@r33-bulk.test`, `Sender ${i}`, `Bulk note ${i}`, "Seeded for the select all test", now - 3_600_000 - i * 1000, now - 60_000);
  })();
  const seeded = (await list(page, mb.id, "folder=inbox&split=other")).filter((m) => m.id.startsWith("msg_r33bulk_"));
  const split = seeded.length === 120 ? "other" : "important";
  const view = await list(page, mb.id, `folder=inbox&split=${split}`);
  expect(view.length).toBeGreaterThan(50);

  await page.goto(`/app/mail?mailbox=${mb.id}${split === "other" ? "&split=other" : ""}`);
  const rows = page.getByTestId("mail-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const loaded = await rows.count();
  expect(loaded).toBeLessThan(view.length);

  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByTestId("bulk-count")).toHaveText(`${loaded} selected`);
  await page.getByTestId("bulk-select-everything").click();
  await expect(page.getByTestId("bulk-count")).toContainText("All");
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r33/mail-select-all-bar.png` });
  // Untick the first row: the job leaves it alone.
  const keep = view[0].id;
  await rows.nth(0).getByTestId("mail-select").click();

  // Mail that lands after the person looked (newer than anything they saw), sorted far down the list.
  db.prepare("insert into messages (id, org_id, mailbox_id, folder, thread_id, from_address, from_name, subject, snippet, date, created_at) values ('msg_r33bulk_late', ?, ?, 'inbox', 'thr_r33bulk_late', 'late@r33-bulk.test', 'Late', 'Arrived mid job', 'Late', ?, ?)")
    .run(orgId, mb.id, now - 90_000_000, Date.now() + 5_000);
  db.close();

  await page.keyboard.press("e");
  // R34: a job whose total isn't known up front (more pages) asks first.
  await page.getByTestId("bulk-job-confirm").click();
  await expect(page.getByText(/Archived [\d,]+ conversations/)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500); // the toast's fade in
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r33/mail-select-all-toast.png` });
  await expect.poll(async () => (await list(page, mb.id, `folder=inbox&split=${split}`)).map((m) => m.id).sort(), { timeout: 30_000 })
    .toEqual([keep, ...(split === "other" ? ["msg_r33bulk_late"] : [])].sort());
  const archived = (await list(page, mb.id, "folder=archive")).map((m) => m.id);
  expect(archived.filter((id) => id.startsWith("msg_r33bulk_")).length).toBe(view.filter((m) => m.id.startsWith("msg_r33bulk_") && m.id !== keep).length);
  expect(archived).not.toContain("msg_r33bulk_late");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await list(page, mb.id, `folder=inbox&split=${split}`)).length, { timeout: 30_000 }).toBe(view.length + (split === "other" ? 1 : 0));
});

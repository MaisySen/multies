import path from "node:path";
import Database from "better-sqlite3";
import { test, expect, type Page } from "@playwright/test";

/**
 * R45 product helper.
 * MB-137: "Archive older mail" from the Inbox header: a sheet with four cuts, a count before it runs, one server job
 * with progress in the toast, one Undo. Keyboard only, and at phone width.
 * MB-203: the page draws its own shell (boot.js) before the app code runs.
 * MB-216: the New API key name field has a label (found by role and label).
 */
const SHOTS = process.env.SHOTS_DIR;
async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function seedOld(page: Page, tag: string, n: number) {
  const overview = await (await page.request.get("/api/mail/overview")).json();
  const mb = [...overview.mailboxes].sort((a, b) => (b.folders.inbox?.total ?? 0) - (a.folders.inbox?.total ?? 0))[0] as { id: string };
  const db = new Database(path.resolve(".data/e2e.db"), { fileMustExist: true });
  const orgId = (db.prepare("select org_id from mailboxes where id = ?").get(mb.id) as { org_id: string }).org_id;
  const now = Date.now();
  const ins = db.prepare("insert into messages (id, org_id, mailbox_id, folder, thread_id, from_address, from_name, subject, snippet, date, created_at) values (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(`msg_${tag}_${i}`, orgId, mb.id, `thr_${tag}_${i}`, `old${i}@r45-older.test`, `Old sender ${i}`, `Old note ${i}`, "Seeded for archive older", now - 400 * 86_400_000 - i * 1000, now - 60_000);
  })();
  db.close();
  return mb.id;
}
async function inInbox(page: Page, mailboxId: string, tag: string) {
  let count = 0;
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const r = await (await page.request.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
    count += (r.messages as { id: string }[]).filter((m) => m.id.startsWith(`msg_${tag}_`)).length;
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return count;
}

test.describe("Archive older mail (MB-137)", () => {
  test.use({ viewport: { width: 1280, height: 860 } });
  test("keyboard: open the sheet, pick 1 year, see the count, archive, then one Undo puts it back", async ({ page }) => {
    test.setTimeout(180_000);
    await demo(page);
    const mailboxId = await seedOld(page, "r45old", 6);
    await page.goto(`/app/mail?mailbox=${mailboxId}`);
    const open = page.getByRole("button", { name: "Archive older", exact: true });
    await expect(open).toBeVisible({ timeout: 20_000 });
    await open.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Archive older mail" });
    await expect(sheet).toBeVisible();
    // The cuts are a radio group: arrow keys move between them.
    await sheet.getByRole("radio", { name: /1 month/ }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(sheet.getByRole("radio", { name: /1 year/ })).toBeChecked();
    const count = sheet.getByTestId("archive-older-count");
    await expect(count).toHaveText(/6 emails move to Archive/, { timeout: 10_000 });
    await page.waitForTimeout(400);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/archive-after-sheet-desktop-light.png` });
    const run = sheet.getByRole("button", { name: "Archive 6" });
    await run.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/Archived 6/)).toBeVisible({ timeout: 20_000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/archive-after-done-desktop-light.png` });
    await expect.poll(() => inInbox(page, mailboxId, "r45old"), { timeout: 20_000 }).toBe(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => inInbox(page, mailboxId, "r45old"), { timeout: 30_000 }).toBe(6);
  });
});

test.describe("Archive older mail at phone width (MB-137)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  for (const theme of ["light", "dark"] as const) {
    test(`the sheet fits a phone (${theme})`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.addInitScript((t) => { try { localStorage.setItem("multies-theme", t); } catch { /* private mode */ } }, theme);
      await demo(page);
      const mailboxId = await seedOld(page, `r45ph${theme}`, 3);
      await page.goto(`/app/mail?mailbox=${mailboxId}`);
      await page.getByRole("button", { name: "Archive older", exact: true }).click({ timeout: 20_000 });
      const sheet = page.getByRole("dialog", { name: "Archive older mail" });
      await expect(sheet).toBeVisible();
      await sheet.getByText("1 year").click();
      await expect(sheet.getByTestId("archive-older-count")).toHaveText(/\d+ emails? moves? to Archive/, { timeout: 10_000 });
      const box = await sheet.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();
      const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= 391);
      expect(noOverflow).toBeTruthy();
      await page.waitForTimeout(300);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/archive-after-sheet-phone-${theme}.png` });
    });
  }
});

test("My Work: the page draws its shell before the app code runs (MB-203)", async ({ page }) => {
  test.setTimeout(90_000);
  await demo(page);
  // Hold the app code back so the shell is what is on screen.
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(/\/assets\/vendor-react-.*\.js$/, async (route) => { await held; await route.continue(); });
  await page.goto("/app/my-work", { waitUntil: "commit" });
  const shell = page.locator("[data-boot-shell]");
  await expect(shell).toBeVisible({ timeout: 10_000 });
  await expect(shell.getByText("My Work", { exact: true })).toBeVisible();
  release();
  await expect(page.getByTestId("mywork-due")).toBeVisible({ timeout: 30_000 });
  await expect(shell).toHaveCount(0);
});

test.describe("My Work return visit (MB-203)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("draws the last stored list at once with an Updating chip while the network read is slow", async ({ page }) => {
    test.setTimeout(90_000);
    await demo(page);
    await page.goto("/app/my-work");
    await expect(page.getByTestId("mywork-due")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800); // the stored copy is written after the read lands
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    await page.route(/\/api\/my-work(\?|$)/, async (route) => { await held; await route.continue(); });
    await page.reload();
    await expect(page.getByTestId("mywork-updating")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("mywork-due")).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mywork-after-updating-phone-light.png` });
    release();
    await expect(page.getByTestId("mywork-updating")).toHaveCount(0, { timeout: 20_000 });
  });
});

test("New API key: the name field is labelled (MB-216)", async ({ page }) => {
  test.setTimeout(90_000);
  await demo(page);
  await page.goto("/app/settings/developers");
  await page.getByRole("button", { name: "Create API key" }).click({ timeout: 20_000 });
  const dialog = page.getByRole("dialog", { name: "New API key" });
  const name = dialog.getByRole("textbox", { name: "Name" });
  await expect(name).toBeVisible();
  await name.fill("Billing service");
  await expect(dialog.getByLabel("Name")).toHaveValue("Billing service");
});

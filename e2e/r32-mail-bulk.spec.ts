import { test, expect, type Page } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R32: mail multi-select and bulk actions with Undo, in a demo workspace. X selects the open row, J moves,
 * E archives the selection and Undo brings it back; Shift+click selects a range; the bar marks read.
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
type Item = { id: string; subject: string; isRead: boolean; folder: string };
async function list(page: Page, mailboxId: string, extra: string) {
  return ((await (await page.request.get(`/api/mail/messages?mailboxId=${mailboxId}&${extra}&limit=100`)).json()).messages) as Item[];
}

test("select with X, archive with E, Undo restores; Shift+click range; bulk mark read", async ({ page }) => {
  test.setTimeout(180_000);
  await demo(page);
  const overview = await (await page.request.get("/api/mail/overview")).json();
  const mb = [...overview.mailboxes].sort((a, b) => (b.folders.inbox?.total ?? 0) - (a.folders.inbox?.total ?? 0))[0] as { id: string };
  // R85: the inbox opens on its first category, Primary (Primary, Updates, Promotions), in place of the older
  // Important and Other split; the rows below are that list.
  const items = await list(page, mb.id, "folder=inbox&split=primary");
  expect(items.length).toBeGreaterThanOrEqual(3);

  await page.goto(`/app/mail?mailbox=${mb.id}`);
  await expect(page.getByRole("tab", { name: /^Primary/ })).toHaveAttribute("aria-selected", "true");
  const rows = page.getByTestId("mail-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(3);
  const n = Math.min(4, count); // the range below: first row to row n

  // X on the open row, J to the next, three times.
  await rows.nth(0).locator("button").nth(1).click();
  await expect(page).toHaveURL(/[?&]m=/);
  await page.locator("body").press("x");
  await page.keyboard.press("j");
  await page.keyboard.press("x");
  await page.keyboard.press("j");
  await page.keyboard.press("x");
  const bar = page.getByTestId("bulk-bar");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("bulk-count")).toHaveText("3 selected");
  await expect(page.locator("[data-testid=mail-row][data-selected]")).toHaveCount(3);
  const picked = items.slice(0, 3).map((m) => m.id);

  // E archives the selection; Undo in the toast puts them back.
  await page.keyboard.press("e");
  await expect(page.getByText("Archived 3 conversations")).toBeVisible();
  await expect(bar).toBeHidden();
  await expect.poll(async () => (await list(page, mb.id, "folder=archive")).filter((m) => picked.includes(m.id)).length, { timeout: 15_000 }).toBe(3);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await list(page, mb.id, "folder=inbox")).filter((m) => picked.includes(m.id)).length, { timeout: 15_000 }).toBe(3);
  await expect(rows).toHaveCount(count, { timeout: 15_000 });

  // Shift+click selects a range from the last toggled row.
  await page.keyboard.press("Escape");
  await rows.nth(0).hover();
  await rows.nth(0).getByTestId("mail-select").click();
  await rows.nth(n - 1).getByTestId("mail-select").click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("bulk-count")).toHaveText(`${n} selected`);
  const range = (await list(page, mb.id, "folder=inbox&split=primary")).slice(0, n).map((m) => m.id);

  // Mark unread, then read, from the bar.
  await bar.getByRole("button", { name: "Mark unread" }).click();
  await expect(page.getByText(`Marked ${n} conversations as unread`)).toBeVisible();
  await expect.poll(async () => (await list(page, mb.id, "folder=inbox")).filter((m) => range.includes(m.id) && !m.isRead).length, { timeout: 15_000 }).toBe(n);
  await rows.nth(0).getByTestId("mail-select").click();
  await rows.nth(n - 1).getByTestId("mail-select").click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("bulk-count")).toHaveText(`${n} selected`);
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r32/mail-bulk-bar.png` });
  await bar.getByRole("button", { name: "Mark read" }).click();
  await expect(page.getByText(`Marked ${n} conversations as read`)).toBeVisible();
  await expect.poll(async () => (await list(page, mb.id, "folder=inbox")).filter((m) => range.includes(m.id) && m.isRead).length, { timeout: 15_000 }).toBe(n);

  // Cmd/Ctrl+A selects every visible row, Escape clears.
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByTestId("bulk-count")).toHaveText(`${count} selected`);
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
});

import { test, expect, type Page } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 20 (R20.3): snooze a thread and watch it come back, and send later from Compose.
 * The test clock (POST /api/mail-schedules/test-clock) runs the cron pass at a chosen time; it works
 * only with DEMO_MODE on and only inside a demo workspace.
 */
async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
const origin = (page: Page) => ({ origin: new URL(page.url()).origin });
async function runClock(page: Page, ms: number) {
  const r = await page.request.post("/api/mail-schedules/test-clock", { data: { now: new Date(Date.now() + ms).toISOString() }, headers: origin(page) });
  expect(r.status()).toBe(200);
  return r.json();
}

test("snooze a thread, see it in Snoozed, and see it come back to the top of Inbox", async ({ page }) => {
  await demo(page);
  const overview = await (await page.request.get("/api/mail/overview")).json();
  const mb = [...overview.mailboxes].sort((a, b) => (b.folders.inbox?.total ?? 0) - (a.folders.inbox?.total ?? 0))[0];
  const list = await (await page.request.get(`/api/mail/messages?mailboxId=${mb.id}&folder=inbox`)).json();
  const target = list.messages.find((m: { subject: string }) => m.subject) ?? list.messages[0];
  expect(target).toBeTruthy();

  await page.goto(`/app/mail?mailbox=${mb.id}&m=${target.id}`);
  await page.getByTestId("snooze-menu").click();
  await page.getByRole("menuitem", { name: /Tomorrow/ }).click();
  await expect(page.getByText(/Snoozed until/)).toBeVisible();

  // Gone from Inbox, listed in Snoozed.
  const folders = page.getByRole("navigation", { name: "Folders" });
  await folders.getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByRole("button", { name: new RegExp(target.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })).toHaveCount(0);
  await folders.getByRole("button", { name: "Snoozed" }).click();
  await expect(page.getByTestId("schedule-row").filter({ hasText: target.subject })).toBeVisible();

  // Two days on: the pass brings it back once, on top, marked.
  const pass = await runClock(page, 2 * 86_400_000);
  expect(pass.returned).toBe(1);
  expect((await runClock(page, 2 * 86_400_000)).returned).toBe(0);
  await page.reload();
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Inbox/ }).click();
  const back = page.getByTestId("returned-row").first();
  await expect(back).toContainText(target.subject);
  await expect(back).toContainText("Snoozed");
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r20/mail-snooze.png` });
  await back.click();
  await expect(page.getByTestId("returned-row")).toHaveCount(0);
});

test("send later from Compose, see it in Scheduled, then it sends", async ({ page }) => {
  await demo(page);
  await page.goto("/app/mail?compose=1");
  const compose = page.getByRole("dialog", { name: "New message" });
  await expect(compose).toBeVisible();
  const subject = `Later ${Date.now()}`;
  await compose.getByLabel("To").fill("someone@example.com");
  await compose.getByLabel("Subject").fill(subject);
  await compose.getByLabel("Message").fill("Sent later by the end to end suite.");
  await compose.getByTestId("send-later").click();
  await page.getByRole("menuitem", { name: /Tomorrow/ }).click();
  await expect(compose).toBeHidden();
  // The undo hold applies to send later too; skip the wait.
  await page.getByTestId("undo-send-toast").getByRole("button", { name: "Send now" }).click();
  await expect(page.getByText(/Scheduled for/)).toBeVisible();

  const folders = page.getByRole("navigation", { name: "Folders" });
  await folders.getByRole("button", { name: "Scheduled" }).click();
  const row = page.getByTestId("schedule-row").filter({ hasText: subject });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Sends");

  const pass = await runClock(page, 2 * 86_400_000);
  expect(pass.sent).toBe(1);
  await page.reload();
  await expect(page.getByTestId("schedule-row").filter({ hasText: subject })).toHaveCount(0);
  await folders.getByRole("button", { name: /^Sent/ }).click();
  await expect(page.getByText(subject).first()).toBeVisible();
});

test("cancel a scheduled send", async ({ page }) => {
  await demo(page);
  const overview = await (await page.request.get("/api/mail/overview")).json();
  const mb = overview.mailboxes[0];
  const subject = `Cancel me ${Date.now()}`;
  const r = await page.request.post("/api/mail-schedules/send", { data: { message: { mailboxId: mb.id, to: ["someone@example.com"], subject, text: "x" }, preset: "tomorrow" }, headers: origin(page) });
  expect(r.status()).toBe(201);
  await page.goto(`/app/mail?mailbox=${mb.id}&folder=scheduled`);
  const row = page.getByTestId("schedule-row").filter({ hasText: subject });
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Scheduled send cancelled")).toBeVisible();
  await expect(row).toHaveCount(0);
  expect((await runClock(page, 2 * 86_400_000)).sent).toBe(0);
});

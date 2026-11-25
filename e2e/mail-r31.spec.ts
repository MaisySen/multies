import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R31: split inbox (Important, Other, a custom split by domain) and read status on sent mail, in a demo
 * workspace. The open image's token is random and never shown in the app, so the test reads it from the
 * local E2E database the way a mail app would find it in the message.
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
const origin = (page: Page) => ({ origin: new URL(page.url()).origin });
type Item = { id: string; subject: string; from: { address: string }; readStatus?: { tracked: boolean; opens: number } };
async function list(page: Page, mailboxId: string, extra: string) {
  return ((await (await page.request.get(`/api/mail/messages?mailboxId=${mailboxId}&${extra}&limit=100`)).json()).messages) as Item[];
}
async function busiest(page: Page) {
  const overview = await (await page.request.get("/api/mail/overview")).json();
  return [...overview.mailboxes].sort((a, b) => (b.folders.inbox?.total ?? 0) - (a.folders.inbox?.total ?? 0))[0] as { id: string; address: string };
}

test("Important and Other split the demo inbox, and a custom split by domain takes its mail", async ({ page }) => {
  test.setTimeout(150_000);
  await demo(page);
  await page.request.put("/api/mail/splits/style", { headers: { origin: new URL(page.url()).origin }, data: { style: "classic" } }); // W4: accounts made since 31 Oct open on Primary, Updates and Promotions; these flows use Important and Other
  const mb = await busiest(page);
  const all = await list(page, mb.id, "folder=inbox");
  const important = await list(page, mb.id, "folder=inbox&split=important");
  const other = await list(page, mb.id, "folder=inbox&split=other");
  // Every Inbox message is in exactly one of the two tabs.
  expect(important.length + other.length).toBe(all.length);
  expect(new Set([...important, ...other].map((m) => m.id)).size).toBe(all.length);

  await page.goto(`/app/mail?mailbox=${mb.id}`);
  const tabs = page.getByRole("tablist", { name: "Inbox tabs" });
  await expect(tabs.getByRole("tab", { name: /^Important/ })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: /^Other/ }).click();
  await expect(page).toHaveURL(/split=other/);

  // A split for one sender domain, made in the Edit splits sheet; the live count shows before saving.
  const pick = (other[0] ?? important[0])!;
  const domain = pick.from.address.split("@")[1];
  await page.getByRole("button", { name: "Edit tabs" }).click();
  await page.getByTestId("split-new").click();
  await page.getByLabel("Tab name").fill("From that domain");
  await page.getByLabel("Rule 1 value").fill(domain);
  await expect(page.getByTestId("split-preview-count")).toContainText(/thread/);
  await page.getByTestId("split-save").click();
  await expect(page.getByText("Tab added")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  const custom = tabs.getByRole("tab", { name: /^From that domain/ });
  await expect(custom).toBeVisible();
  await custom.click();
  const list1 = page.getByRole("region", { name: "Messages" }).or(page.locator("section[aria-label=Messages]"));
  await expect(list1.getByText(pick.subject || "(no subject)").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r31/mail-split-inbox.png` });

  // It left Other (and Important).
  const splitId = new URL(page.url()).searchParams.get("split")!;
  const inSplit = await list(page, mb.id, `folder=inbox&split=${splitId}`);
  expect(inSplit.map((m) => m.id)).toContain(pick.id);
  expect((await list(page, mb.id, "folder=inbox&split=other")).map((m) => m.id)).not.toContain(pick.id);
  expect((await list(page, mb.id, "folder=inbox&split=important")).map((m) => m.id)).not.toContain(pick.id);
});

test("read status: turn it on, send, the open image is fetched, Sent shows Opened", async ({ page }) => {
  test.setTimeout(150_000);
  await demo(page);
  await page.goto("/app/settings/mail");
  const sw = page.getByRole("switch", { name: "Show when people open my email" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");

  const mb = await busiest(page);
  const subject = `Read status ${Date.now()}`;
  const sent = await page.request.post("/api/mail/send", { data: { mailboxId: mb.id, to: ["reader@example.com"], subject, text: "Did this arrive?" }, headers: origin(page) });
  expect(sent.ok()).toBe(true);
  const { messageId } = await sent.json();

  // Sent shows "Not opened yet" first.
  await page.goto(`/app/mail?mailbox=${mb.id}&folder=sent`);
  const row = page.locator("li").filter({ hasText: subject });
  await expect(row.getByTestId("read-status")).toHaveText(/Not opened yet/);

  const db = new Database(path.resolve(".data/e2e.db"), { readonly: true, fileMustExist: true });
  const { token } = db.prepare("select token from mail_opens where message_id = ?").get(messageId) as { token: string };
  db.close();
  // Opens in the first 10 seconds are ignored (scanners fetch on delivery).
  await page.waitForTimeout(11_000);
  const pixel = await page.request.get(`/r/o/${token}.gif`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" } });
  expect(pixel.status()).toBe(200);
  expect(pixel.headers()["content-type"]).toBe("image/gif");
  expect(pixel.headers()["cache-control"]).toContain("no-store");

  await page.reload();
  await expect(row.getByTestId("read-status")).toHaveText(/Opened 1x, last/);
  await row.getByRole("button").first().click();
  await expect(page.getByRole("article").getByTestId("read-status")).toHaveText(/Opened 1x/);
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r31/mail-read-status.png` });
});

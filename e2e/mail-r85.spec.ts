import { test, expect, type Page } from "@playwright/test";
import { sign } from "../email-worker/src/index";

/**
 * R85: Inbox tabs (style, move to tab with Undo), labels, and mail rules made in the editor (test on recent mail,
 * save, turn off, run log), with a rule acting on mail delivered through the signed inbound webhook (mock mail).
 */
let visitor = 0;
const ip = () => `10.186.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function busiest(page: Page) {
  const overview = await (await page.request.get("/api/mail/overview")).json();
  return [...overview.mailboxes].sort((a, b) => (b.folders.inbox?.total ?? 0) - (a.folders.inbox?.total ?? 0))[0] as { id: string; address: string };
}
type Item = { id: string; threadId: string; subject: string; from: { address: string }; labels?: string[] };
async function list(page: Page, mailboxId: string, q: string) {
  return (await (await page.request.get(`/api/mail/messages?mailboxId=${mailboxId}&${q}&limit=100`)).json()).messages as Item[];
}

test("tab style, move to tab with Undo, and labels", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  await demo(page);
  const mb = await busiest(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/app/mail?mailbox=${mb.id}`);
  const tabs = page.getByRole("tablist", { name: "Inbox tabs" });
  // An existing account keeps Important and Other until it picks another style.
  await expect(tabs.getByRole("tab", { name: /^Important/ })).toBeVisible();

  await page.getByRole("button", { name: "Edit tabs" }).click();
  await page.getByTestId("tab-style-categories").click();
  await expect(page.getByText("Tabs: Primary, Updates, Promotions").or(page.getByText(/^Tabs: /))).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tabs.getByRole("tab", { name: /^Primary/ })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: /^Updates/ })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /^Promotions/ })).toBeVisible();

  // Arrow keys move between tabs.
  await tabs.getByRole("tab", { name: /^Primary/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: /^Updates/ })).toBeFocused();
  await expect(tabs.getByRole("tab", { name: /^Updates/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(tabs.getByRole("tab", { name: /^Primary/ })).toBeFocused();

  // Every Inbox thread is in exactly one of the three.
  const all = await list(page, mb.id, "folder=inbox");
  const parts = await Promise.all(["primary", "updates", "promotions"].map((s) => list(page, mb.id, `folder=inbox&split=${s}`)));
  expect(parts.reduce((n, p) => n + p.length, 0)).toBe(all.length);

  // Move one to Updates from the reader; Undo puts it back.
  const from = parts[0].length ? "primary" : "promotions";
  const pick = (parts[0][0] ?? parts[2][0])!;
  await page.goto(`/app/mail?mailbox=${mb.id}${from === "primary" ? "" : "&split=promotions"}&m=${pick.id}`);
  await page.getByTestId("move-to-tab").click();
  await page.getByRole("menuitemradio", { name: "Updates" }).click();
  await expect(page.getByText("Moved to Updates")).toBeVisible();
  expect((await list(page, mb.id, "folder=inbox&split=updates")).map((m) => m.id)).toContain(pick.id);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Put back")).toBeVisible();
  expect((await list(page, mb.id, "folder=inbox&split=updates")).map((m) => m.id)).not.toContain(pick.id);

  // Turning tabs off leaves one Inbox list.
  await page.request.put("/api/mail/splits/style", { headers: { origin: new URL(baseURL!).origin }, data: { style: "off" } });
  await page.goto(`/app/mail?mailbox=${mb.id}`);
  await expect(page.getByRole("tablist", { name: "Inbox tabs" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Turn on tabs" })).toBeVisible();

  // A label from the reader shows as a chip, in the list and in the Labels list.
  await page.goto(`/app/mail?mailbox=${mb.id}&m=${pick.id}`);
  await page.getByTestId("label-menu").click();
  await page.getByLabel("New label").fill("VIP r85");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("reader-labels").getByTestId("mail-label")).toContainText("VIP r85");
  await page.keyboard.press("Escape");
  const nav = page.getByTestId("label-nav");
  await nav.getByRole("button", { name: /VIP r85/ }).click();
  await expect(page.getByTestId("label-view")).toContainText("VIP r85");
  expect((await list(page, mb.id, "label=VIP+r85")).map((m) => m.id)).toContain(pick.id);
  await expect(page.getByTestId("mail-row").first().getByTestId("mail-label")).toContainText("VIP r85");
});

test("a rule made in the editor: test on recent mail, save, run on new mail, run log, turn off", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await demo(page);
  const mb = await busiest(page);
  const origin = new URL(baseURL!).origin;
  const sample = (await list(page, mb.id, "folder=inbox"))[0];
  const domain = sample.from.address.split("@")[1];

  await page.goto(`/app/mail/rules?mailbox=${mb.id}`);
  await expect(page.getByText("No rules yet")).toBeVisible();
  await page.getByTestId("rule-new").click();
  const ed = page.getByTestId("rule-editor");
  await ed.getByLabel("Name").fill("Invoices r85");
  await ed.getByLabel("Condition 1", { exact: true }).selectOption("domain");
  await ed.getByLabel("Condition 1 value").fill(domain);
  await ed.getByRole("button", { name: "Test on recent mail" }).click();
  await expect(page.getByTestId("rule-test-result")).toContainText(/of the last \d+ messages match/);
  // Narrow it to a subject only the delivered mail has, so the test finds nothing.
  await ed.getByLabel("Condition 1", { exact: true }).selectOption("subject");
  await ed.getByLabel("Condition 1 value").fill("invoice r85");
  await ed.getByLabel("Action 1 setting").fill("Billing r85");
  await ed.getByRole("button", { name: "Add action" }).click();
  // A new action defaults to one the rule doesn't use yet, and single use actions already in it are greyed out.
  await expect(ed.getByLabel("Action 2", { exact: true })).not.toHaveValue("label");
  await ed.getByLabel("Action 2", { exact: true }).selectOption("mark_read");
  await ed.getByRole("button", { name: "Add action" }).click();
  await expect(ed.getByLabel("Action 3", { exact: true }).locator("option[value=mark_read]")).toBeDisabled();
  await ed.getByLabel("Action 3", { exact: true }).selectOption("star");
  await ed.getByRole("button", { name: "Move action 3 up" }).click();
  await expect(ed.getByLabel("Action 2", { exact: true })).toHaveValue("star");
  await page.getByTestId("rule-save").click();
  await expect(page.getByText("Rule made")).toBeVisible();
  const row = page.getByTestId("rules-list").locator("[data-testid^=rule-]").first();
  await expect(row).toContainText("Invoices r85");
  await expect(row).toContainText("add label Billing r85, then star, then mark as read");

  // Mail arrives through the signed inbound webhook; the rule labels, stars and marks it read.
  const key = (await (await page.request.post("/api/inbound-keys", { headers: { origin } })).json()).key as { id: string; secret: string };
  const boxes = ((await (await page.request.get("/api/mailboxes")).json()).mailboxes as { id: string; address: string; status: string }[]).filter((b) => b.id === mb.id);
  const fromAddr = "accounts@supplier-r85.example";
  const raw = [`From: Supplier <${fromAddr}>`, `To: ${boxes[0].address}`, "Subject: Invoice R85 for October", `Message-ID: <r85.${Date.now()}@example.org>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "Your invoice is attached.", ""].join("\r\n");
  const body = new TextEncoder().encode(raw);
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = await sign(key.secret, ts, fromAddr, boxes[0].address, body.buffer as ArrayBuffer);
  const r = await page.request.post("/api/inbound/cloudflare", {
    headers: { "content-type": "message/rfc822", "x-mymail-key": key.id, "x-mymail-timestamp": ts, "x-mymail-envelope-from": fromAddr, "x-mymail-envelope-to": boxes[0].address, "x-mymail-signature": signature },
    data: Buffer.from(body),
  });
  expect((await r.json()).action).toBe("accept");
  await expect.poll(async () => (await list(page, mb.id, "folder=inbox&q=R85")).find((m) => m.subject === "Invoice R85 for October")?.labels ?? [], { timeout: 20_000 }).toContain("Billing r85");
  const got = (await list(page, mb.id, "folder=inbox&q=R85")).find((m) => m.subject === "Invoice R85 for October")! as Item & { isRead: boolean; isStarred: boolean };
  expect(got.isRead).toBe(true);
  expect(got.isStarred).toBe(true);

  await page.reload();
  await row.getByRole("button", { name: "Run log" }).click();
  await expect(page.getByTestId("rule-runs")).toContainText("Invoice R85 for October");
  await expect(page.getByTestId("rule-runs")).toContainText("Done");
  await page.keyboard.press("Escape");

  // Run on recent mail asks first, with the count.
  await row.getByRole("button", { name: "Run on recent mail" }).click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(page.getByRole("dialog").filter({ has: page.getByTestId("confirm-dialog") })).toContainText(/Run Invoices r85 on \d+ recent message/);
  await page.getByRole("button", { name: "Cancel" }).click();

  // Off: the next one is left alone.
  await row.getByRole("switch").click();
  await expect(page.getByText("Invoices r85 is off")).toBeVisible();
  await expect(row).toContainText("Off");
});

test("rules page and Inbox at 390 wide: no sideways scroll, menus reachable", async ({ page }) => {
  test.setTimeout(120_000);
  await demo(page);
  const mb = await busiest(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/mail?mailbox=${mb.id}`);
  await expect(page.getByRole("tablist", { name: "Inbox tabs" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole("combobox", { name: "Folder" }).selectOption("rules");
  await expect(page).toHaveURL(/\/app\/mail\/rules/);
  await page.getByTestId("rule-new").click();
  await expect(page.getByTestId("rule-editor")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  // Cancel and Make rule sit fully on screen while the form scrolls.
  const box = (await page.getByTestId("rule-save").boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(844);
});

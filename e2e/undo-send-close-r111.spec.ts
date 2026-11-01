import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * R111 extra 1 (verifier v8 MEDIUM): Undo send survives a closed tab. A message held in its countdown is handed to the
 * server when the page goes away, so it is never lost and never sent twice, and Undo still takes it back.
 */
test.describe.configure({ mode: "serial" });

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.evaluate(() => localStorage.setItem("multies-undo-send-seconds", "5"));
}
async function composeAndSend(page: Page, subject: string) {
  await page.goto("/app/mail?compose=1");
  const compose = page.getByRole("dialog", { name: "New message" });
  await expect(compose).toBeVisible();
  await compose.getByLabel("To").fill("someone@example.com");
  await compose.getByLabel("Subject").fill(subject);
  await compose.getByLabel("Message").fill("Held, then the tab closed.");
  await compose.getByRole("button", { name: "Send" }).click();
  await expect(compose).toBeHidden();
  await expect(page.getByTestId("undo-send-toast")).toBeVisible();
}
async function sentCount(ctx: BrowserContext, subject: string) {
  const p = await ctx.newPage();
  await p.goto("/app/mail");
  await p.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Sent/ }).click();
  await expect(p.getByText(subject).first()).toBeVisible({ timeout: 15_000 });
  // Wait past the whole hold so a second send would have landed if there were one.
  await p.waitForTimeout(7000);
  await p.reload();
  await p.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Sent/ }).click();
  await expect(p.getByText(subject).first()).toBeVisible({ timeout: 15_000 });
  const n = await p.getByText(subject, { exact: true }).count();
  return { p, n };
}

test("closing the tab during the countdown still sends it, exactly once", async ({ page, context }) => {
  await demo(page);
  const subject = `Closed tab ${Date.now()}`;
  await composeAndSend(page, subject);
  // No "Leave site?" prompt any more: the message can be handed over.
  let asked = false;
  page.on("dialog", (d) => { asked = true; void d.dismiss(); });
  await page.close({ runBeforeUnload: true });
  expect(asked).toBe(false);
  const { p, n } = await sentCount(context, subject);
  expect(n).toBe(1);
  expect(await p.evaluate(() => localStorage.getItem("multies-held-sends"))).toBeNull();
});

test("leaving the page for another site during the countdown sends it once", async ({ page, context }) => {
  await demo(page);
  const subject = `Left page ${Date.now()}`;
  await composeAndSend(page, subject);
  await page.goto("about:blank");
  const { n } = await sentCount(context, subject);
  expect(n).toBe(1);
});

test("Undo still cancels: an undone message is not sent when the tab closes", async ({ page, context }) => {
  await demo(page);
  const subject = `Undone ${Date.now()}`;
  await composeAndSend(page, subject);
  await page.getByTestId("undo-send-toast").getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("dialog", { name: "New message" })).toBeVisible();
  await page.close({ runBeforeUnload: false });
  const p = await context.newPage();
  await p.goto("/app/mail");
  await p.waitForTimeout(8000);
  await p.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Sent/ }).click();
  await expect(p.getByText(subject)).toHaveCount(0);
});

test("if the hand over never reaches the server, the next visit puts it back in Compose (never lost, not sent)", async ({ page, context }) => {
  test.setTimeout(120_000);
  await demo(page);
  const subject = `Never arrived ${Date.now()}`;
  // The connection drops as the tab closes: the keepalive send is cut off.
  await page.route("**/api/mail/send", (r) => r.abort());
  await composeAndSend(page, subject);
  await page.close({ runBeforeUnload: true });
  // Past the hold and the grace, so it can't be a live hold in another tab.
  await new Promise((r) => setTimeout(r, 27_000));
  const p = await context.newPage();
  await p.goto("/app");
  await expect(p.getByText("The page closed before your message could send.")).toBeVisible({ timeout: 20_000 });
  const compose = p.getByRole("dialog", { name: "New message" });
  await expect(compose).toBeVisible();
  await expect(compose.getByLabel("Subject")).toHaveValue(subject);
  if (process.env.R111_SHOTS) await p.screenshot({ path: `${process.env.R111_SHOTS}/undo-close-reopened-1280-light.png` });
  expect(await p.evaluate(() => localStorage.getItem("multies-held-sends"))).toBeNull();
  await p.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Sent/ }).click().catch(() => {});
});

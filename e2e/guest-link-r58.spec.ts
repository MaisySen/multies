import { test, expect } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R58 (MB-253): a guest invite whose email did not go out shows Copy invite link in the dialog, and a guest who has
 * not joined has Get link on their row (a fresh link, no email). The copied link opens the project for the guest.
 * The local server records email instead of sending it, so every invite here is "not sent". Local only.
 */
test.skip(!!process.env.E2E_BASE_URL, "local only");
let visitor = 0;
const ip = () => `10.159.${test.info().workerIndex % 200}.${++visitor}`;

test("an invite that was not emailed can be shared by link, now or later", async ({ browser }) => {
  test.setTimeout(90_000);
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() }, viewport: { width: 1280, height: 860 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(base).origin });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Gia Guestly", email: `gia-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  const project = (await (await page.request.post("/api/projects", { data: { name: `Harbour ${tag}` }, headers })).json()).project as { id: string };

  await page.goto(`/app/tasks?project=${project.id}&view=list`);
  await page.getByRole("button", { name: "Guests" }).click();
  const dialog = page.getByRole("dialog", { name: /Guests on/ });
  await dialog.getByLabel("Guest email").fill(`mia-${tag}@example.com`);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/guests") && r.request().method() === "POST"),
    dialog.getByRole("button", { name: "Invite" }).click(),
  ]);
  const invite = await res.json();
  expect(invite.delivery.status).toBe("not_sent");
  await expect(dialog.getByTestId("guest-invite-not-sent")).toContainText(`The invite email to mia-${tag}@example.com didn't go out`);
  await dialog.getByRole("button", { name: "Copy invite link to clipboard" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(invite.inviteUrl);
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r58/guests-after-not-sent-copy-desktop-light.png` });

  // Later: Get link on the guest's row makes a fresh link (no email) and the first one stops working.
  await dialog.getByRole("button", { name: `Get an invite link for mia-${tag}@example.com` }).click();
  await dialog.getByRole("button", { name: "Copy link to clipboard" }).click();
  const fresh = await page.evaluate(() => navigator.clipboard.readText());
  expect(fresh).toMatch(/\/g\/[A-Za-z0-9_-]{20,}$/);
  expect(fresh).not.toBe(invite.inviteUrl);

  const guest = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const gp = await guest.newPage();
  await gp.goto(new URL(fresh).pathname);
  await expect(gp.getByText(`Harbour ${tag}`).first()).toBeVisible({ timeout: 20_000 });
  await guest.close();
  await ctx.close();
});

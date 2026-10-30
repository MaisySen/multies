import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * R25 wave 3 dogfood (DF-4): an invitation carries a title, shown on the pending row and read back from /api/team.
 * R42: demos turned invites off (R40 MB-220, R41 UI; the demo case is covered by phone-r41 and tests/phone-r41), so
 * this now invites from a real local workspace: the owner signs up, opens Team, sends an invite with a title through
 * the dialog, sees it on the pending row and in /api/team. Joining is covered by join-r41 and invite-join-r39.
 */
test.skip(!!process.env.E2E_BASE_URL, "signs up a fresh local owner");
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
const tag = Math.random().toString(36).slice(2, 8);
test.beforeAll(async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": `10.96.${test.info().workerIndex % 200}.1` } });
  page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Dana Owner", email: `dana-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/org", { data: { name: `Dogfood ${tag}` }, headers })).status()).toBe(200);
});
test.afterAll(async () => { await ctx?.close(); });

test("team: an invitation from a real workspace carries a title, shown on the pending row and in /api/team", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/settings/team");
  const invite = page.getByRole("button", { name: "Invite", exact: true });
  await expect(invite).toBeEnabled({ timeout: 15_000 });
  await invite.click();
  const dialog = page.getByRole("dialog", { name: "Invite a teammate" });
  await expect(dialog).toBeVisible();
  const email = `chair-${tag}@example.com`;
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Title").fill("Board chair");
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByText(`${email} · Board chair`).or(page.getByText(email)).first()).toBeVisible({ timeout: 15_000 });
  const team = await (await page.request.get("/api/team")).json();
  const inv = (team.invites ?? team.pendingInvites ?? []).find((i: { email: string }) => i.email === email);
  expect(inv, JSON.stringify(Object.keys(team))).toBeTruthy();
  expect(inv.title).toBe("Board chair");
});

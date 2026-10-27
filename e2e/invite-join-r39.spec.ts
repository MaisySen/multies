import { test, expect, type Browser } from "@playwright/test";
import { confirmEmail } from "./support/confirm-email";

/**
 * R39 (MB-202) with the R39 security hotfix: the legitimate path still works. A teammate signs up with the
 * invited address, lands in their own new workspace while the invite waits, confirms their email, sees a
 * "Join" banner, and joins the inviting workspace. Accepting before confirming is refused. Local only.
 */
test.skip(!!process.env.E2E_BASE_URL, "needs the local outbox to confirm the address");
let visitor = 0;
const ip = () => `10.139.${test.info().workerIndex % 200}.${++visitor}`;

async function person(browser: Browser, email: string, name: string) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
}

test("an invited teammate signs up, confirms their email and joins from the banner", async ({ browser }) => {
  const tag = Math.random().toString(36).slice(2, 8);
  const owner = await person(browser, `olive-${tag}@example.com`, "Olive Owner");
  expect((await owner.page.request.patch("/api/org", { data: { name: `Harbor ${tag}` }, headers: owner.headers })).status()).toBe(200);
  const mateEmail = `sam-${tag}@example.com`;
  const inv = await owner.page.request.post("/api/team/invites", { data: { email: mateEmail, role: "member" }, headers: owner.headers });
  expect(inv.status()).toBe(201);
  const token = (await inv.json()).link.split("/invite/")[1];

  const mate = await person(browser, mateEmail, "Sam Lee");
  // Before confirming: no banner, and accepting is refused.
  const early = await mate.page.request.post(`/api/invites/${token}/accept`, { headers: mate.headers });
  expect(early.status()).toBe(403);
  expect((await early.json()).error.code).toBe("email_not_verified");
  await mate.page.goto("/app");
  await expect(mate.page.getByTestId("pending-invite-banner")).toHaveCount(0);

  await confirmEmail(mate.page.request, mateEmail);
  await mate.page.goto("/app");
  const banner = mate.page.getByTestId("pending-invite-banner");
  await expect(banner).toContainText(`Olive Owner invited you to join Harbor ${tag}.`);
  await banner.getByRole("link", { name: `Join Harbor ${tag}` }).click();
  await expect(mate.page).toHaveURL(new RegExp(`/invite/${token}`));
  await mate.page.getByRole("button", { name: "Accept and open workspace" }).click();
  await expect(mate.page).toHaveURL(/\/app\/my-work/);
  const me = await (await mate.page.request.get("/api/account/me")).json();
  expect(me.organization).toMatchObject({ name: `Harbor ${tag}`, role: "member" });
  expect(me.pendingInvites).toEqual([]);
  await expect(mate.page.getByTestId("pending-invite-banner")).toHaveCount(0);
  await mate.ctx.close();
  await owner.ctx.close();
});

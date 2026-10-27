import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * R25 wave 3 dogfood (DF-4): an invitation carries a title, shown on the pending row and
 * read back from /api/team.
 */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.96.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

test("team: in the demo, Invite is off with the reason shown, and the server refuses invites (R41; titles are covered by unit tests)", async () => {
  // R40 deploy 3 (MB-220) turned demo invites off on the server; R41 shows that in the UI.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/settings/team");
  const invite = page.getByRole("button", { name: "Invite", exact: true });
  await expect(invite).toBeVisible();
  await expect(invite).toBeDisabled();
  await expect(page.getByText("Invites are off in the demo.").first()).toBeVisible();
  const status = await page.evaluate(async () => (await fetch("/api/team/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "chair@example.com", role: "member", title: "Board chair" }) })).status);
  expect(status).toBe(403);
});

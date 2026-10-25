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

test("team: invite with a title and bio, see the title on the pending invitation", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/settings/team");
  const invite = page.getByRole("button", { name: "Invite", exact: true });
  await expect(invite).toBeVisible();
  if (await invite.isDisabled()) {
    // The demo's seats are full: revoke one pending invitation to free a seat.
    await page.getByRole("button", { name: /^Revoke invitation for / }).first().click();
    await expect(invite).toBeEnabled();
  }
  await invite.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill("chair@example.com");
  await dialog.getByLabel("Title").fill("Board chair");
  await dialog.getByLabel("Bio").fill("Chairs the board.");
  if (process.env.R25_DOGFOOD2_SHOT) await page.screenshot({ path: process.env.R25_DOGFOOD2_SHOT });
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByTestId("invite-link")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("chair@example.com").first()).toBeVisible();
  await expect(page.getByText("· Board chair")).toBeVisible();
  const team = await page.evaluate(async () => (await (await fetch("/api/team")).json()) as { invites: { email: string; title: string | null; bio: string | null }[] });
  expect(team.invites.find((i) => i.email === "chair@example.com")).toMatchObject({ title: "Board chair", bio: "Chairs the board." });
});

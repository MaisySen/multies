/** R130 flag off (run with TOURS_R130=off E2E_TOURS_OFF=1): no checklist, no ring, no tours, no Settings entry, routes 404. */
import { test, expect } from "@playwright/test";

test("R130 flag off: nothing visible", async ({ browser }) => {
  test.skip(!process.env.E2E_TOURS_OFF, "runs only against a server with TOURS_R130=off");
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": `10.229.1.${Date.now() % 200}` } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Off Owner", email: `off-${Date.now()}@acme.io`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  expect((await page.request.get("/api/tours/me")).status()).toBe(404);
  await page.goto("/app/my-work");
  await expect(page.getByTestId("today")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("checklist")).toHaveCount(0);
  await expect(page.getByTestId("tours-ring")).toHaveCount(0);
  await page.goto("/app/settings");
  await expect(page.getByTestId("settings-rail")).toBeVisible();
  await expect(page.locator('[data-tour="pane-app-settings-tours"]')).toHaveCount(0);
  await page.getByTestId("sidebar-account").click();
  await expect(page.getByRole("menuitem", { name: "Tours" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Get started" })).toHaveCount(0);
});

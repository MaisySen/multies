import { test, expect, type Page } from "@playwright/test";

/**
 * OPS1 impersonation: the banner an operator sees at the top of the app while viewing or acting as someone. The
 * impersonation itself is mocked (GET /api/account/me gains session.impersonation, Stop is answered by a route mock);
 * the server side (cookies, blocks, expiry, audit) is covered by tests/console-impersonation.test.ts. The "View as"
 * button renders on the console Users page and is exercised with that page.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

/** Adds session.impersonation to the real /me answer. */
async function asImpersonation(page: Page, mode: "view" | "act", secondsLeft: number) {
  await page.route((u) => u.pathname === "/api/account/me", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.session = { ...(json.session ?? {}), impersonation: { mode, expiresAt: new Date(Date.now() + secondsLeft * 1000).toISOString(), secondsLeft, operatorEmail: "olive@example.com" } };
    await route.fulfill({ response: res, json });
  });
}

function mockStop(page: Page, calls: string[]) {
  return page.route((u) => u.pathname === "/api/console/impersonation/stop", async (route) => {
    calls.push(route.request().method());
    await route.fulfill({ json: { ok: true, signedOut: false, returnTo: "/console/users/usr_e2e_target" } });
  });
}

test("view mode: the banner names the person, counts down, and Stop returns to the console", async ({ page }) => {
  await signUp(page, "Tara Target");
  const calls: string[] = [];
  await asImpersonation(page, "view", 25 * 60);
  await mockStop(page, calls);
  await page.goto("/app/my-work");
  const banner = page.getByTestId("impersonation-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toHaveAttribute("data-mode", "view");
  await expect(page.getByTestId("impersonation-banner-text")).toContainText("Viewing as Tara Target");
  await expect(page.getByTestId("impersonation-banner-text")).toContainText("view only");
  await expect(page.getByTestId("impersonation-banner-countdown")).toHaveText(/^2[45]:\d\d$/);
  // Fixed at the top and above the app: it stays in view.
  const box = await banner.boundingBox();
  expect(box?.y ?? 99).toBeLessThanOrEqual(1);
  await page.getByTestId("impersonation-banner-stop").click();
  await expect(page).toHaveURL(/\/console\/users\/usr_e2e_target$/, { timeout: 15_000 });
  expect(calls).toEqual(["POST"]);
});

test("act mode says changes are made in their name", async ({ page }) => {
  await signUp(page, "Arlo Act");
  await asImpersonation(page, "act", 10 * 60);
  await page.goto("/app/my-work");
  await expect(page.getByTestId("impersonation-banner")).toHaveAttribute("data-mode", "act", { timeout: 15_000 });
  await expect(page.getByTestId("impersonation-banner-text")).toContainText("Acting as Arlo Act");
  await expect(page.getByTestId("impersonation-banner-text")).toContainText("made in their name");
});

test("when the time runs out the banner says so and goes back to the console", async ({ page }) => {
  await signUp(page, "Eve Expiry");
  const calls: string[] = [];
  await asImpersonation(page, "view", 2);
  await mockStop(page, calls);
  await page.goto("/app/my-work");
  await expect(page.getByTestId("impersonation-banner-text")).toContainText("Your 30 minute session ended", { timeout: 15_000 });
  await expect(page).toHaveURL(/\/console\/users\/usr_e2e_target$/, { timeout: 15_000 });
  expect(calls).toEqual(["POST"]);
});

test("nobody else sees the banner", async ({ page }) => {
  await signUp(page, "Nora Normal");
  await expect(page.getByTestId("impersonation-banner")).toHaveCount(0);
});

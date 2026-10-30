import { test, expect } from "@playwright/test";

/**
 * DF-19: the sign in page offers "Set a new one", which emails a reset link in one click (old
 * passwords work again through the identity provider's automatic migration). Runs against the local fake identity provider.
 */
const BASE = `http://localhost:${process.env.E2E_IDP_PORT ?? "8790"}`;
test.skip(!!process.env.E2E_BASE_URL, "needs the local fake identity provider");

test("a person who forgot their password gets a reset link in one click", async ({ page }) => {
  await page.goto(`${BASE}/login`);
  const notice = page.getByTestId("moved-sign-in");
  await expect(notice).toContainText("Forgot your password?");
  await notice.getByRole("link", { name: "Set a new one" }).click();
  await expect(page).toHaveURL(/\/forgot-password/);
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await page.getByLabel("Email").fill("pat@example.com");
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/account/password-reset-link") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Email me a reset link" }).click();
  expect((await sent).status()).toBe(200);
  await expect(page.getByTestId("reset-sent")).toContainText("pat@example.com");
  await expect(page.getByText(/auth0/i)).toHaveCount(0);
});

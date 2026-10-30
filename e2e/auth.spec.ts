import { test, expect } from "@playwright/test";
import * as OTPAuth from "otpauth";

test("two-factor setup, then sign-in asks for the code", async ({ page }) => {
  const email = `mfa-${Date.now()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Mona Factor");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Mona/ })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/my-work$/);

  await page.goto("/app/settings/account");
  await expect(page.getByText("This device")).toBeVisible();
  await page.getByRole("button", { name: "Set up two-factor" }).click();
  await page.getByLabel("Your password").fill("a-strong-password");
  await page.getByRole("button", { name: "Continue" }).click();
  const secret = (await page.getByTestId("totp-secret").textContent())!.replace(/\s/g, "");
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  await page.getByLabel("6-digit code").fill(totp.generate());
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("heading", { name: "Save your backup codes" })).toBeVisible();
  await page.getByRole("button", { name: "I've saved them" }).click();
  await expect(page.getByText("Two-factor is on")).toBeVisible();

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  await page.getByLabel("Code").fill(totp.generate());
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Mona/ })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/my-work$/);
});

import { test, expect } from "@playwright/test";

/**
 * R27: Settings, Sign-up emails. An admin sets up the workspace's branded auth emails (the R25 hook), sees
 * the signing secret once, edits the subject, colour and a Nepali block, and the live preview follows.
 */
test("an admin edits sign-up emails and the preview follows", async ({ page }) => {
  if (!process.env.E2E_BASE_URL) await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `10.96.${test.info().workerIndex % 200}.1` });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto("/app/settings/sign-up-emails");
  await expect(page.getByRole("heading", { name: "Sign-up emails" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign-up emails" })).toHaveAttribute("aria-current", "page");

  await page.getByLabel("Sender name").fill("Haajir School");
  await page.getByLabel("Product name").fill("Haajir");
  await page.getByLabel("Supabase project URL").fill("https://abcd1234.supabase.co");
  await page.getByRole("button", { name: "Save" }).click();
  const secret = page.getByLabel("Signing secret");
  await expect(secret).toHaveValue(/^v1,whsec_/);
  await expect(page.getByText("Copy it now. It isn't shown again.")).toBeVisible();

  const subject = page.getByTestId("auth-preview-subject");
  await expect(subject).toHaveText("Confirm your email for Haajir");
  await page.getByLabel("Subject", { exact: true }).fill("Welcome to {appName}");
  await expect(subject).toHaveText("Welcome to Haajir");
  await page.getByLabel("Intro line").fill("Confirm your email to follow your child's attendance in {appName}.");
  await page.getByLabel("Brand colour", { exact: true }).fill("#0F7B6C");
  await expect(page.locator('iframe[title="Email preview"]')).toHaveAttribute("srcdoc", /#0f7b6c/);
  await page.getByLabel("Language", { exact: true }).fill("ne");
  await page.getByLabel("Subject in this language").fill("हाजिरमा स्वागत छ");
  await page.getByLabel("Text in this language").fill("आफ्नो इमेल पुष्टि गर्नुहोस्।");
  await expect(subject).toHaveText("Welcome to Haajir / हाजिरमा स्वागत छ");
  const frame = page.frameLocator('iframe[title="Email preview"]');
  await expect(frame.getByText("Confirm your email to follow your child's attendance in Haajir.")).toBeVisible();
  await expect(frame.getByText("आफ्नो इमेल पुष्टि गर्नुहोस्।")).toBeVisible();

  // Another type has its own text.
  await page.getByRole("tab", { name: "Password reset" }).click();
  await expect(subject).toHaveText("Reset your Haajir password");
  await page.getByRole("tab", { name: "Sign-up confirmation" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  // After a reload the secret is masked, and the saved text is back.
  await page.reload();
  await expect(page.getByLabel("Signing secret")).toHaveValue(/^whsec_\u2022+.{4}$/);
  await expect(page.getByTestId("auth-preview-subject")).toHaveText("Welcome to Haajir / हाजिरमा स्वागत छ");
  await page.setViewportSize({ width: 1280, height: 1640 });
  await page.screenshot({ path: "/home/user/tab/files/multies-r27/auth-hook-settings.png", fullPage: true });
});

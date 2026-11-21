import { test, expect, type Page, type Route } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * OPS1: the console's Mobile app page (/console/mobile). The operator and GET/PUT /api/console/mobile are mocked;
 * the server's own rules are covered by tests/console-mobile-routes.test.ts. The form shows what phones get now,
 * Save stays off until something changed, raising a minimum warns in the review dialog, the reason is sent with
 * the patch, and a read only role sees the form without the save bar.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-mob-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const fields = [
  { path: "min_supported.ios.build", label: "Oldest iPhone build allowed", help: "Phones on an older store build must update.", type: "integer", nullable: true, min: 0 },
  { path: "ota.check_interval_minutes", label: "Check for updates every (minutes)", help: "Between 5 and 1440.", type: "integer", nullable: false, min: 5, max: 1440 },
  { path: "message", label: "Message on the update screen", help: "Optional extra line.", type: "text", nullable: true, maxLength: 200 },
];

function config(build: number | null, updatedAt: string | null) {
  return {
    stored: build === null ? {} : { min_supported: { ios: { build } } },
    effective: {
      min_supported: { ios: { build, version: null }, android: { build: null, version: null } },
      store_url: { ios: "https://apps.apple.com/app/id1", android: "https://play.google.com/store/apps/details?id=x" },
      ota: { critical_update_ids: [], blocked_update_ids: [], check_interval_minutes: 30, apply_on_resume_after_minutes: 240 },
      message: null,
    },
    fields, updatedAt, updatedBy: updatedAt ? "console:usr_e2e_ops" : null, updatedByEmail: updatedAt ? "olive@example.com" : null,
  };
}

async function mockMobile(page: Page) {
  const sent: unknown[] = [];
  let current = config(null, null);
  await page.route("**/api/console/mobile", async (r: Route) => {
    if (r.request().method() === "PUT") {
      const body = r.request().postDataJSON() as { patch: { min_supported?: { ios?: { build?: number } } } };
      sent.push(body);
      current = config(body.patch.min_supported?.ios?.build ?? null, new Date().toISOString());
      return r.fulfill({ json: { ok: true, ...current } });
    }
    return r.fulfill({ json: current });
  });
  return sent;
}

test("an operator changes a setting, reviews the diff with a warning, and saves with a reason", async ({ page }) => {
  await signUp(page, "Olive Operator");
  await mockConsoleMe(page, "admin");
  const sent = await mockMobile(page);
  await page.goto("/console/mobile");
  await expect(page.getByRole("heading", { name: "Mobile app", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-mobile-section-minimum")).toBeVisible();
  await expect(page.getByTestId("console-mobile-section-updates")).toBeVisible();
  await expect(page.getByTestId("console-mobile-section-message")).toBeVisible();
  await expect(page.getByTestId("console-mobile-field-min_supported.ios.build-now")).toHaveText("Any build");
  await expect(page.getByTestId("console-mobile-field-ota.check_interval_minutes-now")).toHaveText("30");

  const review = page.getByTestId("console-mobile-review");
  await expect(review).toBeDisabled();

  // An invalid value shows inline and keeps Save off.
  const interval = page.getByTestId("console-mobile-field-ota.check_interval_minutes");
  await interval.fill("2");
  await expect(page.getByText("Use 5 or more.")).toBeVisible();
  await expect(review).toBeDisabled();
  await interval.fill("30");

  await page.getByTestId("console-mobile-field-min_supported.ios.build").fill("50");
  await expect(page.getByTestId("console-mobile-status")).toHaveText("1 change not saved yet.");
  await expect(review).toBeEnabled();
  await review.click();

  const dialog = page.getByTestId("reason-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Oldest iPhone build allowed", { exact: true })).toBeVisible();
  await expect(dialog.getByTestId("console-mobile-warning")).toContainText("This forces people on older builds to update.");
  await dialog.getByLabel("Reason").fill("Login fix needs build 50");
  await dialog.getByRole("button", { name: "Save changes" }).click();

  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ patch: { min_supported: { ios: { build: 50 } } }, reason: "Login fix needs build 50" });
  await expect(page.getByTestId("console-mobile-field-min_supported.ios.build-now")).toHaveText("50");
  await expect(page.getByTestId("console-mobile-updated")).toContainText("olive@example.com");
  await expect(review).toBeDisabled();
});

test("a support operator sees the settings but cannot change them", async ({ page }) => {
  await signUp(page, "Sam Support");
  await mockConsoleMe(page, "ops_support");
  await mockMobile(page);
  await page.goto("/console/mobile");
  await expect(page.getByRole("heading", { name: "Mobile app", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-mobile-field-min_supported.ios.build")).toBeDisabled();
  await expect(page.getByTestId("console-mobile-review")).toHaveCount(0);
});

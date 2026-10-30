import { test, expect } from "@playwright/test";

/**
 * Round 9: the pages the App Store and Google Play link to, and account deletion on the web.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.89.${test.info().workerIndex % 200}.${++visitor}` });
});

test("the support, privacy, terms and deletion pages are public", async ({ page }) => {
  for (const [path, heading] of [["/support", "Support"], ["/privacy", "Privacy"], ["/terms", "Terms"], ["/delete-account", "Delete your Multies account"]] as const) {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
  }
  await page.goto("/support");
  await expect(page.getByRole("link", { name: /@/ }).first()).toHaveAttribute("href", /^mailto:/);
});

test("a signed in person deletes their account on the web", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.goto("/delete-account");
  const button = page.getByRole("button", { name: "Delete my account" });
  await expect(button).toBeDisabled();
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await button.click();
  await expect(page.getByRole("status")).toContainText("Your account is deleted");
  expect((await page.request.get("/api/account/me")).status()).toBe(401);
});

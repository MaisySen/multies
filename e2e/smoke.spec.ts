import { test, expect } from "@playwright/test";

/**
 * Browser smoke test over the real UI and API.
 *   npm run build && npx playwright install chromium && npm run test:e2e
 */
test("sign up, add a domain, see its DNS records, create a mailbox", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const domain = `e2e-${Date.now().toString(36)}.test`;

  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Erin Example");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Erin/ })).toBeVisible();

  await page.getByRole("link", { name: "Domains" }).first().click();
  await page.getByRole("button", { name: "Add domain" }).first().click();
  await page.getByRole("textbox", { name: "Domain", exact: true }).fill(domain);
  await page.getByRole("dialog").getByRole("button", { name: "Add domain" }).click();
  await expect(page.getByRole("heading", { name: domain })).toBeVisible();
  await expect(page.getByText("Signing key (DKIM)")).toBeVisible();
  await expect(page.getByText(/v=DKIM1; k=rsa; p=MIIB/)).toBeVisible();

  await page.getByRole("link", { name: "Mailboxes" }).first().click();
  await page.getByRole("button", { name: "New mailbox" }).first().click();
  await page.getByRole("textbox", { name: "Address", exact: true }).fill("hello");
  await page.getByLabel("Display name").fill("Hello Team");
  await page.getByRole("dialog").getByRole("button", { name: "Create mailbox" }).click();
  await expect(page.getByText(`hello@${domain}`, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Mail", exact: true }).click();
  await expect(page.getByText("Inbox zero")).toBeVisible();
});

test("marketing pages render and link to sign up", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Email on your own domain");
  await page.getByRole("link", { name: "Pricing" }).first().click();
  await expect(page.getByRole("table", { name: "Plan comparison" })).toBeVisible();
});

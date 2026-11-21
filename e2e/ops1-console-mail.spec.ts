import { test, expect, type Page, type Route } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * OPS1: Mail and deliverability at /console/mail. It opens on delivery problems (worst workspaces, then failed
 * deliveries), a filter goes into the address, Remove on a suppressed address asks for a reason and sends it, and a
 * read only operator sees no action buttons. /api/console/* is mocked; the server side is tests/console-mail-routes.test.ts.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-mail-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const now = () => new Date().toISOString();
const failureRates = { items: [{ orgId: "org_beta", orgName: "Beta Co", total: 40, failed: 8, bounced: 6, complained: 2, failureRate: 0.2 }] };
const deliveries = () => ({ items: [{ id: "dlv_1", orgId: "org_beta", orgName: "Beta Co", direction: "outbound", status: "bounced", provider: "resend", detail: "550 mailbox unavailable", createdAt: now() }], nextCursor: null });
const suppressionsList = () => ({ items: [{ id: "sup_1", orgId: "org_beta", orgName: "Beta Co", address: "gone@outside.example", reason: "hard_bounce", detail: "User unknown", createdAt: now() }], nextCursor: null });

/** Mocks the mail API; returns the URLs of list reads and the bodies of changes. */
async function mockMail(page: Page) {
  const reads: string[] = [];
  const changes: { method: string; url: string; body: unknown }[] = [];
  const list = (json: () => unknown) => async (r: Route) => { reads.push(r.request().url()); await r.fulfill({ json: json() }); };
  await page.route(/\/api\/console\/mail\/failure-rates(\?|$)/, list(() => failureRates));
  await page.route(/\/api\/console\/mail\/deliveries(\?|$)/, list(deliveries));
  await page.route(/\/api\/console\/mail\/suppressions(\?|$)/, list(suppressionsList));
  await page.route(/\/api\/console\/mail\/suppressions\/sup_1$/, async (r) => {
    changes.push({ method: r.request().method(), url: r.request().url(), body: r.request().postDataJSON() });
    await r.fulfill({ json: { ok: true, id: "sup_1" } });
  });
  return { reads, changes };
}

test("opens on delivery problems, and a filter goes into the address", async ({ page }) => {
  await signUp(page, "Olive Operator");
  await mockConsoleMe(page, "admin");
  const { reads } = await mockMail(page);
  await page.goto("/console/mail");
  await expect(page.getByRole("heading", { name: "Mail and deliverability", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-mail-worst")).toContainText("Beta Co");
  await expect(page.getByTestId("console-mail-worst")).toContainText("20%");
  await expect(page.getByText("550 mailbox unavailable")).toBeVisible();
  await expect(page.getByRole("link", { name: "Beta Co" }).first()).toHaveAttribute("href", "/console/workspaces/org_beta");
  await expect(page.getByTestId("console-mail-sending")).toBeVisible();

  await page.getByLabel("Status", { exact: true }).selectOption("bounced");
  await expect(page).toHaveURL(/[?&]status=bounced/);
  await expect.poll(() => reads.some((u) => u.includes("/deliveries?") && u.includes("status=bounced"))).toBe(true);

  await page.getByLabel("When", { exact: true }).selectOption("30");
  await expect(page).toHaveURL(/[?&]window=30/);
  await expect.poll(() => reads.some((u) => u.includes("/failure-rates?") && u.includes("window=30"))).toBe(true);
});

test("removing a suppressed address asks for a reason and sends it", async ({ page }) => {
  await signUp(page, "Olive Operator");
  await mockConsoleMe(page, "admin");
  const { changes } = await mockMail(page);
  await page.goto("/console/mail");
  await expect(page.getByRole("heading", { name: "Mail and deliverability", level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("console-mail-tab-suppressions").click();
  await expect(page).toHaveURL(/[?&]tab=suppressions/);
  await expect(page.getByText("gone@outside.example")).toBeVisible();

  await page.getByTestId("console-mail-unsuppress").click();
  const dialog = page.getByRole("dialog", { name: "Let mail go to gone@outside.example again?" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill("Recipient fixed their mailbox");
  await dialog.getByRole("button", { name: "Remove suppression" }).click();
  await expect(dialog).toBeHidden();
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ method: "DELETE", body: { reason: "Recipient fixed their mailbox" } });
});

test("a read only operator sees the lists but no actions", async ({ page }) => {
  await signUp(page, "Rory Readonly");
  await mockConsoleMe(page, "ops_readonly");
  await mockMail(page);
  await page.goto("/console/mail");
  await expect(page.getByTestId("console-mail-worst")).toContainText("Beta Co", { timeout: 15_000 });
  await expect(page.getByTestId("console-mail-sending")).toHaveCount(0);
  await page.goto("/console/mail?tab=suppressions");
  await expect(page.getByText("gone@outside.example")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-mail-unsuppress")).toHaveCount(0);
});

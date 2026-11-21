import { test, expect, type Page } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * OPS1: the console's Developer platform (/console/developer). Webhook failures open first; filters live in the
 * address; Redeliver and Revoke ask for a reason in the one dialog and send it; a read only operator sees no actions.
 * The operator and every /api/console/developer call are mocked; the server's rules are in
 * tests/console-developer-routes.test.ts.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1dev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const now = () => new Date(Date.now() - 3_600_000).toISOString();

const delivery = () => ({
  id: "msg_e2e_1", orgId: "org_e2e", orgName: "Harbour Studio", endpointId: "whe_e2e_1", endpointUrl: "https://hooks.harbour.example",
  eventType: "message.bounced", status: "failed", attempts: 6, responseStatus: 500, lastError: "Receiver answered 500",
  payloadPreview: "message.bounced: id, mailboxId, to", nextAttemptAt: null, deliveredAt: null, createdAt: now(),
});

const apiKey = () => ({
  id: "key_e2e_1", orgId: "org_e2e", orgName: "Harbour Studio", name: "Zapier sync", prefix: "mlt_abc12345", scope: "full", agentId: null,
  createdByUserId: "usr_e2e_dev", createdByEmail: "dev@harbour.example", lastUsedAt: now(), createdAt: now(),
});

interface Seen { lists: string[]; posts: { url: string; body: unknown }[] }

async function mockDeveloper(page: Page): Promise<Seen> {
  const seen: Seen = { lists: [], posts: [] };
  await page.route(/\/api\/console\/developer\/webhook-deliveries(\?|$)/, (r) => { seen.lists.push(r.request().url()); return r.fulfill({ json: { items: [delivery()], nextCursor: null } }); });
  await page.route(/\/api\/console\/developer\/api-keys(\?|$)/, (r) => { seen.lists.push(r.request().url()); return r.fulfill({ json: { items: [apiKey()], nextCursor: null } }); });
  await page.route(/\/api\/console\/developer\/webhooks(\?|$)/, (r) => r.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route(/\/api\/console\/developer\/oauth-(grants|clients)(\?|$)/, (r) => r.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route(/\/api\/console\/developer\/.+\/(redeliver|revoke|enable|disable)$/, async (r) => {
    seen.posts.push({ url: r.request().url(), body: r.request().postDataJSON() });
    await r.fulfill({ json: { ok: true, replayed: 1 } });
  });
  return seen;
}

test("webhook failures first, filters in the address, Redeliver and Revoke send the reason", async ({ page }) => {
  await mockConsoleMe(page, "admin");
  const seen = await mockDeveloper(page);
  await signUp(page, "Olive Operator");
  await page.goto("/console/developer");
  await expect(page.getByRole("heading", { name: "Developer platform", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-developer-tab-failures")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("message.bounced: id, mailboxId, to")).toBeVisible();
  await expect(page.getByText("hooks.harbour.example")).toBeVisible();
  await expect(page.getByRole("link", { name: "Harbour Studio" })).toHaveAttribute("href", "/console/workspaces/org_e2e");
  // Opens on failed deliveries in the last 7 days.
  expect(seen.lists.some((u) => u.includes("status=failed") && u.includes("days=7"))).toBe(true);

  // A filter goes in the address and in the request.
  await page.getByRole("combobox", { name: "When" }).selectOption("30");
  await expect(page).toHaveURL(/days=30/);
  await expect.poll(() => seen.lists.some((u) => u.includes("days=30"))).toBe(true);

  // Redeliver: the dialog says the endpoint is switched back on, and the reason is sent.
  await page.getByTestId("console-developer-redeliver").click();
  const re = page.getByRole("dialog", { name: "Send this message.bounced event again?" });
  await expect(re).toBeVisible();
  await expect(re).toContainText("switches it back on");
  await re.getByLabel("Reason").fill("Customer fixed their receiver");
  await re.getByRole("button", { name: "Redeliver" }).click();
  await expect(re).toBeHidden();
  await expect.poll(() => seen.posts.find((p) => p.url.endsWith("/webhook-deliveries/msg_e2e_1/redeliver"))?.body).toEqual({ reason: "Customer fixed their receiver" });

  // API keys tab: the prefix only, and Revoke says the workspace needs a new key.
  await page.getByTestId("console-developer-tab-keys").click();
  await expect(page).toHaveURL(/tab=keys/);
  await expect(page).not.toHaveURL(/days=30/);
  await expect(page.getByText("Zapier sync")).toBeVisible();
  await expect(page.getByText("mlt_abc12345")).toBeVisible();
  await page.getByTestId("console-developer-revoke-key").click();
  const rv = page.getByRole("dialog", { name: 'Revoke the API key "Zapier sync"?' });
  await expect(rv).toContainText("will need to create a new key");
  await rv.getByLabel("Reason").fill("Key posted in a public repo");
  await rv.getByRole("button", { name: "Revoke key" }).click();
  await expect(rv).toBeHidden();
  await expect.poll(() => seen.posts.find((p) => p.url.endsWith("/api-keys/key_e2e_1/revoke"))?.body).toEqual({ reason: "Key posted in a public repo" });
});

test("a read only operator sees the lists but no actions", async ({ page }) => {
  await mockConsoleMe(page, "ops_readonly");
  await mockDeveloper(page);
  await signUp(page, "Rory Readonly");
  await page.goto("/console/developer");
  await expect(page.getByText("message.bounced: id, mailboxId, to")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-developer-redeliver")).toHaveCount(0);
  await page.getByTestId("console-developer-tab-keys").click();
  await expect(page.getByText("Zapier sync")).toBeVisible();
  await expect(page.getByTestId("console-developer-revoke-key")).toHaveCount(0);
});

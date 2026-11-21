import { test, expect, type Page } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";
import type { OperatorRole } from "../src/shared/operator-permissions";

/**
 * OPS1: the Feature flags page at /console/flags. The list shows each flag's value for everyone and where it comes
 * from, a group chip updates the address, a row opens the flag's detail, and an owner's "Turn on for everyone" asks for
 * a reason and sends it. A read only operator sees no change buttons. The console API is mocked (page.route); the
 * server side is covered by tests/console-flags-routes.test.ts.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-flags-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

const now = new Date().toISOString();
const base = { requires: [], globalOverride: null, workspaceOverrideCount: 0, features: false };
const flags = [
  { ...base, key: "mailArchive", env: "MAIL_ARCHIVE_R111", label: "Mail archive and retention", description: "Archive and retention settings for mail.", group: "Mail and inbox", scope: "workspace", runtime: true, bootReason: null, envDefault: false, effective: false, workspaceOverrideCount: 2 },
  { ...base, key: "mailSplitCounts", env: "MAIL_SPLIT_COUNTS", label: "Unread counts on split inbox tabs", description: "Counts unread mail on the tabs.", group: "Mail and inbox", scope: "global", runtime: true, bootReason: null, envDefault: true, effective: false,
    globalOverride: { value: false, locked: true, note: null, updatedBy: "usr_1", updatedByEmail: "olive@example.com", updatedAt: now } },
  { ...base, key: "chatPlus", env: "CHAT_PLUS", label: "Chat extras", description: "Topics, polls and live questions in chat.", group: "Chat and meetings", scope: "workspace", runtime: false, bootReason: "Its routes are added when the server starts, so a change needs a deploy.", envDefault: true, effective: true },
];
const detail = {
  flag: flags[0],
  overrides: { nextCursor: null, items: [
    { orgId: "org_e2e_a", workspaceName: "Harbour Studio", value: true, note: "Pilot", updatedByEmail: "olive@example.com", updatedAt: now, applies: true },
    { orgId: "org_e2e_b", workspaceName: "Pine Bakery", value: false, note: null, updatedByEmail: null, updatedAt: now, applies: true },
  ] },
};

async function mockFlags(page: Page, role: OperatorRole) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  await mockConsoleMe(page, role);
  await page.route(/\/api\/console\/flags(\?.*)?$/, (r) => r.fulfill({ json: { items: flags, nextCursor: null } }));
  await page.route(/\/api\/console\/flags\/mailArchive(\?.*)?$/, (r) => r.fulfill({ json: detail }));
  await page.route(/\/api\/console\/flags\/mailArchive\/(global|workspaces\/[^/?]+)$/, async (r) => {
    calls.push({ method: r.request().method(), url: r.request().url(), body: r.request().postDataJSON() });
    await r.fulfill({ json: { ok: true, override: { value: true, locked: false } } });
  });
  return calls;
}

test("an owner sees the flags, filters by group, opens a flag and turns it on for everyone with a reason", async ({ page }) => {
  await signUp(page, "Olive Operator");
  const calls = await mockFlags(page, "admin");
  await page.goto("/console/flags");
  await expect(page.getByRole("heading", { name: "Feature flags", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-flags-propagation")).toContainText("up to a minute");

  await expect(page.getByTestId("console-flags-state-mailArchive")).toContainText("Off");
  await expect(page.getByTestId("console-flags-state-mailArchive")).toContainText("default");
  await expect(page.getByTestId("console-flags-state-mailSplitCounts")).toContainText("locked for everyone");
  await expect(page.getByTestId("console-flags-state-chatPlus")).toContainText("On");
  await expect(page.getByTestId("console-flags-deploy-note")).toHaveCount(1);
  await expect(page.getByTestId("console-flags-deploy-note")).toHaveAttribute("title", /needs a deploy/);

  // A group chip goes into the address, so the filtered list can be shared.
  await page.getByRole("combobox", { name: "Group" }).selectOption("Mail and inbox");
  await expect(page).toHaveURL(/group=Mail\+and\+inbox/);

  // The row opens its detail, named in the address.
  await page.getByTestId("console-flags-row-mailArchive").click();
  await expect(page).toHaveURL(/flag=mailArchive/);
  const panel = page.getByTestId("console-flags-detail");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Default from deploy settings")).toBeVisible();
  await expect(panel.getByTestId("console-flags-overrides")).toContainText("Harbour Studio");
  await expect(panel.getByTestId("console-flags-overrides")).toContainText("Pine Bakery");
  await expect(panel.getByTestId("console-flags-global-reset")).toBeDisabled();

  await panel.getByTestId("console-flags-global-on").click();
  const form = page.getByTestId("reason-dialog");
  await expect(form).toBeVisible();
  await form.getByTestId("console-flags-lock").check();
  await form.getByLabel("Reason").fill("Roll out archive to everyone");
  await form.getByRole("button", { name: "Save for everyone" }).click();
  await expect(form).toBeHidden();
  await expect.poll(() => calls.find((c) => c.url.endsWith("/flags/mailArchive/global"))).toMatchObject({
    method: "PUT", body: { value: true, locked: true, reason: "Roll out archive to everyone" },
  });
});

test("a read only operator sees the flags but no change buttons", async ({ page }) => {
  await signUp(page, "Rory Readonly");
  await mockFlags(page, "ops_readonly");
  await page.goto("/console/flags?flag=mailArchive");
  const panel = page.getByTestId("console-flags-detail");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText("Only owners can change the setting for everyone.")).toBeVisible();
  await expect(panel.getByTestId("console-flags-global-on")).toHaveCount(0);
  await expect(panel.getByTestId("console-flags-overrides")).toContainText("Harbour Studio");
  await expect(panel.getByRole("button", { name: "Remove" })).toHaveCount(0);
});

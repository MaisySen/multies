import { test, expect } from "@playwright/test";

/**
 * R33 premium pass for admins and guests: the operator console asks for a suspend reason and a send cap in
 * themed dialogs (no window.prompt), checks the input before it saves, and destructive row actions take two taps.
 * The admin overview is mocked so no platform admin account is needed.
 */
const overview = {
  totals: { users: 1204, workspaces: 12, domains: 9, mailboxes: 23, deliveries24h: 310 },
  tenants: [{ id: "org_e2e", name: "Harbour Studio", plan: "team", isDemo: false, createdAt: new Date().toISOString(), members: 4, agents: 1, domains: 2, suspendedAt: null, suspendedReason: null, sendCapDaily: null, pastDueSince: null }],
  integrations: { sentryApi: true, sentryWeb: false, outbound: "resend", billing: true, billingTestMode: false, auth0: false, google: true, github: false },
};

async function signUp(page: import("@playwright/test").Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-uiadm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

test("operator console: stat tiles, integrations count, suspend and send cap in themed dialogs", async ({ page }) => {
  const calls: { url: string; body: unknown }[] = [];
  await page.route("**/api/admin/overview", (r) => r.fulfill({ json: overview }));
  await page.route("**/api/admin/workspaces/org_e2e/**", async (r) => { calls.push({ url: r.request().url(), body: r.request().postDataJSON() }); await r.fulfill({ json: { ok: true } }); });
  let nativeDialog = false;
  page.on("dialog", (d) => { nativeDialog = true; void d.dismiss(); });
  await signUp(page, "Olive Operator");
  await page.goto("/app/admin");
  await expect(page.getByRole("heading", { name: "Operator console", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("1,204", { exact: true })).toBeVisible(); // grouped digits on the Users tile
  await expect(page.getByText("4 of 8", { exact: true })).toBeVisible(); // integrations on

  // Suspend: an empty reason is refused inside the dialog, then a real reason is sent.
  await page.getByRole("button", { name: "Suspend", exact: true }).click();
  const suspend = page.getByRole("dialog", { name: "Suspend Harbour Studio?" });
  await expect(suspend).toBeVisible();
  await suspend.getByRole("button", { name: "Suspend workspace" }).click();
  await expect(suspend.getByRole("alert")).toHaveText("Give a short reason.");
  await suspend.getByLabel("Reason").fill("Unusual sending volume");
  await suspend.getByRole("button", { name: "Suspend workspace" }).click();
  await expect(suspend).toBeHidden();
  await expect.poll(() => calls.find((c) => c.url.endsWith("/suspend"))?.body).toEqual({ reason: "Unusual sending volume" });

  // Send cap: letters are refused, a number is saved, empty means the plan limit.
  await page.getByRole("button", { name: "Set cap" }).click();
  const cap = page.getByRole("dialog", { name: "Daily send cap" });
  await cap.getByLabel("Recipients a day").fill("lots");
  await cap.getByRole("button", { name: "Save cap" }).click();
  await expect(cap.getByRole("alert")).toHaveText("Enter a whole number, or leave it empty.");
  await cap.getByLabel("Recipients a day").fill("250");
  await cap.getByRole("button", { name: "Save cap" }).click();
  await expect(cap).toBeHidden();
  await expect.poll(() => calls.find((c) => c.url.endsWith("/send-cap"))?.body).toEqual({ cap: 250 });
  expect(nativeDialog).toBe(false);
});

test("team: revoking a pending invitation takes two taps and shows Revoke? in between", async ({ page }) => {
  await signUp(page, "Tara Team");
  const headers = { origin: new URL(page.url()).origin };
  const r = await page.request.post("/api/team/invites", { data: { email: `revoke-${Date.now()}@example.com`, role: "member", mailboxIds: [] }, headers });
  expect(r.status()).toBe(201);
  await page.goto("/app/settings/team");
  const revoke = page.getByRole("button", { name: /^Revoke invitation for revoke-/ });
  await expect(revoke).toBeVisible({ timeout: 15_000 });
  await revoke.click();
  await expect(revoke).toHaveText("Revoke?");
  await expect(page.getByText(/^revoke-.*@example\.com/)).toBeVisible(); // still there after one tap
  await revoke.click();
  await expect(page.getByText("No pending invitations")).toBeVisible();
});

test("invite page: workspace mark, role and expiry in one summary", async ({ page, browser }) => {
  await signUp(page, "Ines Inviter");
  const headers = { origin: new URL(page.url()).origin };
  const email = `join-${Date.now()}@example.com`;
  const inv = await (await page.request.post("/api/team/invites", { data: { email, role: "admin", mailboxIds: [] }, headers })).json();
  const token = JSON.stringify(inv).match(/invite\/([A-Za-z0-9_-]+)/)?.[1];
  expect(token).toBeTruthy();
  const anon = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const p = await anon.newPage();
  await p.goto(`/invite/${token}`);
  await expect(p.getByRole("heading", { level: 1 })).toContainText("Join ");
  await expect(p.getByText("Ines Inviter invited you to work together in Multies.")).toBeVisible();
  await expect(p.getByText("Admin", { exact: true })).toBeVisible();
  await expect(p.getByText("Link works until")).toBeVisible();
  await expect(p.getByRole("link", { name: "Create your account" })).toBeVisible();
  await anon.close();
});

test("guest: project header shows the key and an empty state; a dead link explains itself", async ({ page, browser }) => {
  await signUp(page, "Gus Guesthost");
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  const project = (await (await page.request.post("/api/projects", { data: { name: "Harbour fit out", key: "HFO" }, headers })).json()).project as { id: string };
  const gi = await (await page.request.post("/api/guests", { data: { projectId: project.id, email: `maria-${Date.now()}@example.com`, name: "Maria" }, headers })).json();
  const g = await browser.newContext({ baseURL: origin });
  const gp = await g.newPage();
  await gp.goto(new URL(gi.inviteUrl).pathname);
  await expect(gp).toHaveURL(/\/guest$/, { timeout: 15_000 });
  await expect(gp.getByTestId("guest-project")).toHaveText("Harbour fit out");
  await expect(gp.getByText("HFO", { exact: true })).toBeVisible();
  await expect(gp.getByText("No tasks yet")).toBeVisible();
  await gp.goto("/g/not-a-real-token");
  await expect(gp.getByRole("heading", { name: "This invite link doesn't work" })).toBeVisible();
  await expect(gp.getByRole("link", { name: "Go to Multies" })).toBeVisible();
  await g.close();
});

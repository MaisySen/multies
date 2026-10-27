import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * R41 (MB-221, MB-202): joining from an invite, counted. Against the local server with the identity provider
 * faked in process (e2e/support/idp-server.ts). The provider's own sign up form is one step in real life
 * (email and password); here the fake answers it at once.
 */
const BASE = `http://localhost:${process.env.E2E_IDP_PORT ?? "8790"}`;
test.skip(!!process.env.E2E_BASE_URL, "needs the local fake identity provider");

async function idpRoute(page: Page, email: string, name?: string, seen?: URL[]) {
  await page.route("https://idp.multies.test/**", async (route) => {
    const url = new URL(route.request().url());
    seen?.push(url);
    const code = Buffer.from(JSON.stringify({ nonce: url.searchParams.get("nonce"), email, ...(name ? { name } : {}) })).toString("base64url");
    await route.fulfill({ status: 302, headers: { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` } });
  });
}

async function owner(browser: Browser, tag: string) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await idpRoute(page, `olive-${tag}@example.com`, "Olive Owner");
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Multies" }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  const headers = { origin: BASE };
  await page.request.patch(`${BASE}/api/account/preferences`, { data: { timezone: "UTC", locale: "en" }, headers });
  expect((await page.request.patch(`${BASE}/api/org`, { data: { name: `Harbor ${tag}` }, headers })).status()).toBe(200);
  const invite = async (email: string) => {
    const inv = await page.request.post(`${BASE}/api/team/invites`, { data: { email, role: "member" }, headers });
    expect(inv.status(), await inv.text()).toBe(201);
    return (await inv.json()).link.split("/invite/")[1] as string;
  };
  return { ctx, page, invite };
}

test("an invited newcomer is in the inviting workspace in 2 taps plus the provider's form, with no setup", async ({ browser }) => {
  const tag = Math.random().toString(36).slice(2, 8);
  const o = await owner(browser, tag);
  const email = `sam-${tag}@example.com`;
  const token = await o.invite(email);

  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  const seen: URL[] = [];
  await idpRoute(page, email, email, seen); // the hosted page hands over the email as the name
  let taps = 0;
  await page.goto(`/invite/${token}`); taps++; // 1: the link in the email
  await expect(page.getByRole("heading", { name: `Join Harbor ${tag}` })).toBeVisible();
  await page.getByTestId("invite-primary").click(); taps++; // 2: Sign up and join
  // (3: the provider's sign up form, answered by the fake)
  await page.waitForURL(/\/app\/my-work/, { timeout: 20_000 });
  expect(seen[0].searchParams.get("screen_hint")).toBe("signup");
  expect(seen[0].searchParams.get("login_hint")).toBe(email);
  await expect(page.getByText(`You joined Harbor ${tag}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: /How do you want to use email|Welcome/ })).toHaveCount(0);
  // MB-224: no raw email local part in the greeting.
  await expect(page.getByRole("heading", { level: 1 }).first()).not.toContainText("sam-");
  const me = await (await page.request.get(`${BASE}/api/account/me`)).json();
  expect(me.organization).toMatchObject({ name: `Harbor ${tag}`, role: "member" });
  expect(me.onboarding.needed).toBe(false);
  const ws = await (await page.request.get(`${BASE}/api/account/workspaces`)).json();
  expect(ws.workspaces).toHaveLength(1); // no personal workspace was made
  expect(taps).toBeLessThanOrEqual(3);
  await ctx.close();
  await o.ctx.close();
});

test("the invite survives the confirmation email: /login?confirmed=1 signs in and lands joined", async ({ browser }) => {
  const tag = Math.random().toString(36).slice(2, 8);
  const o = await owner(browser, tag);
  const email = `kim-${tag}@example.com`;
  const token = await o.invite(email);
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  // First visit: the provider holds back the unconfirmed account (it answers the callback with an error).
  await page.route("https://idp.multies.test/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ status: 302, headers: { location: `${url.searchParams.get("redirect_uri")}?error=access_denied&error_description=${encodeURIComponent("Please verify your email before logging in.")}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` } });
  });
  await page.goto(`/invite/${token}`);
  await page.getByTestId("invite-primary").click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });
  await expect(page.getByText(/confirm|verify/i).first()).toBeVisible();
  // The person confirms in their inbox; the provider's "Back to Multies" opens /login?confirmed=1.
  await page.unroute("https://idp.multies.test/**");
  await idpRoute(page, email, "Kim Lee");
  await page.goto("/login?confirmed=1");
  await page.waitForURL(/\/app\/my-work/, { timeout: 20_000 });
  const me = await (await page.request.get(`${BASE}/api/account/me`)).json();
  expect(me.organization).toMatchObject({ name: `Harbor ${tag}`, role: "member" });
  await ctx.close();
  await o.ctx.close();
});

test("MB-222: a failed callback lands on the sign in page with Try again, never JSON", async ({ page }) => {
  await page.goto(`${BASE}/api/auth/callback/auth0?code=bad&state=bad`);
  await page.waitForURL(/\/login\?error=/);
  await expect(page.getByTestId("signin-failed")).toContainText("We couldn't finish signing you in. Try again.");
  await expect(page.getByTestId("signin-try-again")).toBeVisible();
  await expect(page.locator("body")).not.toContainText('{"error"');
});

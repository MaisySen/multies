import { test, expect } from "@playwright/test";

/**
 * Sign in through the identity provider, end to end, against a local server whose provider
 * endpoints are faked in process (e2e/support/idp-server.ts). Local only.
 */
const BASE = `http://localhost:${process.env.E2E_IDP_PORT ?? "8790"}`;
test.skip(!!process.env.E2E_BASE_URL, "needs the local fake identity provider");

test("Continue with Multies goes to the provider with PKCE and comes back signed in", async ({ page }) => {
  let authorize: URL | null = null;
  await page.route("https://idp.multies.test/**", async (route) => {
    const url = new URL(route.request().url());
    authorize = url;
    const code = Buffer.from(JSON.stringify({ nonce: url.searchParams.get("nonce"), email: "pat@example.com" })).toString("base64url");
    const back = `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`;
    await route.fulfill({ status: 302, headers: { location: back } });
  });
  await page.goto(`${BASE}/login`);
  await expect(page.getByRole("button", { name: "Continue with Multies" })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(page.getByText(/auth0/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Continue with Multies" }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  expect(authorize).not.toBeNull();
  const q = authorize!.searchParams;
  expect(authorize!.pathname).toBe("/authorize");
  expect(q.get("response_type")).toBe("code");
  expect(q.get("client_id")).toBe("e2e-web");
  expect(q.get("code_challenge_method")).toBe("S256");
  expect(q.get("code_challenge")?.length).toBe(43);
  expect(q.get("state")).toBeTruthy();
  expect(q.get("nonce")).toBeTruthy();
  expect(q.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/auth0`);
  const me = await page.request.get(`${BASE}/api/account/me`);
  expect(me.status()).toBe(200);
  expect((await me.json()).session.loginMethod).toBe("auth0");
});

test("Create account opens the provider's sign up screen", async ({ page }) => {
  let hint: string | null = null;
  await page.route("https://idp.multies.test/**", async (route) => {
    hint = new URL(route.request().url()).searchParams.get("screen_hint");
    await route.fulfill({ status: 200, body: "provider page", headers: { "content-type": "text/plain" } });
  });
  await page.goto(`${BASE}/signup`);
  await page.getByRole("button", { name: "Sign up with email" }).click(); // R40 (MB-213): the heading keeps "Create your account"
  await expect.poll(() => hint).toBe("signup");
});

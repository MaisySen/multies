import { test, expect, type Page } from "@playwright/test";

/**
 * Round 25: "Continue with Google" and "Continue with Microsoft", end to end against the local
 * server whose identity provider is faked in process (e2e/support/idp-server.ts). The provider's
 * authorize page is intercepted: it checks the connection the button asked for and answers as
 * Google or Microsoft would through the provider (subject google-oauth2|... or windowslive|...).
 */
const BASE = `http://localhost:${process.env.E2E_IDP_PORT ?? "8790"}`;
test.skip(!!process.env.E2E_BASE_URL, "needs the local fake identity provider");

async function answerAs(page: Page, seen: string[], who: (connection: string | null) => { sub: string; email: string; name: string; email_verified?: boolean }) {
  await page.unroute("https://idp.multies.test/**");
  await page.route("https://idp.multies.test/**", async (route) => {
    const url = new URL(route.request().url());
    const connection = url.searchParams.get("connection");
    seen.push(connection ?? "");
    const code = Buffer.from(JSON.stringify({ nonce: url.searchParams.get("nonce"), ...who(connection) })).toString("base64url");
    await route.fulfill({ status: 302, headers: { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` } });
  });
}

/**
 * The provider sign in start allows 3 tries per 10 seconds per address (Better Auth's default for
 * /sign-in/*), and this spec signs in 6 times. Each click comes from its own test address (the
 * local server trusts X-Forwarded-For), so the spec never waits and never eats the other specs' allowance.
 */
let ip = 0;
async function freshAddress(page: Page) {
  ip++;
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `10.25.${Math.floor(Math.random() * 200)}.${ip}` });
}

async function myId(page: Page) {
  const me = await page.request.get(`${BASE}/api/account/me`);
  expect(me.status()).toBe(200);
  return (await me.json()).user.id as string;
}

test("Continue with Google signs in and lands on My Work; the same email later is the same account", async ({ page, context }) => {
  const email = `gwen.${Date.now()}@example.com`;
  const seen: string[] = [];
  await answerAs(page, seen, (connection) => ({ sub: `${connection ?? "auth0"}|${email}`, email, name: "Gwen Park" }));

  await page.goto(`${BASE}/login`);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Microsoft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Multies" })).toBeVisible();
  await page.screenshot({ path: "/home/user/tab/files/multies-r25/r25-auth.png" });

  await freshAddress(page);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.waitForURL(/\/app\/my-work/, { timeout: 20_000 });
  expect(seen).toEqual(["google-oauth2"]);
  const first = await myId(page);

  // Sign out, then Google again: same person.
  await context.clearCookies();
  await page.goto(`${BASE}/login`);
  await freshAddress(page);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.waitForURL(/\/app\/my-work/, { timeout: 20_000 });
  expect(await myId(page)).toBe(first);

  // Microsoft with the same verified address, then the plain provider sign in: still the same person.
  await context.clearCookies();
  await page.goto(`${BASE}/signup`);
  await freshAddress(page);
  await page.getByRole("button", { name: "Continue with Microsoft" }).click();
  await page.waitForURL(/\/app\/my-work/, { timeout: 20_000 });
  expect(await myId(page)).toBe(first);
  await context.clearCookies();
  await page.goto(`${BASE}/login`);
  await freshAddress(page);
  await page.getByRole("button", { name: "Continue with Multies" }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  expect(await myId(page)).toBe(first);
  expect(seen).toEqual(["google-oauth2", "google-oauth2", "windowslive", ""]);
});

test("an unverified Microsoft email for an existing account does not sign in and says why", async ({ page, context }) => {
  const email = `uma.${Date.now()}@example.com`;
  const seen: string[] = [];
  await answerAs(page, seen, (connection) => ({ sub: `${connection ?? "auth0"}|${email}`, email, name: "Uma Reed" }));
  await page.goto(`${BASE}/login`);
  await freshAddress(page);
  await page.getByRole("button", { name: "Continue with Multies" }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await context.clearCookies();

  await answerAs(page, seen, (connection) => ({ sub: `${connection}|${email}`, email, name: "Someone Else", email_verified: false }));
  await page.goto(`${BASE}/login`);
  await freshAddress(page);
  await page.getByRole("button", { name: "Continue with Microsoft" }).click();
  await expect(page.getByTestId("social-not-linked")).toBeVisible({ timeout: 20_000 });
  expect((await page.request.get(`${BASE}/api/account/me`)).status()).toBe(401);
});

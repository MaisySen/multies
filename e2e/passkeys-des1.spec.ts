/**
 * DES1 passkeys end to end (runs only with PASSKEY_DES1=on): Chrome's virtual authenticator stands in for Face ID.
 * Add a passkey in Account and security, sign out, sign in with it, see a wrong origin refused, then remove it.
 */
import { test, expect } from "@playwright/test";

test.skip(process.env.PASSKEY_DES1 !== "on", "PASSKEY_DES1 is off");
const uniq = () => Math.random().toString(36).slice(2, 8);

test("passkey: add, sign in, wrong origin refused, remove", async ({ browser, baseURL }) => {
  const base = baseURL!;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const headers = { origin: new URL(base).origin };
  const email = `pk-${uniq()}@acme.io`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Pat Passkey", email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);

  await page.goto("/app/settings/account");
  const section = page.getByTestId("passkeys-des1");
  await expect(section.getByTestId("passkeys-empty")).toBeVisible();
  await page.getByTestId("passkey-add").click();
  await expect(section.getByTestId("passkey-row")).toHaveCount(1);

  await ctx.clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(/\/app\//);
  const me = await page.request.get("/api/account/me");
  expect((await me.json()).user.email).toBe(email);

  // The same app on another origin (127.0.0.1 is not this deployment's address): the passkey is refused, with words.
  const other = base.replace("localhost", "127.0.0.1");
  const p2 = await ctx.newPage();
  const cdp2 = await ctx.newCDPSession(p2);
  await cdp2.send("WebAuthn.enable");
  await cdp2.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await p2.goto(`${other}/login`);
  await p2.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(p2.getByTestId("passkey-sign-in").getByRole("alert")).toBeVisible();
  await expect(p2).toHaveURL(/\/login/);
  await p2.close();

  await page.goto("/app/settings/account");
  await section.getByRole("button", { name: /^Remove / }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(section.getByTestId("passkeys-empty")).toBeVisible();
  await ctx.close();
});

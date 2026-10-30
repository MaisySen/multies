import { test, expect } from "@playwright/test";

/**
 * R39 security hotfix: "Try the live demo" works when email and password sign up is off, as on
 * multies.si. Runs against the local server with the identity provider on (password sign up off).
 * With E2E_BASE_URL set (staging or production, E2E_ALLOW_REMOTE=1 --grep demo-prod) it opens one demo there.
 */
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_IDP_PORT ?? "8790"}`;

test("demo-prod: Try the live demo opens the demo workspace without password sign up", async ({ page }) => {
  if (!process.env.E2E_BASE_URL) {
    // Password sign up really is off on this server.
    const signup = await page.request.post(`${BASE}/api/auth/sign-up/email`, { data: { name: "X", email: `x${Date.now()}@example.com`, password: "a-strong-password" }, headers: { origin: BASE } });
    expect(signup.status()).not.toBe(200);
  }
  await page.goto(`${BASE}/`);
  const demoAnswer = page.waitForResponse((r) => r.url().endsWith("/api/account/demo") && r.request().method() === "POST", { timeout: 30_000 });
  await page.getByRole("button", { name: "Try the live demo" }).first().click();
  const res = await demoAnswer;
  expect(res.status(), await res.text().catch(() => "")).toBe(201);
  await page.waitForURL(/\/app/, { timeout: 30_000 });
  const me = await page.request.get(`${BASE}/api/account/me`);
  expect(me.status()).toBe(200);
  const body = await me.json();
  expect(body.organization).toMatchObject({ isDemo: true, name: "Northwind Labs" });
  await expect(page.getByText("Northwind Labs").first()).toBeVisible({ timeout: 20_000 });
});

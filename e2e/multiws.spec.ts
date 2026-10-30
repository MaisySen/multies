import { test, expect } from "@playwright/test";

/**
 * Multiws (27 Oct 2026): one account in two workspaces switches both ways from the sidebar, the page shows the
 * workspace switched to straight away, and a switch that fails says so instead of doing nothing. Local only.
 */
test.skip(!!process.env.E2E_BASE_URL, "local only");
let visitor = 0;
const ip = () => `10.147.${test.info().workerIndex % 200}.${++visitor}`;

test("one account in two workspaces switches both ways, and a failed switch says so", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Mo Multi", email: `mo-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/org", { data: { name: `North ${tag}` }, headers })).status()).toBe(200);
  expect((await page.request.post("/api/account/workspaces", { data: { name: `South ${tag}` }, headers })).status()).toBe(201);

  const switcher = () => page.getByRole("button", { name: new RegExp(`(North|South) ${tag}`) }).first();
  const pick = async (name: string) => {
    await switcher().click();
    await page.getByTestId("workspace-option").filter({ hasText: name }).click();
  };
  await page.goto("/app");
  await expect(switcher()).toContainText(`South ${tag}`, { timeout: 15_000 });

  await pick(`North ${tag}`);
  await expect(switcher()).toContainText(`North ${tag}`);
  expect((await (await page.request.get("/api/account/me")).json()).organization.name).toBe(`North ${tag}`);

  await pick(`South ${tag}`);
  await expect(switcher()).toContainText(`South ${tag}`);
  expect((await (await page.request.get("/api/account/me")).json()).organization.name).toBe(`South ${tag}`);
  // After a reload (a fresh page, as after signing in again) the same workspace is open.
  await page.reload();
  await expect(switcher()).toContainText(`South ${tag}`, { timeout: 15_000 });

  // A switch the server refuses shows a message and leaves the person where they were.
  await page.route("**/api/account/workspaces/*/switch", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Couldn't switch just now. Try again in a minute." } }) }));
  await pick(`North ${tag}`);
  await expect(page.getByTestId("workspace-switch-error")).toBeVisible();
  await expect(switcher()).toContainText(`South ${tag}`);
  await page.unroute("**/api/account/workspaces/*/switch");
  await pick(`North ${tag}`);
  await expect(switcher()).toContainText(`North ${tag}`);
  await expect(page.getByTestId("workspace-switch-error")).toHaveCount(0);
  await ctx.close();
});

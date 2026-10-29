import { test, expect } from "@playwright/test";

/**
 * R58 (MB-245): one browser, two tabs. Switching workspace in one tab puts a calm Reload banner in the other, which
 * then sends no write (so nothing can go to the wrong workspace and no "Project not found." appears), keeps the typed
 * title, and Reload copies that text and opens the workspace now active. Phone 390 light and dark shots. Local only.
 */
test.skip(!!process.env.E2E_BASE_URL, "local only");
let visitor = 0;
const ip = () => `10.158.${test.info().workerIndex % 200}.${++visitor}`;
const SHOTS = "/home/user/tab/files/multies-r58";

test("a tab behind a workspace switch made in another tab shows Reload and sends no write", async ({ browser }) => {
  test.setTimeout(90_000);
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() }, viewport: { width: 390, height: 844 }, colorScheme: "light" });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(base).origin });
  const one = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await one.request.post("/api/auth/sign-up/email", { data: { name: "Tia Tabs", email: `tia-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await one.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  expect((await one.request.patch("/api/org", { data: { name: `North ${tag}` }, headers })).status()).toBe(200);
  expect((await one.request.post("/api/account/workspaces", { data: { name: `South ${tag}` }, headers })).status()).toBe(201);

  // Tab one shows South (the workspace just made) on its task list.
  await one.goto("/app/tasks");
  await expect(one.getByRole("button", { name: "New task" }).first()).toBeVisible({ timeout: 20_000 });
  await expect(one.getByTestId("workspace-switched-banner")).toHaveCount(0);

  // Tab two switches to North.
  const two = await ctx.newPage();
  await two.goto("/app");
  const chip = two.getByRole("button", { name: new RegExp(`South ${tag}`) }).first();
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await chip.click();
  await two.getByTestId("workspace-option").filter({ hasText: `North ${tag}` }).click();
  await expect(two.getByRole("button", { name: new RegExp(`North ${tag}`) }).first()).toBeVisible({ timeout: 15_000 });
  await expect(two.getByTestId("workspace-switched-banner")).toHaveCount(0); // the tab that switched is up to date

  // Tab one hears it at once, with no reload and no request of its own.
  const banner = one.getByTestId("workspace-switched-banner");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText(`You switched to North ${tag} in another tab.`);
  await one.screenshot({ path: `${SHOTS}/workspace-after-switched-banner-phone-light.png` });
  await one.emulateMedia({ colorScheme: "dark" });
  await one.screenshot({ path: `${SHOTS}/workspace-after-switched-banner-phone-dark.png` });
  await one.emulateMedia({ colorScheme: "light" });

  // Creating a task in tab one sends nothing to the server and keeps the title.
  const writes: string[] = [];
  one.on("request", (r) => { if (r.url().includes("/api/") && r.method() !== "GET") writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await one.getByRole("button", { name: "New task" }).first().click();
  const title = one.getByPlaceholder("What needs doing?");
  await title.fill("Call the printer about proofs");
  await one.getByRole("button", { name: /^(Create task|Add task)$/ }).click();
  await expect(one.getByText(`You switched to North ${tag} in another tab. Reload to keep working here.`)).toHaveCount(1);
  await expect(one.getByText("Project not found.")).toHaveCount(0);
  await expect(title).toHaveValue("Call the printer about proofs");
  expect(writes.filter((w) => w.startsWith("POST /api/tasks"))).toEqual([]);
  // The open dialog makes the page inert, so the same strip and Reload show inside it.
  await expect(one.getByTestId("workspace-switched-banner-dialog")).toBeVisible();
  await one.screenshot({ path: `${SHOTS}/workspace-after-switched-blocked-phone-light.png` });
  await one.emulateMedia({ colorScheme: "dark" });
  await one.screenshot({ path: `${SHOTS}/workspace-after-switched-blocked-phone-dark.png` });
  await one.emulateMedia({ colorScheme: "light" });

  // Reload copies the typed title and opens the workspace now active; the banner is gone.
  await one.getByTestId("workspace-switched-reload-dialog").click();
  await one.waitForURL(/\/app$/);
  await expect(one.getByRole("button", { name: new RegExp(`North ${tag}`) }).first()).toBeVisible({ timeout: 20_000 });
  await expect(one.getByTestId("workspace-switched-banner")).toHaveCount(0);
  await expect(one.getByText("What you typed before reloading is copied. Paste it to carry on.")).toBeVisible();
  expect(await one.evaluate(() => navigator.clipboard.readText())).toContain("Call the printer about proofs");

  // Now tab two is the one behind if tab one switches back.
  const chipOne = one.getByRole("button", { name: new RegExp(`North ${tag}`) }).first();
  await chipOne.click();
  await one.getByTestId("workspace-option").filter({ hasText: `South ${tag}` }).click();
  await expect(two.getByTestId("workspace-switched-banner")).toContainText(`You switched to South ${tag} in another tab.`, { timeout: 10_000 });
  await ctx.close();
});

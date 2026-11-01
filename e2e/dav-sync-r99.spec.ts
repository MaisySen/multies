import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R99 end to end: Settings > Calendar, Sync with your phone. Create an app password (keyboard only), see it once,
 * sign in to /dav with it, switch guides, revoke it (then /dav refuses it), the empty and error states, and
 * phone width. With SHOTS_DIR set it saves the UX gate shots at 1280 and 390 in light, dark and Forest.
 */
const DIR = process.env.SHOTS_DIR;
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
test.use({ extraHTTPHeaders: { "x-forwarded-for": ip() } });

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(400);
  await page.locator("#calendar-sync").screenshot({ path: `${DIR}/${name}.png` }).catch(() => page.screenshot({ path: `${DIR}/${name}.png` }));
}
async function axe(page: Page, where: string) {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const basic = (user: string, pw: string) => `Basic ${Buffer.from(`${user}:${pw}`).toString("base64")}`;

test("create an app password with the keyboard, sign in to the calendar server with it, switch guides, revoke it", async ({ page, baseURL, request }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await demo(page);
  await page.goto("/app/settings/calendar");
  const card = page.locator("#calendar-sync");
  await expect(card.getByRole("heading", { name: "Sync with your phone" })).toBeVisible();
  await expect(card.getByTestId("dav-empty")).toBeVisible();
  await expect(card.getByTestId("dav-server")).toHaveValue(/\/dav\/$/);
  await shot(page, "r99-empty-1280-light");
  expect(await axe(page, "empty")).toEqual([]);

  // Keyboard only: focus the button, Enter, type, Enter.
  await card.getByTestId("dav-create").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Create app password")).toBeVisible();
  await expect(dialog.getByTestId("dav-create-submit")).toBeDisabled();
  await page.keyboard.type("Test iPhone");
  await shot(page, "r99-create-1280-light");
  await page.keyboard.press("Enter");
  const pwBox = dialog.getByTestId("dav-password");
  await expect(pwBox).toHaveValue(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
  const pw = await pwBox.inputValue();
  if (DIR) await page.screenshot({ path: `${DIR}/r99-password-1280-light.png` });
  expect(await axe(page, "password dialog")).toEqual([]);
  const username = await dialog.locator("input").nth(2).inputValue();
  await dialog.getByTestId("dav-done").click();
  await expect(dialog).toBeHidden();
  const row = card.getByTestId("dav-list").locator("li").filter({ hasText: "Test iPhone" });
  await expect(row).toContainText("Never used");
  await expect(row).toContainText(pw.slice(-4));

  // The password opens the calendar server (protocol check, as a phone would).
  const principal = await request.fetch(`${baseURL}/dav/principal/`, { method: "PROPFIND", headers: { authorization: basic(username, pw), depth: "0" } });
  expect(principal.status()).toBe(207);
  expect(await principal.text()).toContain("/dav/cal/");
  const cals = await request.fetch(`${baseURL}/dav/cal/`, { method: "PROPFIND", headers: { authorization: basic(username, pw), depth: "1" } });
  expect(await cals.text()).toContain("/dav/cal/tasks/");
  await page.reload();
  await expect(card.getByTestId("dav-list").locator("li").filter({ hasText: "Test iPhone" })).toContainText(/Used/);

  // Guides: tabs by click and by arrow keys; the profile link for iPhone and Mac.
  await expect(card.getByTestId("dav-profile")).toHaveAttribute("href", "/api/dav/profile.mobileconfig");
  await card.getByRole("tab", { name: "Android" }).click();
  await expect(card.getByTestId("dav-guide-steps")).toContainText("free CalDAV and CardDAV sync app");
  await expect(card.getByTestId("dav-profile")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(card.getByRole("tab", { name: "Outlook" })).toHaveAttribute("aria-selected", "true");
  await expect(card.getByTestId("dav-guide-steps")).toContainText("calendar feed above");
  await card.getByRole("tab", { name: "iPhone and iPad" }).click();
  await shot(page, "r99-list-1280-light");
  expect(await axe(page, "list")).toEqual([]);
  expect(await noSideScroll(page)).toBe(true);

  // Dark, Forest, and phone width.
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "r99-list-1280-dark");
  expect(await axe(page, "list dark")).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "r99-list-390-dark");
  expect(await noSideScroll(page)).toBe(true);
  expect(await axe(page, "list 390 dark")).toEqual([]);
  await page.emulateMedia({ colorScheme: "light" });
  await shot(page, "r99-list-390-light");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(500);
  await page.goto("/app/settings/calendar");
  await expect(card.getByTestId("dav-list")).toBeVisible();
  await shot(page, "r99-list-1280-forest");
  expect(await axe(page, "list forest")).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "r99-list-390-forest");
  expect(await noSideScroll(page)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Revoke with a confirm; the server refuses the password at once.
  await card.getByRole("button", { name: "Revoke Test iPhone" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("stops syncing at once");
  await confirm.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(card.getByTestId("dav-empty")).toBeVisible();
  const after = await request.fetch(`${baseURL}/dav/principal/`, { method: "PROPFIND", headers: { authorization: basic(username, pw), depth: "0" } });
  expect(after.status()).toBe(401);
});

test("error state with retry, and no access with the account password", async ({ page, baseURL, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  let fail = true;
  await page.route("**/api/dav/passwords", (route) => (fail && route.request().method() === "GET" ? route.fulfill({ status: 500, body: "{}" }) : route.fallback()));
  await page.goto("/app/settings/calendar");
  const card = page.locator("#calendar-sync");
  await expect(card.getByText("Sync settings did not load")).toBeVisible({ timeout: 15_000 });
  await shot(page, "r99-error-390-light");
  fail = false;
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card.getByTestId("dav-empty")).toBeVisible();
  const wrong = await request.fetch(`${baseURL}/dav/`, { method: "PROPFIND", headers: { authorization: basic("demo@example.com", "a-strong-password"), depth: "0" } });
  expect(wrong.status()).toBe(401);
  expect(wrong.headers()["www-authenticate"]).toContain("Basic");
});

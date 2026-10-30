import { test, expect } from "@playwright/test";

/**
 * R59: with CHAT_CHANNELS off (the production default until Meta setup is done) nothing of chat channels shows.
 * Runs only when the E2E server starts with the switch off: E2E_CHAT_CHANNELS=off npx playwright test this file.
 */
test.skip(process.env.E2E_CHAT_CHANNELS !== "off", "needs the E2E server with CHAT_CHANNELS off");

test("chat channels switched off: no pane, no menu entry, no chat rows, routes 404", async ({ page, context, request }) => {
  test.setTimeout(60_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": "10.159.0.1" });
  expect((await (await request.get("/api/config")).json()).chatChannels).toBe(false);
  expect((await request.get("/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1")).status()).toBe(404);

  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  expect((await page.request.get("/api/channels/status")).status()).toBe(404);

  await page.goto("/app/settings");
  await expect(page.getByRole("link", { name: "Team" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Chat channels" })).toHaveCount(0);
  await page.getByTestId("settings-search").filter({ visible: true }).first().fill("whatsapp");
  await expect(page.getByRole("link", { name: "Chat channels" })).toHaveCount(0);

  // An old link to the pane lands on Settings.
  await page.goto("/app/settings/channels");
  await expect(page).toHaveURL(/\/app\/settings$/);

  // Command menu: no Chat channels entry.
  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog");
  await expect(menu).toBeVisible();
  await page.keyboard.type("Chat channels");
  await expect(menu.getByRole("option", { name: "Chat channels" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The shared inbox is mail only.
  await page.goto("/app/inbox");
  await expect(page.getByRole("heading", { name: "Shared inbox" })).toBeVisible();
  await expect(page.getByText("Mail and customer chats in one place", { exact: false })).toHaveCount(0);
});

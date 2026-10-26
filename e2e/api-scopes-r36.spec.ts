import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R36: a key with per area scopes, made in the scopes sheet, gets 403 insufficient_scope outside its
 * areas and works once "Edit scopes" adds them; the public MCP tool docs page lists, searches and links
 * every tool. Screenshots (desktop and phone, light and dark) go to /home/user/tab/files/multies-r36.
 */
const SHOTS = process.env.R36_SHOTS ?? "/home/user/tab/files/multies-r36";
const ip = () => `10.36.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

/** The cookie notice covers the bottom of the phone shots: dismiss it once per context. */
async function dismissCookies(page: Page) {
  const ok = page.getByRole("button", { name: "OK", exact: true });
  if (await ok.isVisible().catch(() => false)) await ok.click();
}

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

test("create a scoped API key, get insufficient_scope, then edit its scopes", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await demo(page);
  await page.goto("/app/settings/developers");
  await dismissCookies(page);
  await page.getByRole("button", { name: "Create API key" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Name").fill("Standup bot");
  await sheet.getByRole("radio", { name: "Choose areas" }).click();
  await expect(sheet.getByRole("checkbox", { name: "Tasks and projects: read" })).toBeChecked();
  await sheet.getByRole("checkbox", { name: "Chat: post and change" }).check();
  await expect(sheet.getByRole("checkbox", { name: "Chat: read" })).toBeChecked();
  await page.screenshot({ path: `${SHOTS}/agents-after-scopes-sheet-desktop-light.png` });
  await sheet.getByRole("button", { name: "Create" }).click();
  const secret = (await page.getByRole("dialog", { name: "Copy your API key" }).locator("code").first().textContent())!.trim();
  expect(secret).toMatch(/^mm_live_/);
  const h = { authorization: `Bearer ${secret}` };
  expect((await page.request.get("/api/v1/tasks", { headers: h })).status()).toBe(200);
  const denied = await page.request.post("/api/v1/projects", { headers: h, data: { name: "Scoped" } });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).error).toMatchObject({ code: "insufficient_scope", required: "tasks:write" });
  await page.getByRole("button", { name: "Done" }).click();

  const row = page.getByTestId("api-key-row").filter({ hasText: "Standup bot" });
  await expect(row.getByTestId("scope-chip")).toHaveText(["Tasks and projects: read", "Chat: post and change"]);
  await page.screenshot({ path: `${SHOTS}/agents-after-key-chips-desktop-light.png` });
  await row.getByRole("button", { name: "Edit scopes of Standup bot" }).click();
  await page.getByRole("dialog").getByRole("checkbox", { name: "Tasks and projects: create and change" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "Save scopes" }).click();
  await expect(row.getByTestId("scope-chip").first()).toHaveText("Tasks and projects: create and change");
  expect((await page.request.post("/api/v1/projects", { headers: h, data: { name: "Scoped" } })).status()).toBeLessThan(300);

  // Phone and dark shots of the sheet.
  for (const [vp, scheme, name] of [[{ width: 390, height: 844 }, "light", "phone-light"], [{ width: 1440, height: 900 }, "dark", "desktop-dark"], [{ width: 390, height: 844 }, "dark", "phone-dark"]] as const) {
    await page.setViewportSize(vp);
    await page.emulateMedia({ colorScheme: scheme });
    await page.getByRole("button", { name: "Create API key" }).click();
    await page.getByRole("dialog").getByRole("radio", { name: "Choose areas" }).click();
    await page.screenshot({ path: `${SHOTS}/agents-after-scopes-sheet-${name}.png` });
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  }
  await ctx.close();
});

test("the MCP tools page lists, searches and links every tool", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const api = await (await page.request.get("/api/mcp-tools")).json();
  await page.goto("/developers/mcp");
  await expect(page.getByRole("heading", { name: "MCP tools", level: 1 })).toBeVisible();
  await dismissCookies(page);
  await expect(page.getByTestId("mcp-tool")).toHaveCount(api.tools.length, { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/agents-after-mcp-docs-desktop-light.png` });
  await page.getByRole("searchbox", { name: "Search tools" }).fill("create_task");
  await expect(page.locator("#create_task")).toBeVisible();
  await expect(page.locator("#create_task")).toContainText("tasks:write");
  expect(await page.getByTestId("mcp-tool").count()).toBeLessThan(10);
  await page.getByRole("searchbox", { name: "Search tools" }).fill("");
  await page.goto("/developers/mcp#reply");
  await expect(page.locator("#reply")).toBeInViewport({ timeout: 20_000 });
  for (const [vp, scheme, name] of [[{ width: 390, height: 844 }, "light", "phone-light"], [{ width: 1440, height: 900 }, "dark", "desktop-dark"], [{ width: 390, height: 844 }, "dark", "phone-dark"]] as const) {
    await page.setViewportSize(vp);
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/developers/mcp");
    await expect(page.getByTestId("mcp-tool").first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/agents-after-mcp-docs-${name}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/agents");
  await page.getByRole("tab", { name: "Command line agent" }).click();
  await expect(page.getByRole("link", { name: /See every tool/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/agents-after-agents-page-desktop-light.png`, fullPage: false });
  await ctx.close();
});

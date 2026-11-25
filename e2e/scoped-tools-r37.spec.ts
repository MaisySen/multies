import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R37: "Show only the tools this key can use". A key made with picked areas has the option on, shows the
 * tool count and a row chip; the public MCP docs page previews a key's tool list. Shots (before and after,
 * set R37_SHOTS_LABEL) go to SHOTS_ROOT/multies-r37/agents.
 */
const SHOTS = process.env.R37_SHOTS ?? `${SHOTS_ROOT}/multies-r37/agents`;
const LABEL = process.env.R37_SHOTS_LABEL ?? "after";
const ip = () => `10.37.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function dismissCookies(page: Page) {
  const ok = page.getByRole("button", { name: "OK", exact: true });
  if (await ok.isVisible().catch(() => false)) await ok.click();
}
async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}
async function pickAreas(page: Page) {
  await page.getByRole("button", { name: "Create API key" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Name").fill("Standup bot");
  await sheet.getByRole("radio", { name: "Choose areas" }).click();
  await sheet.getByRole("checkbox", { name: "Chat: post and change" }).check();
  return sheet;
}

test("shots of the key sheet and the MCP docs page", async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  for (const [vp, scheme, name] of [[{ width: 1440, height: 900 }, "light", "desktop-light"], [{ width: 390, height: 844 }, "dark", "phone-dark"]] as const) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, extraHTTPHeaders: { "x-forwarded-for": ip() } });
    const page = await ctx.newPage();
    await demo(page);
    await page.goto("/app/settings/developers");
    await dismissCookies(page);
    const sheet = await pickAreas(page);
    await page.waitForTimeout(800);
    await sheet.screenshot({ path: `${SHOTS}/key-sheet-${LABEL}-${name}.png` });
    await page.goto("/developers/mcp");
    await dismissCookies(page);
    await expect(page.getByRole("heading", { name: "All tools" })).toBeVisible({ timeout: 30_000 });
    const preview = page.getByTestId("scope-preview");
    if (await preview.count()) {
      await page.getByRole("heading", { name: "Show only the tools a key can use" }).scrollIntoViewIfNeeded();
      await preview.getByRole("button", { name: "tasks:read" }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/docs-scoped-${LABEL}-${name}.png` });
      await page.locator("article#list_tasks").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/docs-real-result-${LABEL}-${name}.png` });
    } else {
      await page.screenshot({ path: `${SHOTS}/docs-scoped-${LABEL}-${name}.png` });
      await page.locator("article#list_tasks").scrollIntoViewIfNeeded().catch(() => undefined);
      await page.screenshot({ path: `${SHOTS}/docs-real-result-${LABEL}-${name}.png` });
    }
    await ctx.close();
  }
});

test("a key made with picked areas shows only its tools, and the docs preview filters the list", async ({ browser }) => {
  test.skip(LABEL === "before", "the option is new in R37");
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await demo(page);
  await page.goto("/app/settings/developers");
  await dismissCookies(page);
  const sheet = await pickAreas(page);
  const toggle = sheet.getByRole("switch", { name: "Show only the tools this key can use" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(sheet.getByTestId("tool-list-toggle")).toContainText(/Agents see \d+ of \d+ tools/);
  await sheet.getByRole("button", { name: "Create" }).click();
  const secret = (await page.getByRole("dialog", { name: "Copy your API key" }).locator("code").first().textContent())!.trim();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const row = page.getByTestId("api-key-row").filter({ hasText: "Standup bot" });
  await expect(row.getByTestId("tool-list-chip")).toHaveText("Shows only its tools");
  // The key's own view: only tasks and chat tools.
  const view = await (await page.request.get("/api/mcp-tools?view=key", { headers: { authorization: `Bearer ${secret}` } })).json();
  expect(view.tools.length).toBeLessThan(view.total);
  expect(view.tools.every((t: { area: string }) => t.area === "tasks" || t.area === "chat")).toBe(true);
  // Turning it off in Edit scopes removes the chip.
  await row.getByRole("button", { name: "Edit scopes of Standup bot" }).click();
  await page.getByRole("dialog").getByRole("switch", { name: "Show only the tools this key can use" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save scopes" }).click();
  await expect(row.getByTestId("tool-list-chip")).toHaveCount(0);

  await page.goto("/developers/mcp");
  await expect(page.getByRole("heading", { name: "All tools" })).toBeVisible({ timeout: 30_000 });
  // W4: the count fills in once the tool list has loaded; read it then (an empty count read as 0).
  await expect(page.getByTestId("scope-preview-count")).toHaveText(/^[1-9]\d*$/);
  const total = Number(await page.getByTestId("scope-preview-count").textContent());
  await page.getByTestId("scope-preview").getByRole("button", { name: "Read only" }).click();
  await expect(page.getByTestId("scope-preview-count")).not.toHaveText(String(total));
  const readOnly = Number(await page.getByTestId("scope-preview-count").textContent());
  expect(readOnly).toBeLessThan(total);
  await expect(page.locator("article#create_task")).toHaveCount(0);
  await expect(page.locator("article#list_tasks")).toBeVisible();
  await expect(page.locator("article#list_tasks")).toContainText("Real result");
  await ctx.close();
});

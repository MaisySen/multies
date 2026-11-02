import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * TD9 end to end (CLIENT_PORTAL=on, PORTAL_TD9=on, TOOL_FILES=memory, PORTAL_E2E=1): the team shares a project,
 * sets the client's access per area by keyboard, adds a milestone and a private comment; the client sees the live
 * project page update without a reload, keeps the last update when offline with Retry, posts a comment, and loses
 * the page the moment Projects is set to None. SHOTS_DIR: 1280 and 390, light, dark and Forest, with axe.
 */
test.skip(process.env.PORTAL_E2E !== "1" || process.env.PORTAL_TD9 !== "on", "needs a local server with CLIENT_PORTAL and PORTAL_TD9 on");
test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.209.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function anon(browser: Browser, w = 1280, scheme: "light" | "dark" = "light") {
  const ctx = await browser.newContext({ viewport: { width: w, height: w > 500 ? 860 : 844 }, colorScheme: scheme, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  return ctx.newPage();
}
async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const tick = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

let portalPath = "";
let projectUrl = "";

async function clientLink(page: Page) {
  await page.goto(`${portalPath}?tab=people`);
  await page.getByTestId("portal-copy-link").first().click();
  return (await page.getByTestId("portal-link-value").textContent())!.trim();
}

test("team shares a project with access by keyboard, a milestone and a private comment; the client sees it live", async ({ page, browser }) => {
  test.setTimeout(480_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/contacts?tab=portals");
  await page.getByTestId("portal-new").click();
  await page.getByTestId("portal-pick").first().click();
  await page.getByTestId("portal-create").click();
  await expect(page.getByTestId("portal-name")).toBeVisible();
  portalPath = new URL(page.url()).pathname;

  // Share a project.
  await page.getByTestId("portal-share-project").click();
  await page.getByTestId("portal-pick-td9-item").first().click();
  await expect(page.getByTestId("portal-group-project").locator("li")).toHaveCount(1);
  await shot(page, "team-shared-1280-light");

  // Access: Projects to Comment, keyboard only.
  await page.getByRole("tab", { name: "People" }).click();
  await page.getByTestId("portal-access-open").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("portal-access")).toBeVisible();
  await expect(page.getByTestId("access-projects-none")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("access-projects-comment").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("access-projects-comment")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("portal-access-history")).toContainText("Projects from None to Comment");
  await axe(page, "access dialog");
  await shot(page, "team-access-1280-light");
  await page.keyboard.press("Escape");

  // A milestone.
  await page.getByRole("tab", { name: "Shared" }).click();
  await page.getByTestId("portal-milestones-open").click();
  await page.getByTestId("portal-milestones").getByLabel("Milestone", { exact: true }).fill("First draft");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("portal-milestones")).toContainText("First draft");
  await page.keyboard.press("Escape");

  // The client signs in and opens the project.
  const link = await clientLink(page);
  const client = await anon(browser);
  await client.goto(link);
  await client.getByTestId("portal-continue").click();
  await expect(client.getByTestId("portal-space")).toBeVisible();
  await client.getByRole("link", { name: "Projects" }).click();
  await client.getByTestId("portal-project-open").first().click();
  await expect(client.getByTestId("portal-project")).toBeVisible();
  projectUrl = client.url();
  await expect(client.locator("#pv-milestones")).toContainText("First draft");
  await expect(client.locator("#pv-milestones")).toContainText("Open");

  // Live: the team ticks the milestone; the client page updates without a reload.
  await page.goto(portalPath);
  await page.getByTestId("portal-milestones-open").click();
  await page.getByRole("checkbox", { name: "First draft done" }).click();
  await expect(page.getByRole("checkbox", { name: "First draft done" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await tick(client);
  await expect(client.locator("#pv-milestones")).toContainText("Done", { timeout: 10_000 });

  // Offline keeps the last update with Retry; back online, Retry refreshes.
  await client.context().setOffline(true);
  await tick(client);
  await expect(client.locator("#pv-status")).toContainText(/offline|Could not refresh/);
  await expect(client.locator("#pv-retry")).toBeVisible();
  await shot(client, "client-project-offline-1280-light");
  await client.context().setOffline(false);
  await client.locator("#pv-retry").click();
  await expect(client.locator("#pv-status")).toContainText("Updated");
  await expect(client.locator("#pv-retry")).toBeHidden();

  // The client comments (Comment level).
  await client.getByTestId("portal-comment").fill("Love the direction.");
  await client.getByTestId("portal-comment-send").click();
  await expect(client.getByTestId("portal-comments")).toContainText("Love the direction.");

  // The team answers privately; the client sees "Only you and ...".
  await page.getByTestId("portal-thread-open").first().click();
  await expect(page.getByTestId("td9-comments")).toContainText("Love the direction.");
  const opts = await page.getByTestId("td9-to").locator("option").allTextContents();
  const only = opts.find((o) => o.includes("Client"));
  expect(only).toBeTruthy();
  await page.getByTestId("td9-to").selectOption({ label: only! });
  await page.getByTestId("td9-body").fill("A private note for you.");
  await page.getByTestId("td9-send").click();
  await expect(page.getByTestId("td9-private-label").first()).toContainText("Only you and");
  await shot(page, "team-thread-1280-light");
  await page.keyboard.press("Escape");
  await client.reload();
  await expect(client.getByTestId("portal-private")).toContainText("Only you and");
  await axe(client, "client project");
  await shot(client, "client-project-1280-light");

  // Projects to None: the page is gone for the client.
  await page.goto(`${portalPath}?tab=people`);
  await page.getByTestId("portal-access-open").first().click();
  await page.getByTestId("access-projects-none").click();
  await expect(page.getByTestId("access-projects-none")).toHaveAttribute("aria-checked", "true");
  const gone = await client.goto(projectUrl);
  expect(gone?.status()).toBe(404);
  await client.goto(projectUrl.split("/project/")[0]);
  await expect(client.getByRole("link", { name: "Projects" })).toHaveCount(0);
  // Back to Comment for the shots test.
  await page.getByTestId("access-projects-comment").click();
  await expect(page.getByTestId("access-projects-comment")).toHaveAttribute("aria-checked", "true");
  await client.context().close();
  await shots(page, browser);
});

/** Shots and axe: team and client pages at 1280 and 390, light, dark and Forest (same demo workspace). */
async function shots(page: Page, browser: Browser) {
  for (const scheme of ["light", "dark"] as const) {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w > 500 ? 860 : 844 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(portalPath);
      await expect(page.getByTestId("portal-name")).toBeVisible();
      expect(await noHScroll(page)).toBe(true);
      await shot(page, `team-portal-${w}-${scheme}`);
      await axe(page, `team ${w} ${scheme}`);
      const client = await anon(browser, w, scheme);
      const fresh = await clientLink(page); // a one time link per client browser
      await client.goto(fresh);
      await client.getByTestId("portal-continue").click();
      await expect(client.getByTestId("portal-space")).toBeVisible();
      await client.goto(projectUrl);
      await expect(client.getByTestId("portal-project")).toBeVisible();
      expect(await noHScroll(client)).toBe(true);
      await shot(client, `client-project-${w}-${scheme}`);
      await axe(client, `client project ${w} ${scheme}`);
      await client.context().close();
    }
  }
  // Forest.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  for (const w of [1280, 390]) {
    await page.setViewportSize({ width: w, height: w > 500 ? 860 : 844 });
    await page.goto(portalPath);
    await expect(page.getByTestId("portal-name")).toBeVisible();
    await shot(page, `team-portal-${w}-forest`);
    await axe(page, `team forest ${w}`);
  }
}

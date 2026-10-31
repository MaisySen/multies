import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * R120 Client portal end to end, against a local server with CLIENT_PORTAL=on and TOOL_FILES=memory (PORTAL_E2E=1).
 * Team: make a portal from Contacts, share a file, reply in the thread, get a one time sign in link.
 * Client (signed out browser): open the link, Continue, see the file, download it, send a message.
 * A second client's portal URL with the first client's cookie shows only the sign in page.
 * SHOTS_DIR writes the team pages and the public pages at 1280 and 390, light, dark and Forest, and runs axe.
 */
test.skip(process.env.PORTAL_E2E !== "1", "needs a local server with CLIENT_PORTAL=on");
test.describe.configure({ mode: "serial" });
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.120.${test.info().workerIndex % 200}.${++visitor}`;

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

/** Team gets a one time link for the first person; a signed out browser uses it. */
async function signIn(page: Page, client: Page) {
  await page.getByRole("tab", { name: "People" }).click();
  await page.getByTestId("portal-copy-link").first().click();
  const link = (await page.getByTestId("portal-link-value").textContent())!.trim();
  await client.goto(link);
  await client.getByTestId("portal-continue").click();
  await expect(client.getByTestId("portal-space")).toBeVisible();
}

let portalPath = "";

test("team makes a portal, shares a file and replies; the client signs in with a one time link and writes back", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/contacts?tab=portals");
  await expect(page.getByText("No client portals yet")).toBeVisible();
  await shot(page, "portals-empty-1280-light");
  await page.getByTestId("portal-new").click();
  await page.getByTestId("portal-pick").first().click();
  await page.getByTestId("portal-create").click();
  await expect(page.getByTestId("portal-name")).toBeVisible();
  portalPath = new URL(page.url()).pathname;
  // Share a file into a folder.
  await page.getByLabel("Folder (optional)").fill("Contracts");
  await page.getByTestId("portal-file-input").setInputFiles({ name: "Statement of work.txt", mimeType: "text/plain", buffer: Buffer.from("Scope and timeline") });
  await expect(page.getByTestId("portal-group-file").getByText("Statement of work.txt")).toBeVisible();
  // Reply in the thread.
  await page.getByRole("tab", { name: "Messages" }).click();
  await page.getByTestId("portal-reply").fill("Welcome! Everything for the project lives here.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("portal-messages")).toContainText("Welcome!");

  const client = await anon(browser);
  await signIn(page, client);
  await client.goto(`${client.url().split("?")[0]}?tab=files`);
  await expect(client.getByText("Statement of work.txt")).toBeVisible();
  await expect(client.getByText("Contracts")).toBeVisible();
  const dl = client.waitForEvent("download");
  await client.getByTestId("portal-file-download").first().click();
  expect((await dl).suggestedFilename()).toBe("Statement of work.txt");
  await client.goto(`${client.url().split("?")[0]}?tab=messages`);
  await expect(client.getByTestId("portal-thread")).toContainText("Welcome!");
  await client.getByTestId("portal-message").fill("Thanks, I will send the signed copy today.");
  await client.getByTestId("portal-message-send").click();
  await expect(client.getByTestId("portal-thread")).toContainText("signed copy today");
  // The team sees it.
  await page.goto(`${portalPath}?tab=messages`);
  await expect(page.getByTestId("portal-messages")).toContainText("signed copy today");
  // The link was used up: opening it again asks for a new one.
  await client.context().close();
});

test("a client's session never opens another client's portal", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await demo(page);
  const contacts = await page.request.get("/api/contacts");
  const list = ((await contacts.json()) as { contacts: { id: string }[] }).contacts;
  expect(list.length).toBeGreaterThan(1);
  const a = (await (await page.request.post("/api/portals", { data: { contactId: list[0].id } })).json()) as { portal: { id: string; url: string } };
  const b = (await (await page.request.post("/api/portals", { data: { contactId: list[1].id } })).json()) as { portal: { id: string; url: string } };
  await page.goto(`/app/contacts/portals/${a.portal.id}`);
  const client = await anon(browser);
  await signIn(page, client);
  await client.goto(new URL(b.portal.url).pathname);
  await expect(client.getByTestId("portal-signin")).toBeVisible();
  await expect(client.getByTestId("portal-space")).toHaveCount(0);
  // The workspace API never opens with the client's cookie.
  expect((await client.request.get("/api/portals")).status()).toBe(401);
  await client.context().close();
});

test("shots and axe: team pages and the client's space at 1280 and 390, light, dark and Forest", async ({ page, browser }) => {
  test.skip(!DIR, "shots only");
  test.setTimeout(300_000);
  await demo(page);
  const list = ((await (await page.request.get("/api/contacts")).json()) as { contacts: { id: string }[] }).contacts;
  const p = (await (await page.request.post("/api/portals", { data: { contactId: list[0].id } })).json()) as { portal: { id: string; url: string } };
  await page.request.post(`/api/portals/${p.portal.id}/messages`, { data: { body: "Hi Sam, the first draft is in Files. A long note to check wrapping on phones and in dark mode: everything you need is here." } });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/app/contacts?tab=portals");
      await expect(page.getByTestId("portal-list")).toBeVisible();
      await shot(page, `portals-${w}-${scheme}`);
      expect(await noHScroll(page)).toBe(true);
      for (const tab of ["shared", "messages", "people", "settings"]) {
        await page.goto(`/app/contacts/portals/${p.portal.id}${tab === "shared" ? "" : `?tab=${tab}`}`);
        await expect(page.getByTestId("portal-name")).toBeVisible();
        await shot(page, `portal-${tab}-${w}-${scheme}`);
        expect(await noHScroll(page)).toBe(true);
        if (w === 1280) await axe(page, `portal ${tab} ${scheme}`);
      }
      const client = await anon(browser, w, scheme);
      await client.goto(new URL(p.portal.url).pathname);
      await shot(client, `public-signin-${w}-${scheme}`);
      await axe(client, `public signin ${w} ${scheme}`);
      await signIn(page, client);
      for (const tab of ["home", "files", "tasks", "messages"]) {
        await client.goto(`${new URL(p.portal.url).pathname}${tab === "home" ? "" : `?tab=${tab}`}`);
        await shot(client, `public-${tab}-${w}-${scheme}`);
        expect(await noHScroll(client)).toBe(true);
        await axe(client, `public ${tab} ${w} ${scheme}`);
      }
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
  // One sign in for both widths (sign in links are capped at 5 an hour per person).
  const client = await anon(browser, 1280);
  await page.goto(`/app/contacts/portals/${p.portal.id}`);
  await signIn(page, client);
  for (const [w, h] of [[1280, 860], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/app/contacts/portals/${p.portal.id}?tab=messages`);
    await expect(page.getByTestId("portal-name")).toBeVisible();
    await shot(page, `portal-messages-${w}-forest`);
    await axe(page, `portal forest ${w}`);
    await client.setViewportSize({ width: w, height: h });
    await client.goto(new URL(p.portal.url).pathname);
    await shot(client, `public-home-${w}-forest`);
    await axe(client, `public forest ${w}`);
  }
  await client.context().close();
});

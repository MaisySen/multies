import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R109: mail merge plus end to end (lists with consent, newsletter compose, send and schedule, journey build and
 * pause, the unsubscribe link) at 1280 and 390, with axe and shots in light, dark and Forest when SHOTS_DIR is set.
 * Needs a server with Tools on and merge_plus_r109 (MERGE_E2E=1, E2E_BASE_URL=http://localhost:9041); the
 * unsubscribe test reads the recipient token from that server's local database (MERGE_E2E_DB).
 */
test.skip(process.env.MERGE_E2E !== "1", "needs a server with Tools on and merge_plus_r109");
test.describe.configure({ mode: "serial" });
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.219.${test.info().workerIndex % 200}.${++visitor}`;

test.beforeEach(async ({ context }) => { await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() }); });

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

async function axe(page: Page, tag: string) {
  // The email preview is a sandboxed frame of the message itself (no scripts); it is checked as HTML in unit tests, not as app UI.
  // Buttons fade between their disabled and enabled looks; stop motion so axe reads the settled colours, not a mid fade frame.
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.waitForTimeout(100);
  const { violations } = await new AxeBuilder({ page }).include("main").exclude('[data-testid="r109-preview"]').analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${tag}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`);
}

/** A ready list (sender details, mailbox) with people, made through the API. */
async function seed(page: Page, origin: string) {
  const headers = { origin };
  const mailboxes = await (await page.request.get("/api/mailboxes")).json() as { mailboxes?: { id: string }[] } | { id: string }[];
  const mailboxId = (Array.isArray(mailboxes) ? mailboxes : mailboxes.mailboxes ?? [])[0]?.id ?? null;
  const list = await (await page.request.post("/api/tools/campaigns/lists", { headers, data: { name: "Monthly news", mailboxId, senderName: "Acme Pty Ltd", senderAddress: "1 George St, Sydney NSW 2000" } })).json() as { id: string };
  const people = [{ email: "jo.lee@example.com", name: "Jo Lee" }, { email: "sam.wu@example.com", name: "Sam Wu" }, { email: "ana.long-name-for-wrapping-checks@example.com", name: "Ana Maria de los Santos Rodriguez" }];
  expect((await page.request.post(`/api/tools/campaigns/lists/${list.id}/members`, { headers, data: { people, consent: { kind: "express", source: "Signup form" } } })).status()).toBe(200);
  return { list, mailboxId, headers };
}

test("lists: make a list, record consent, add people, invalid and missing consent paths", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/tools/merge?tab=lists");
  await expect(page.getByRole("tab", { name: "Lists" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No lists yet")).toBeVisible();
  await page.getByTestId("r109-new-list").click();
  await page.getByLabel("Name").fill("Customers");
  await page.getByTestId("r109-create-list").click();
  await expect(page).toHaveURL(/\/app\/tools\/merge\/lists\//);
  const settings = page.getByTestId("r109-list-settings");
  await settings.getByLabel("Sender name").fill("Acme Pty Ltd");
  await settings.getByLabel("Contact address").fill("1 George St, Sydney NSW 2000");
  await settings.getByLabel("Sends from").selectOption({ index: 1 });
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(settings.getByRole("button", { name: "Save settings" })).toBeDisabled();
  await page.getByTestId("r109-paste").fill("jo@example.com, Jo Lee\nsam@example.com, Sam Wu\nnot an email");
  await expect(page.getByTestId("r109-add")).toBeDisabled(); // no consent source yet
  await page.getByTestId("r109-consent-source").selectOption("In person");
  await page.getByTestId("r109-add").click();
  await expect(page.getByTestId("r109-add-result")).toContainText("2 added");
  await expect(page.getByTestId("r109-members")).toContainText("Express consent: In person");
  await expect(page.getByTestId("r109-members").getByText("Subscribed")).toHaveCount(2);
  // Keyboard: tabs move with the arrow keys.
  await page.goto("/app/tools/merge?tab=lists");
  await page.getByRole("tab", { name: "Lists" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Journeys" })).toHaveAttribute("aria-selected", "true");
  expect(await axe(page, "lists")).toEqual([]);
  void baseURL;
});

test("newsletter: compose with merge fields, preview, send now, schedule and back to draft", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await demo(page);
  await seed(page, new URL(baseURL!).origin);
  await page.goto("/app/tools/merge");
  await expect(page.getByText("No newsletters yet")).toBeVisible();
  await expect(page.getByTestId("r109-limit")).toContainText("left today");
  await page.getByTestId("r109-new-newsletter").click();
  await page.getByLabel("Name").fill("November news");
  await page.getByTestId("r109-create").click();
  await expect(page).toHaveURL(/\/newsletters\//);
  // Error path: no subject yet.
  await page.getByTestId("r109-send").click();
  await page.getByTestId("r109-send").click();
  await expect(page.getByRole("alert").or(page.getByText("Add a subject"))).toBeVisible();
  await page.getByTestId("r109-subject").fill("News for {{first_name | you}}");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.frameLocator("[data-testid=r109-preview]").getByText("Sent by Acme Pty Ltd")).toBeVisible();
  await expect(page.frameLocator("[data-testid=r109-preview]").getByRole("link", { name: "Unsubscribe" })).toBeVisible();
  await page.getByTestId("r109-send").click();
  await page.getByRole("button", { name: /Send to 3 now/ }).click();
  await expect(page.getByTestId("r109-results")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("r109-results")).toContainText(/of 3/);
  // Schedule a copy, then take it back to draft.
  await page.getByRole("button", { name: "Make a copy" }).click();
  await expect(page.getByText("November news copy").first()).toBeVisible();
  const soon = new Date(Date.now() + 2 * 86_400_000);
  const pad = (x: number) => String(x).padStart(2, "0");
  await page.getByLabel("Send at").fill(`${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T09:00`);
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText("Scheduled").first()).toBeVisible();
  await page.getByRole("button", { name: "Back to draft" }).click();
  await expect(page.getByText("Draft").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete heading" })).toBeEnabled();
  expect(await axe(page, "editor")).toEqual([]);
});

test("journey: build from the welcome series, turn on, pause", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await demo(page);
  await seed(page, new URL(baseURL!).origin);
  await page.goto("/app/tools/merge?tab=journeys");
  await page.getByTestId("r109-new-journey").click();
  await page.getByLabel("Name").fill("Welcome");
  await page.getByTestId("r109-create").click();
  await expect(page).toHaveURL(/\/journeys\//);
  await expect(page.getByTestId("r109-steps").locator("li")).toHaveCount(2);
  await expect(page.getByText("Only if they didn't open the last email")).toBeVisible();
  await page.getByTestId("r109-journey-start").click();
  await expect(page.getByText("On", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  expect(await axe(page, "journey")).toEqual([]);
});

test("unsubscribe link: one tap, taken off every list, shown in Unsubscribes", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  test.skip(!process.env.MERGE_E2E_DB, "needs MERGE_E2E_DB");
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  const { list, headers } = await seed(page, new URL(baseURL!).origin);
  const n = await (await page.request.post("/api/tools/campaigns/newsletters", { headers, data: { listId: list.id, name: "Oct" } })).json() as { id: string };
  await page.request.patch(`/api/tools/campaigns/newsletters/${n.id}`, { headers, data: { subject: "Hi" } });
  expect((await page.request.post(`/api/tools/campaigns/newsletters/${n.id}/schedule`, { headers, data: { at: null } })).status()).toBe(200);
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(process.env.MERGE_E2E_DB!, { readonly: true });
  let token = "";
  for (let i = 0; i < 40 && !token; i++) {
    token = (db.prepare("select token from campaign_recipients where campaign_id = ? and email = 'jo.lee@example.com'").get(n.id) as { token?: string } | undefined)?.token ?? "";
    if (!token) await page.waitForTimeout(500);
  }
  db.close();
  expect(token).toMatch(/^[0-9a-f]{32}$/);
  await page.goto(`/api/campaign-public/u/${token}`);
  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(page.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();
  await page.goto("/app/tools/merge?tab=unsubscribes");
  await expect(page.getByTestId("r109-supp")).toContainText("jo.lee@example.com");
  await page.goto(`/app/tools/merge/lists/${list.id}`);
  await expect(page.getByTestId("r109-members")).toContainText("Unsubscribed");
});

test("shots and axe: 1280 and 390, light, dark and Forest", async ({ page, baseURL }) => {
  test.skip(!DIR, "set SHOTS_DIR for shots");
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await demo(page);
  const { list, headers } = await seed(page, new URL(baseURL!).origin);
  const n = await (await page.request.post("/api/tools/campaigns/newsletters", { headers, data: { listId: list.id, name: "November news" } })).json() as { id: string };
  const j = await (await page.request.post("/api/tools/campaigns/journeys", { headers, data: { listId: list.id, name: "Welcome", starter: "welcome" } })).json() as { id: string };
  const views: [string, string][] = [
    ["newsletters", "/app/tools/merge"], ["lists", "/app/tools/merge?tab=lists"], ["list", `/app/tools/merge/lists/${list.id}`],
    ["editor", `/app/tools/merge/newsletters/${n.id}`], ["journey", `/app/tools/merge/journeys/${j.id}`], ["unsubscribes", "/app/tools/merge?tab=unsubscribes"],
  ];
  const problems: string[] = [];
  const shoot = async (name: string, url: string, tag: string) => {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (wide) problems.push(`${tag} ${name}: sideways scroll`);
    problems.push(...(await axe(page, `${tag} ${name}`)));
    await page.screenshot({ path: `${DIR}/${name}-${tag}.png`, fullPage: true });
  };
  for (const w of [1280, 390]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [name, url] of views) await shoot(name, url, `${w}-${scheme}`);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(500);
  for (const w of [1280, 390]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    for (const [name, url] of views) await shoot(name, url, `${w}-forest`);
  }
  expect(problems).toEqual([]);
});

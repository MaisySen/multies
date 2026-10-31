import { test, expect, chromium, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R119 helpdesk: an admin turns on the website chat, a visitor chats from a page on another site, the agent answers in
 * the shared inbox, solves the ticket and the visitor rates it. Another site cannot use the chat. With SHOTS_DIR set it
 * also saves the UX gate screenshots (1280 and 390, light, dark, Forest) and checks each page with axe.
 */
let visitor = 0;
const ip = () => `10.119.${test.info().workerIndex % 200}.${++visitor}`;
const DIR = process.env.SHOTS_DIR;
const SHOP = "https://shop.example";

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
async function axe(page: Page, where: string, include = "main") {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).include(include).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}

interface Settings { settings: { hours: Record<string, unknown>; widget: Record<string, unknown>; csat: Record<string, unknown> }; widgetKey: string; on: boolean }
async function turnOn(page: Page, origin: string) {
  const headers = { origin };
  const cur = await (await page.request.get("/api/helpdesk/settings")).json() as Settings;
  const r = await page.request.patch("/api/helpdesk/settings", { headers, data: {
    hours: { ...cur.settings.hours, always: true },
    widget: { ...cur.settings.widget, on: true, domains: ["shop.example"], askEmail: "after", title: "Talk to us", greeting: "Hi there. Ask us anything and we usually reply within minutes." },
    csat: { ...cur.settings.csat, on: true },
  } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json() as Settings).widgetKey;
}

// The shop is a page on another site. Chrome keeps public pages away from a local server, so the visitor's browser
// runs with that check off; the app's own allowed domain rule is what the test exercises.
let shopBrowser: Browser | null = null;
test.afterAll(async () => { await shopBrowser?.close(); });
async function shopPage(_b: Browser, baseURL: string, key: string, width = 1280) {
  shopBrowser ??= await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights"] });
  const ctx = await shopBrowser.newContext({ viewport: { width, height: width > 500 ? 800 : 844 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await page.route(`${SHOP}/**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hobart Tea Co</title></head>
<body style="font-family:system-ui;margin:0"><main style="padding:40px;max-width:640px"><h1>Hobart Tea Co</h1><p>Loose leaf tea, packed by hand in Tasmania.</p><p>Free delivery on orders over 60 dollars.</p></main>
<script src="${baseURL}/widget.js" data-key="${key}" async></script></body></html>` }));
  if (process.env.R119_DEBUG) {
    page.on("console", (m) => console.log("DBG console", m.text().slice(0, 200)));
    page.on("response", (r) => console.log("DBG resp", r.status(), r.url().slice(0, 120)));
    page.on("requestfailed", (r) => console.log("DBG failed", r.url().slice(0, 120), r.failure()?.errorText));
  }
  await page.goto(`${SHOP}/pricing`);
  return { ctx, page };
}

test("R119 website chat: visitor chats, agent replies, solves, visitor rates", async ({ page, context, browser, baseURL }) => {
  test.setTimeout(240_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const origin = new URL(page.url()).origin;
  const key = await turnOn(page, origin);

  // Another site cannot use this chat.
  const evil = await page.request.get(`/api/widget/${key}/config`, { headers: { origin: "https://evil.example" } });
  expect(evil.status()).toBe(403);

  // The visitor opens the chat on the shop and asks a question.
  const shop = await shopPage(browser, baseURL!, key);
  const v = shop.page;
  await v.getByRole("button", { name: "Open chat" }).click();
  await expect(v.getByRole("heading", { name: "Talk to us" })).toBeVisible({ timeout: 15_000 });
  await v.getByRole("textbox", { name: "Message" }).fill("Do you ship to Hobart on weekends?");
  await v.getByRole("button", { name: "Send", exact: true }).click();
  await expect(v.getByText("Do you ship to Hobart on weekends?")).toBeVisible();
  await v.getByRole("textbox", { name: "Your email" }).fill("sam.visitor@example.com");
  await v.getByRole("button", { name: "Save email" }).click();
  if (DIR) await v.screenshot({ path: `${DIR}/r119-widget-chat-1280.png` });
  expect(await axe(v, "widget", "body")).toEqual([]);

  // The agent sees a ticket in the shared inbox with its clock, and answers.
  await page.goto("/app/inbox");
  await expect(page.getByTestId("inbox-mode")).toBeVisible({ timeout: 20_000 });
  const row = page.getByTestId("ticket-row").filter({ hasText: "Do you ship to Hobart" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("Unassigned");
  await shot(page, "r119-tickets-1280-light");
  expect(await axe(page, "tickets")).toEqual([]);
  await row.click();
  await expect(page.getByTestId("ticket-panel")).toBeVisible();
  await expect(page.getByTestId("web-chat-log")).toContainText("Do you ship to Hobart on weekends?");
  await page.getByRole("textbox", { name: "Reply to the visitor" }).fill("Yes, we deliver to Hobart on Saturdays. Order by Thursday noon.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByTestId("web-chat-log")).toContainText("Order by Thursday noon");
  // An internal note stays with the team.
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await page.getByRole("textbox", { name: "Internal note" }).fill("Regular customer, add a sample.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByTestId("web-chat-log")).toContainText("Regular customer");
  await page.getByTestId("ticket-panel").getByLabel("Priority").selectOption("high");
  await expect(page.getByTestId("ticket-panel").getByLabel("Priority")).toHaveValue("high");
  await expect(page.getByTestId("ticket-row").filter({ hasText: "Do you ship to Hobart" })).toContainText("High");
  await shot(page, "r119-webchat-1280-light");
  expect(await axe(page, "web chat")).toEqual([]);

  // The visitor gets the reply live, never the note.
  await expect(v.getByText("Order by Thursday noon")).toBeVisible({ timeout: 15_000 });
  await expect(v.getByText("Regular customer")).toHaveCount(0);

  // Solve, then the visitor rates the chat.
  await page.getByTestId("ticket-panel").getByRole("button", { name: "Solve", exact: true }).click();
  await expect(page.getByText(/Solved/).first()).toBeVisible();
  const rating = v.getByRole("group", { name: "Your rating" });
  await expect(rating).toBeVisible({ timeout: 15_000 });
  if (DIR) await v.screenshot({ path: `${DIR}/r119-widget-survey-1280.png` });
  await rating.getByRole("button", { name: "Great" }).click();
  await expect(v.getByRole("status").filter({ hasText: /thank/i })).toBeVisible();

  // The rating shows on the ticket under Solved.
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /^Solved/ }).click();
  await expect(page.getByTestId("ticket-row").filter({ hasText: "Do you ship to Hobart" })).toContainText("Rated great", { timeout: 20_000 });
  await shot(page, "r119-solved-1280-light");
  await shop.ctx.close();
});

test("R119 settings, dark, Forest and phone", async ({ page, context, browser, baseURL }) => {
  test.setTimeout(240_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  // Before: helpdesk off, the shared inbox is exactly as it was.
  await page.goto("/app/inbox");
  await expect(page.getByRole("heading", { name: "Shared inbox" })).toBeVisible();
  await expect(page.getByTestId("inbox-mode")).toHaveCount(0);
  await shot(page, "r119-inbox-before-1280-light");
  const key = await turnOn(page, new URL(page.url()).origin);
  // A ticket to look at.
  const shop = await shopPage(browser, baseURL!, key, 390);
  await shop.page.getByRole("button", { name: "Open chat" }).click();
  await shop.page.getByRole("textbox", { name: "Message" }).fill("Is the Earl Grey back in stock?");
  await shop.page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(shop.page.getByText("Is the Earl Grey back in stock?")).toBeVisible();
  if (DIR) await shop.page.screenshot({ path: `${DIR}/r119-widget-390.png` });

  // Settings: every tab renders for an admin and a macro can be made.
  await page.goto("/app/inbox");
  await page.getByTestId("helpdesk-settings-link").click();
  await expect(page).toHaveURL(/\/app\/inbox\/helpdesk/);
  for (const [tab, name] of [["General", "general"], ["Hours and targets", "hours"], ["Macros", "macros"], ["Website chat", "chat"], ["Survey", "survey"]] as const) {
    await page.getByRole("tab", { name: tab }).click();
    await shot(page, `r119-settings-${name}-1280-light`);
    expect(await axe(page, `settings ${name}`)).toEqual([]);
  }
  await expect(page.getByTestId("widget-snippet")).toHaveCount(0);
  await page.getByRole("tab", { name: "Website chat" }).click();
  await expect(page.getByTestId("widget-snippet")).toContainText(key);
  await page.getByRole("tab", { name: "Macros" }).click();
  await page.getByRole("button", { name: "New macro" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Ask for the order number");
  await page.getByRole("button", { name: "Add a step" }).click();
  await page.getByRole("textbox", { name: "Note" }).fill("Asked for the order number.");
  await page.getByRole("button", { name: "Save macro" }).click();
  await expect(page.getByText("Ask for the order number")).toBeVisible();

  const views = async (suffix: string) => {
    await page.goto("/app/inbox");
    const row = page.getByTestId("ticket-row").filter({ hasText: "Earl Grey" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await shot(page, `r119-tickets-${suffix}`);
    expect(await axe(page, `tickets ${suffix}`)).toEqual([]);
    await row.click();
    await expect(page.getByTestId("ticket-panel")).toBeVisible();
    await shot(page, `r119-webchat-${suffix}`);
    expect(await axe(page, `web chat ${suffix}`)).toEqual([]);
    await page.goto("/app/inbox/helpdesk#chat");
    await shot(page, `r119-settings-chat-${suffix}`);
    expect(await axe(page, `settings ${suffix}`)).toEqual([]);
  };
  // The macro runs from the ticket.
  await page.goto("/app/inbox");
  await page.getByTestId("ticket-row").filter({ hasText: "Earl Grey" }).click();
  await page.getByLabel("Run a macro").selectOption({ label: "Ask for the order number" });
  await expect(page.getByTestId("web-chat-log")).toContainText("Asked for the order number.", { timeout: 15_000 });

  await page.emulateMedia({ colorScheme: "dark" });
  await views("1280-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await views("390-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await views("390-light");
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await views("1280-forest");
  await page.setViewportSize({ width: 390, height: 844 });
  await views("390-forest");
  await shop.ctx.close();
});

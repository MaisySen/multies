import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Round 11 end to end: the integrations page (connect a chat app, pause and remove it, create an
 * incoming webhook and post to it) and, when SCHEDULING_ENABLED is on, the booking page on a phone.
 */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.91.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

test("connects Slack from the catalogue, pauses it and removes it", async () => {
  await page.goto("/app/integrations");
  await expect(page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Integrations" })).toBeVisible();
  await page.getByRole("button", { name: "Connect Slack", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Slack" });
  await dialog.getByLabel("Webhook URL").fill("https://hooks.slack.com/services/T000/B000/e2etest");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("hooks.slack.com")).toBeVisible();
  await page.getByRole("switch", { name: "Send events to Slack" }).click();
  await expect(page.getByText("Paused")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Disconnect Slack" }).click();
  await expect(page.getByText("Nothing connected yet")).toBeVisible();
});

test("creates an incoming webhook and turns a post into a task", async () => {
  await page.goto("/app/integrations");
  await page.getByRole("button", { name: "New incoming webhook" }).click();
  const dialog = page.getByRole("dialog", { name: "New incoming webhook" });
  await dialog.getByLabel("Name").fill("Website enquiries");
  await dialog.getByRole("button", { name: "Create" }).click();
  const url = (await page.getByTestId("hook-url").textContent())!.trim();
  expect(url).toContain("/api/hooks/in/mih_");
  await page.getByRole("button", { name: "Done" }).click();
  const res = await page.request.post(new URL(url).pathname, { data: { title: "E2E enquiry from the website", message: "Two rooms, next week" } });
  expect(res.status()).toBe(201);
  const tasks = (await (await page.request.get("/api/tasks")).json()).tasks as { title: string }[];
  expect(tasks.some((t) => t.title === "E2E enquiry from the website")).toBe(true);
  await page.reload();
  await expect(page.getByText("Working")).toBeVisible();
  await page.getByRole("button", { name: "Recent calls" }).click();
  await expect(page.getByText("Created a task")).toBeVisible();
});

test("sets up a booking page, a guest books on a phone and cancels with the link", async () => {
  const config = await (await page.request.get("/api/config")).json();
  test.skip(!config.scheduling, "SCHEDULING_ENABLED is off on this server");
  await page.goto("/app/scheduling");
  await expect(page.getByRole("link", { name: "Booking page" })).toBeVisible();
  const slug = `e2e-${Date.now().toString(36)}`;
  await page.getByLabel("Link", { exact: true }).fill(slug);
  await page.getByLabel("Title").fill("Intro call");
  await page.getByRole("button", { name: "Create booking page" }).click();
  await expect(page.getByTestId("booking-link")).toContainText(`/book/${slug}`);

  const guest = await ctx.newPage();
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.goto(`/book/${slug}`);
  await expect(guest.getByRole("heading", { name: "Intro call", level: 1 })).toBeVisible();
  await guest.getByRole("button", { name: /times?$/ }).first().click();
  await guest.locator("button[aria-pressed]").filter({ hasText: /\d:\d\d/ }).first().click();
  await guest.getByLabel("Name").fill("Kim Lee");
  await guest.getByLabel("Email").fill("kim@example.com");
  await guest.getByRole("button", { name: "Confirm booking" }).click();
  await expect(guest.getByRole("heading", { name: "You're booked" })).toBeVisible();
  await expect(guest.getByRole("link", { name: "Add to calendar" })).toBeVisible();

  await page.reload();
  await expect(page.getByText("Kim Lee")).toBeVisible();

  await guest.getByRole("link", { name: "Cancel this booking" }).click();
  await guest.getByRole("button", { name: "Cancel booking" }).click();
  await expect(guest.getByRole("heading", { name: "Booking cancelled" })).toBeVisible();
  await guest.close();
});

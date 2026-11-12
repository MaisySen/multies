import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R24.4 Automation recipes end to end: open the Recipes tab, turn on "When a task is done, post in
 * a channel" picking a channel in the small sheet, mark a task done, and see the post in the channel.
 */
let visitor = 0;
const ip = () => `10.124.${test.info().workerIndex % 200}.${++visitor}`;

test("turn on a recipe, finish a task, and the post shows in the channel", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  const project = (await (await page.request.post("/api/projects", { data: { name: "Website", key: "WEB" }, headers })).json()).project as { id: string };
  const channel = (await (await page.request.post("/api/chat/channels", { data: { name: "releases", topic: "What shipped" }, headers })).json()).channel as { id: string };
  // Two more recipes on already, so the page shows a mix of On and ready cards.
  expect((await page.request.post("/api/automations/recipes/assigned_notify/enable", { data: {}, headers })).status()).toBe(200);
  expect((await page.request.post("/api/automations/recipes/day_before_due/enable", { data: {}, headers })).status()).toBe(200);

  await page.goto("/app/automations?tab=rules"); // R90: rules are a tab of the Automations home
  await page.getByRole("tab", { name: "Recipes" }).click();
  await expect(page.getByRole("region", { name: "Tasks" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Mail" })).toBeVisible();
  const card = page.locator('[data-recipe="done_post_channel"]');
  await expect(card).toContainText("When a task is done, post in a channel");
  await expect(page.locator('[data-recipe="assigned_notify"]')).toContainText("On");

  // Search narrows the grid.
  await page.getByLabel("Search recipes").fill("meeting");
  await expect(page.locator('[data-recipe="meeting_ended_task"]')).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByLabel("Search recipes").fill("");

  await card.getByRole("button", { name: "Turn on" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("When a task is done, post in a channel");
  await sheet.getByLabel("Post in which channel").selectOption({ label: "#releases" });
  await sheet.getByRole("button", { name: "Turn on" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(card).toContainText("On");
  await expect(card.getByRole("button", { name: "Edit as rule" })).toBeVisible();

  mkdirSync(`${SHOTS_ROOT}/multies-r24`, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r24/recipes.png`, fullPage: false });

  // The rule is a normal rule on the first tab.
  await page.getByRole("tab", { name: "Your rules" }).click();
  await expect(page.getByText("When a task changes status, post in a channel.").first()).toBeVisible();

  const task = (await (await page.request.post("/api/tasks", { data: { title: "Launch the pricing page", projectId: project.id }, headers })).json()).task as { id: string; ref: string };
  expect((await page.request.patch(`/api/tasks/${task.id}`, { data: { status: "done" }, headers })).status()).toBe(200);

  await page.goto(`/app/chat/${channel.id}`);
  await expect(page.getByRole("region", { name: /^Messages in / }).getByTestId("chat-message").filter({ hasText: `Done: ${task.ref} Launch the pricing page` })).toBeVisible();
  await ctx.close();
});

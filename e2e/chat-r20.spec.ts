import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Round 20 chat polish end to end: two people in one workspace, each in their own browser.
 * One reacts and the other sees it within a few seconds through the normal chat poll; a call
 * starts from the channel in one tap and the join card shows for the other person; search
 * finds a message and jumps to it.
 */
test.describe.configure({ mode: "serial" });
let visitor = 0;
const ip = () => `10.120.${test.info().workerIndex % 200}.${++visitor}`;
const THUMBS = "\u{1F44D}";
let a: Page, b: Page, ctxA: BrowserContext, ctxB: BrowserContext, channelId = "";

async function person(browser: Browser, email: string, name: string) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const r = await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers });
  expect(r.status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
}

test.beforeAll(async ({ browser }) => {
  const tag = Math.random().toString(36).slice(2, 8);
  const first = await person(browser, `ada-${tag}@example.com`, "Ada Owner");
  ctxA = first.ctx; a = first.page;
  const invite = await (await a.request.post("/api/team/invites", { data: { email: `ben-${tag}@example.com`, role: "member" }, headers: first.headers })).json();
  const second = await person(browser, `ben-${tag}@example.com`, "Ben Mate");
  ctxB = second.ctx; b = second.page;
  expect((await b.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: second.headers })).status()).toBe(200);
  const channels = (await (await a.request.get("/api/chat/channels")).json()).channels as { id: string; name: string }[];
  channelId = channels.find((c) => c.name === "general")!.id;
  await a.request.post(`/api/chat/channels/${channelId}/messages`, { data: { body: "Ship the pricing page today" }, headers: first.headers });
  for (let i = 0; i < 3; i++) await a.request.post(`/api/chat/channels/${channelId}/messages`, { data: { body: `Note ${i + 1}` }, headers: first.headers });
});
test.afterAll(async () => { await ctxA?.close(); await ctxB?.close(); });

const msgIn = (p: Page, text: string) => p.getByRole("region", { name: /^Messages in / }).getByTestId("chat-message").filter({ hasText: text });

test("a reaction in one browser shows in the other within a few seconds", async () => {
  await a.goto(`/app/chat/${channelId}`);
  await b.goto(`/app/chat/${channelId}`);
  const mine = msgIn(a, "Ship the pricing page");
  await expect(mine).toBeVisible();
  await mine.hover();
  await mine.getByTestId("reaction-add").first().click();
  await a.getByRole("button", { name: `React with ${THUMBS}` }).first().click();
  await expect(mine.getByTestId("reaction")).toHaveAttribute("aria-pressed", "true");
  await expect(mine.getByTestId("reaction")).toContainText("1");

  const theirs = msgIn(b, "Ship the pricing page").getByTestId("reaction");
  await expect(theirs).toBeVisible({ timeout: 8_000 });
  await expect(theirs).toHaveAttribute("title", "Ada Owner");
  await expect(theirs).toHaveAttribute("aria-pressed", "false");
  // Ben adds his: the count goes to 2 on both screens.
  await theirs.click();
  await expect(theirs).toContainText("2");
  await expect(mine.getByTestId("reaction")).toContainText("2", { timeout: 8_000 });
  await expect(mine.getByTestId("reaction")).toHaveAttribute("title", "You, Ben Mate");
});

test("search in the chat header jumps to a message", async () => {
  await a.getByTestId("chat-search-open").click();
  await a.getByTestId("chat-search").fill("pricing");
  const hit = a.getByTestId("chat-search-result").filter({ hasText: "Ship the pricing page" });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(msgIn(a, "Ship the pricing page")).toBeInViewport();
});

test("a call starts from the channel in one tap and the other person gets a join card", async () => {
  await b.getByTestId("chat-call").click();
  await expect(b).toHaveURL(/\/app\/meetings\/mtg_/);
  const card = a.getByTestId("call-card");
  await expect(card).toBeVisible({ timeout: 8_000 });
  await expect(card).toContainText("Call started");
  await expect(card).toContainText("Ben Mate");
  const shots = "/home/user/tab/files/multies-r20";
  mkdirSync(shots, { recursive: true });
  await a.screenshot({ path: `${shots}/chat-reactions.png` });
  await card.getByTestId("call-join").click();
  await expect(a).toHaveURL(/\/app\/meetings\/mtg_/);
});

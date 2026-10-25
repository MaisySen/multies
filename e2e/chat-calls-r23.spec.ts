import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Round 23 calls in chat end to end: in a DM between two people, Ada presses Call; Ben gets
 * "Ada Owner is calling you" and the call card with Join; then, with the video room faked through
 * the local test hook (CALLS_TEST_HOOK, refused in production), the card and header show who is in
 * the call, and the card turns into "Call ended" when the room empties.
 */
test.describe.configure({ mode: "serial" });
let visitor = 0;
const ip = () => `10.123.${test.info().workerIndex % 200}.${++visitor}`;
let a: Page, b: Page, ctxA: BrowserContext, ctxB: BrowserContext, dmId = "", headersA: Record<string, string> = {};

async function person(browser: Browser, email: string, name: string) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 800 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const r = await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers });
  expect(r.status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
}

test.beforeAll(async ({ browser }) => {
  test.skip(!!process.env.E2E_BASE_URL, "Uses the local test hook for video rooms.");
  const tag = Math.random().toString(36).slice(2, 8);
  const first = await person(browser, `ada-${tag}@example.com`, "Ada Owner");
  ctxA = first.ctx; a = first.page; headersA = first.headers;
  const invite = await (await a.request.post("/api/team/invites", { data: { email: `ben-${tag}@example.com`, role: "member" }, headers: first.headers })).json();
  const second = await person(browser, `ben-${tag}@example.com`, "Ben Mate");
  ctxB = second.ctx; b = second.page;
  expect((await b.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: second.headers })).status()).toBe(200);
  const benId = (await (await b.request.get("/api/account/me")).json()).user.id;
  dmId = (await (await a.request.post("/api/chat/dms", { data: { userIds: [benId] }, headers: first.headers })).json()).channel.id;
  const say = async (p: Page, h: Record<string, string>, body: string) => expect((await p.request.post(`/api/chat/channels/${dmId}/messages`, { data: { body }, headers: h })).status()).toBe(201);
  await say(a, first.headers, "Pricing page copy is in the doc, can you look before 3?");
  await say(b, second.headers, "On it. The hero line reads long on mobile.");
  await say(a, first.headers, "Quick call? Easier to show you on screen.");
});
test.afterAll(async () => { await ctxA?.close(); await ctxB?.close(); });

test("Ada calls Ben from a DM: Ben is rung and sees the card with Join", async () => {
  test.setTimeout(60_000);
  await a.goto(`/app/chat/${dmId}`);
  await b.goto("/app/notifications");
  await a.getByTestId("chat-call").click();
  // No video keys locally, so the caller lands on the meeting page (guest link, video off note).
  await expect(a).toHaveURL(/\/app\/meetings\/mtg_/);
  await b.reload();
  const ring = b.getByTestId("notifications-list").getByRole("button", { name: /Ada Owner is calling you/ });
  await expect(ring).toBeVisible({ timeout: 10_000 });
  await ring.click();
  await expect(b).toHaveURL(new RegExp(`/app/chat/${dmId}`));
  const card = b.getByTestId("call-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Call started");
  await expect(card.getByTestId("call-join")).toBeVisible();
});

test("the card and header show who is in the call, then Call ended", async () => {
  test.setTimeout(90_000);
  const meetingId = new URL(a.url()).pathname.split("/").pop()!;
  const set = async (names: string[]) => expect((await a.request.post(`/api/chat/calls/${meetingId}/test-room`, { data: { participants: names.map((name) => ({ name })) }, headers: headersA })).status()).toBe(200);
  await set(["Ada Owner", "Ben Mate"]);
  const card = b.getByTestId("call-card");
  await expect(card).toHaveAttribute("data-state", "live", { timeout: 25_000 });
  await expect(card).toContainText("In call");
  await expect(card.getByTestId("call-card-who")).toHaveText("Ada Owner, Ben Mate");
  const header = b.getByTestId("call-header");
  await expect(header).toContainText("In call: Ada Owner, Ben Mate");
  await expect(header.getByTestId("call-header-join")).toBeVisible();
  const shots = "/home/user/tab/files/multies-r23";
  mkdirSync(shots, { recursive: true });
  await b.mouse.move(900, 620);
  await b.screenshot({ path: `${shots}/calls.png` });

  await set([]);
  await expect(card).toHaveAttribute("data-state", "ended", { timeout: 25_000 });
  await expect(card).toContainText(/Call ended, \d+ min/);
  await expect(card.getByTestId("call-join")).toHaveCount(0);
  await expect(header).toHaveCount(0);
  // The meeting is marked ended on the server.
  expect((await (await a.request.get(`/api/meetings/${meetingId}`)).json()).meeting.status).toBe("ended");
});

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { confirmEmail } from "./support/confirm-email";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R31: notification triage and catch-up end to end. Ben assigns Ada a task; it shows in Ada's Inbox; E moves it to
 * Done; H then Tomorrow snoozes the next one into Later; the counts follow. Then Ada opens #general, Ben posts, and
 * on Ada's next visit the "Since your last visit" card says 1 new message.
 */
test.describe.configure({ mode: "serial" });
let visitor = 0;
const ip = () => `10.131.${test.info().workerIndex % 200}.${++visitor}`;
let a: Page, b: Page, ctxA: BrowserContext, ctxB: BrowserContext;
let headersA: Record<string, string>, headersB: Record<string, string>;
let adaId = "", channelId = "", projectId = "";
const shots = `${SHOTS_ROOT}/multies-r31`;

async function person(browser: Browser, email: string, name: string) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
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
  ctxA = first.ctx; a = first.page; headersA = first.headers;
  const invite = await (await a.request.post("/api/team/invites", { data: { email: `ben-${tag}@example.com`, role: "member" }, headers: headersA })).json();
  const second = await person(browser, `ben-${tag}@example.com`, "Ben Mate");
  ctxB = second.ctx; b = second.page; headersB = second.headers;
  await confirmEmail(b.request, `ben-${tag}@example.com`);
  expect((await b.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: headersB })).status()).toBe(200);
  adaId = (await (await a.request.get("/api/account/me")).json()).user.id;
  projectId = (await (await a.request.post("/api/projects", { data: { name: "Launch" }, headers: headersA })).json()).project.id;
  const channels = (await (await a.request.get("/api/chat/channels")).json()).channels as { id: string; name: string }[];
  channelId = channels.find((c) => c.name === "general")!.id;
});
test.afterAll(async () => { await ctxA?.close(); await ctxB?.close(); });

const rows = (p: Page) => p.getByTestId("notification-row");

test("an assignment lands in the Inbox; E marks it done, H snoozes to Later, counts follow", async () => {
  for (const title of ["Write the launch email", "Check the pricing page"]) {
    const r = await b.request.post("/api/tasks", { data: { title, projectId, assigneeId: `member:${adaId}` }, headers: headersB });
    expect(r.status()).toBe(201);
  }
  await a.goto("/app/notifications");
  await expect(rows(a)).toHaveCount(2);
  await expect(a.getByTestId("triage-count-inbox")).toHaveText("2");
  await expect(rows(a).first()).toContainText("Ben Mate");
  mkdirSync(shots, { recursive: true });
  await a.screenshot({ path: `${shots}/triage-inbox.png` });

  // E on the focused (first) row: done, with an undo toast.
  await a.locator("body").click({ position: { x: 5, y: 5 } });
  await a.keyboard.press("e");
  await expect(a.getByText("Marked done")).toBeVisible();
  await expect(rows(a)).toHaveCount(1);
  await expect(a.getByTestId("triage-count-inbox")).toHaveText("1");
  await expect(a.getByTestId("triage-count-done")).toHaveText("1");

  // H opens the snooze menu; Tomorrow moves it to Later.
  await a.keyboard.press("h");
  await expect(a.getByTestId("snooze-menu")).toBeVisible();
  await a.getByRole("menuitem", { name: "Tomorrow" }).click();
  await expect(a.getByText("You're all caught up")).toBeVisible();
  await expect(a.getByTestId("triage-count-later")).toHaveText("1");
  await expect(a.getByTestId("triage-count-inbox")).toHaveText("0");

  await a.getByTestId("triage-tab-later").click();
  await expect(rows(a)).toHaveCount(1);
  await expect(a.getByText(/Back tomorrow/i)).toBeVisible();
  await a.getByTestId("triage-tab-done").click();
  await expect(rows(a)).toHaveCount(1);

  // The API agrees.
  const api = await (await a.request.get("/api/notifications")).json();
  expect(api.viewCounts).toEqual({ inbox: 0, later: 1, done: 1 });
  expect(api.unread).toBe(0);
});

test("catch-up: after Ben posts, Ada's next visit to #general shows 1 new message", async () => {
  await a.goto(`/app/chat/${channelId}`);
  await expect(a.getByRole("region", { name: /^Messages in / })).toBeVisible();
  // The first open records the visit; let it land before Ben posts.
  await expect.poll(async () => (await (await a.request.get(`/api/catchup?type=channel&id=${channelId}`)).json()).catchup.since).not.toBeNull();
  expect((await b.request.post(`/api/chat/channels/${channelId}/messages`, { data: { body: "We agreed to launch on Friday" }, headers: headersB })).status()).toBe(201);
  await a.goto("/app/notifications");
  await a.goto(`/app/chat/${channelId}`);
  const card = a.getByTestId("catchup-card");
  await expect(card).toBeVisible();
  await expect(a.getByTestId("catchup-headline")).toHaveText("1 new message from Ben Mate");
  await expect(card).toContainText("Digest");
  await expect(card).toContainText("We agreed to launch on Friday");
  await card.screenshot({ path: `${shots}/catchup-card.png` });
  await card.getByRole("button", { name: "Mark as caught up" }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await (await a.request.get(`/api/catchup?type=channel&id=${channelId}`)).json()).catchup.hasNew).toBe(false);
});

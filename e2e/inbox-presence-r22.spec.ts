import { test, expect, type Browser } from "@playwright/test";
import { confirmEmail } from "./support/confirm-email";
import { mkdirSync } from "node:fs";

/**
 * Round 22 (R22.3 and R22.4) end to end: two people in one workspace open the same shared inbox
 * thread. The second sees the first viewing, then replying once the first opens a reply; a draft
 * the first saves shows in the thread for the second, who takes it over into their own Compose.
 */
let visitor = 0;
const ip = () => `10.124.${test.info().workerIndex % 200}.${++visitor}`;
const first = (s: string) => s.trim().split(/\s+/)[0];

async function browserFor(browser: Browser) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  return { ctx, page: await ctx.newPage(), headers: { origin: new URL(base).origin } };
}

test("a teammate sees viewing, then replying, then takes over the saved draft", async ({ browser }) => {
  test.setTimeout(150_000);
  const a = await browserFor(browser);
  await a.page.goto("/login");
  await a.page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(a.page).toHaveURL(/\/app/, { timeout: 20_000 });
  const adaName = (await (await a.page.request.get("/api/account/me")).json()).user.name as string;

  // Ben joins the demo workspace as an admin (every mailbox).
  const tag = Math.random().toString(36).slice(2, 8);
  const inv = await a.page.request.post("/api/team/invites", { data: { email: `ben-${tag}@example.com`, role: "admin" }, headers: a.headers });
  expect(inv.status()).toBe(201);
  const b = await browserFor(browser);
  expect((await b.page.request.post("/api/auth/sign-up/email", { data: { name: "Ben Mate", email: `ben-${tag}@example.com`, password: "a-strong-password" }, headers: b.headers })).status()).toBe(200);
  await confirmEmail(b.page.request, `ben-${tag}@example.com`);
  expect((await b.page.request.post(`/api/invites/${(await inv.json()).link.split("/invite/")[1]}/accept`, { headers: b.headers })).status()).toBe(200);

  const threads = (await (await a.page.request.get("/api/agents/threads")).json()).data as { id?: string; threadId?: string; subject: string }[];
  const row = threads.find((t) => /Password reset not arriving/.test(t.subject)) ?? threads[0];
  const threadId = (row.threadId ?? row.id)!;
  const thread = await (await a.page.request.get(`/api/agents/threads/${threadId}`)).json();
  const last = thread.messages[thread.messages.length - 1] as { id: string; mailboxId?: string };

  // Both open the thread in the shared inbox: Ben sees Ada viewing.
  await a.page.goto(`/app/inbox?thread=${threadId}`);
  await b.page.goto(`/app/inbox?thread=${threadId}`);
  const bar = b.page.getByTestId("thread-presence");
  await expect(bar).toContainText(`${first(adaName)} is viewing`, { timeout: 20_000 });
  await expect(a.page.getByTestId("thread-presence")).toContainText("Ben is viewing", { timeout: 20_000 });

  // Ada opens a reply in webmail: Ben sees "is replying".
  await a.page.goto(`/app/mail?mailbox=${thread.mailboxId ?? last.mailboxId}&m=${last.id}`);
  await a.page.getByRole("button", { name: "Reply", exact: true }).first().click();
  const compose = a.page.getByRole("dialog", { name: "New message" });
  await expect(compose).toBeVisible();
  await expect(bar).toContainText(`${first(adaName)} is replying`, { timeout: 25_000 });

  // Ben opens a reply too (from the same thread in webmail): both Compose windows warn, without blocking.
  // Ada writes a draft and closes it: it is saved in the thread with her as the author.
  await compose.getByLabel("Message").fill("Hi, I have reset the link on our side. Try again now and tell me if it still doesn't arrive.");
  await compose.getByRole("button", { name: "Close and save draft" }).click();
  await expect(compose).toHaveCount(0);
  // She opens the reply again, so Ben has a live view of both.
  await a.page.getByRole("button", { name: "Reply", exact: true }).first().click();
  await expect(compose).toBeVisible();

  await b.page.reload();
  const draft = b.page.getByTestId("thread-draft").first();
  await expect(draft).toContainText(`Draft by ${first(adaName)}`);
  await expect(draft).toContainText("I have reset the link");
  await expect(bar).toContainText(`${first(adaName)} is replying`, { timeout: 25_000 });
  await b.page.getByTestId("thread-presence").scrollIntoViewIfNeeded();
  mkdirSync("/home/user/tab/files/multies-r22", { recursive: true });
  await b.page.screenshot({ path: "/home/user/tab/files/multies-r22/presence.png" });

  // Ben takes over: the draft opens in his Compose, and it is his now.
  await draft.getByRole("button", { name: "Take over" }).click();
  const bCompose = b.page.getByRole("dialog", { name: "New message" });
  await expect(bCompose).toBeVisible();
  await expect(bCompose.getByLabel("Message")).toHaveValue(/I have reset the link/);
  // Ada is still replying in her window, so Ben's Compose warns him (never blocks).
  await expect(bCompose.getByTestId("also-replying")).toContainText(`${first(adaName)} is also replying`, { timeout: 25_000 });
  await bCompose.getByRole("button", { name: "Discard" }).click();
  const drafts = (await (await b.page.request.get(`/api/threads/${threadId}/drafts`)).json()).drafts as { mine: boolean; author: { name: string } }[];
  expect(drafts[0]).toMatchObject({ mine: true, author: { name: "Ben Mate" } });

  // Ada hears once: a note in her live view of the thread.
  await a.page.getByRole("dialog", { name: "New message" }).getByRole("button", { name: "Discard" }).click();
  await expect(a.page.getByTestId("presence-note")).toContainText("Ben took over your draft", { timeout: 25_000 });

  await a.ctx.close();
  await b.ctx.close();
});

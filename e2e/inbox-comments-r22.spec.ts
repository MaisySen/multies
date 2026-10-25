import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Round 22 (R22.2) end to end: on a demo workspace, open a shared inbox thread, post a team note that
 * mentions a second member with the @ picker, see it labelled as internal, then sign in as that member
 * and open the thread from the notification.
 */
let visitor = 0;
const ip = () => `10.122.${test.info().workerIndex % 200}.${++visitor}`;

test("a team note on a thread mentions a teammate, who gets a notification that opens the thread", async ({ page, browser, context }) => {
  test.setTimeout(60_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });

  const threads = (await (await page.request.get("/api/agents/threads")).json()).data as { id: string; subject: string; mailboxId: string }[];
  const thread = threads.find((t) => t.subject === "Password reset not arriving") ?? threads[0];
  expect(thread).toBeTruthy();

  // A second member who can open the thread's mailbox.
  await page.request.post("/api/org/plan", { data: { plan: "pro" }, headers });
  const tag = Math.random().toString(36).slice(2, 8);
  const email = `priya-${tag}@example.com`;
  const inv = await page.request.post("/api/team/invites", { data: { email, role: "member", mailboxIds: [thread.mailboxId] }, headers });
  expect(inv.status()).toBe(201);
  const token = ((await inv.json()).link as string).split("/invite/")[1];
  const priyaCtx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const priya = await priyaCtx.newPage();
  expect((await priya.request.post("/api/auth/sign-up/email", { data: { name: "Priya Shah", email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await priya.request.post(`/api/invites/${token}/accept`, { headers })).status()).toBe(200);
  // An earlier note from Priya, so the card reads like a real conversation.
  expect((await priya.request.post(`/api/threads/${thread.id}/comments`, { data: { body: "Kai is on the Pro plan. The reset mails bounced on Monday after their DNS change." }, headers })).status()).toBe(201);

  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(`/app/inbox?thread=${encodeURIComponent(thread.id)}`);
  const notes = page.getByRole("region", { name: "Team notes" }).or(page.getByLabel("Team notes"));
  await expect(notes.getByText("Only your team sees these")).toBeVisible();
  await expect(notes.getByText("The reset mails bounced on Monday")).toBeVisible();

  const box = notes.getByRole("combobox", { name: "Write a team note" });
  await box.click();
  await box.pressSequentially("@Pri");
  const picker = page.getByRole("listbox", { name: "People to mention" });
  await expect(picker.getByRole("option", { name: /Priya Shah/ })).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("@Priya Shah ");
  await box.pressSequentially("thanks. I resent the reset link from the agent. Can you check with Kai this afternoon?");
  await box.press("ControlOrMeta+Enter");
  const posted = notes.getByTestId("team-note").filter({ hasText: "I resent the reset link" });
  await expect(posted).toBeVisible();
  await expect(posted.getByText("@Priya Shah")).toBeVisible();
  await expect(box).toHaveValue("");
  await notes.scrollIntoViewIfNeeded();

  const shots = "/home/user/tab/files/multies-r22";
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/comments.png` });

  // The note is internal: the thread itself does not carry it.
  expect(JSON.stringify(await (await page.request.get(`/api/agents/threads/${thread.id}`)).json())).not.toContain("I resent the reset link");

  // Priya sees the mention in her notifications and it opens the thread.
  await priya.setViewportSize({ width: 1360, height: 900 });
  await priya.goto("/app/notifications");
  const item = priya.getByText(/mentioned you on: Password reset not arriving|mentioned you on:/).first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(priya).toHaveURL(new RegExp(`/app/inbox\\?thread=`));
  await expect(priya.getByText("I resent the reset link from the agent")).toBeVisible();
  await priyaCtx.close();
});

import { test, expect, type Browser, type Page } from "@playwright/test";
import { confirmEmail } from "./support/confirm-email";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R35 (Apple 1.2): report and block end to end. Olive reports a message from Sam (sheet, reason, send), then blocks
 * him from the thank you step; Sam's messages vanish from her channel and a quiet row says so; Sam's DM to her is
 * refused; the operator sees the report in the moderation queue and dismisses it.
 */
test.describe.configure({ mode: "serial" });
let visitor = 0;
const ip = () => `10.135.${test.info().workerIndex % 200}.${++visitor}`;
const SHOTS = "/home/user/tab/files/multies-r35";

const OUTBOX = ".data/e2e-outbox";
function lastEmailTo(address: string): { subject: string; text: string } | undefined {
  for (const f of readdirSync(OUTBOX).sort().reverse()) {
    const m = JSON.parse(readFileSync(join(OUTBOX, f), "utf8")) as { to: string[]; subject: string; text: string };
    if (m.to.includes(address)) return m;
  }
  return undefined;
}

async function person(browser: Browser, email: string, name: string) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const r = await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers });
  expect(r.status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return { ctx, page, headers };
}

test("report a message, block the person, DM refused, operator dismisses", async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const tag = Math.random().toString(36).slice(2, 8);
  const olive = await person(browser, `olive-${tag}@example.com`, "Olive Owner");
  const invite = await (await olive.page.request.post("/api/team/invites", { data: { email: `sam-${tag}@example.com`, role: "member" }, headers: olive.headers })).json();
  const sam = await person(browser, `sam-${tag}@example.com`, "Sam Lee");
  await confirmEmail(sam.page.request, `sam-${tag}@example.com`);
  expect((await sam.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: sam.headers })).status()).toBe(200);
  const channels = (await (await olive.page.request.get("/api/chat/channels")).json()).channels as { id: string; name: string }[];
  const general = channels.find((c) => c.name === "general")!.id;
  await sam.page.request.post(`/api/chat/channels/${general}/join`, { headers: sam.headers });
  await olive.page.request.post(`/api/chat/channels/${general}/messages`, { data: { body: "Morning all, standup at ten" }, headers: olive.headers });
  await sam.page.request.post(`/api/chat/channels/${general}/messages`, { data: { body: "You are all useless, quit now" }, headers: sam.headers });

  const a: Page = olive.page;
  await a.goto(`/app/chat/${general}`);
  const bad = a.getByTestId("chat-message").filter({ hasText: "You are all useless" });
  await expect(bad).toBeVisible();
  await bad.hover();
  await bad.getByRole("button", { name: "More message actions" }).click();
  await a.getByRole("menuitem", { name: "Report message" }).click();
  const sheet = a.getByTestId("report-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByText("Harassment or bullying").click();
  await sheet.getByLabel("Note").fill("Third time this week");
  await a.screenshot({ path: `${SHOTS}/chat-after-report-sheet.png` });
  await sheet.getByTestId("report-send").click();
  await expect(sheet).toContainText("Thanks. Our team reviews reports within 24 hours.");
  await sheet.getByTestId("report-block").click();
  const confirm = a.getByRole("dialog").filter({ hasText: "Block Sam Lee?" });
  await expect(confirm).toContainText("They won't be told.");
  await a.screenshot({ path: `${SHOTS}/chat-after-block-confirm.png` });
  await confirm.getByRole("button", { name: "Block", exact: true }).click();
  await expect(a.getByTestId("chat-message").filter({ hasText: "You are all useless" })).toHaveCount(0, { timeout: 10_000 });
  await expect(a.getByTestId("blocked-hidden-row")).toBeVisible();
  await expect(a.getByTestId("chat-message").filter({ hasText: "standup at ten" })).toBeVisible();
  await a.screenshot({ path: `${SHOTS}/chat-after-hidden.png` });

  // Sam can't start a DM with Olive, and isn't told more than this.
  const me = (await (await a.request.get("/api/account/me")).json()).user.id as string;
  const dm = await sam.page.request.post("/api/chat/dms", { data: { userIds: [me] }, headers: sam.headers });
  expect(dm.status()).toBe(403);
  expect((await dm.json()).error.message).toBe("You can't message this person.");

  // The operator (PLATFORM_ADMIN_EMAILS in playwright.config.ts) sees it in the queue and dismisses it.
  const ops = await person(browser, "ops-r35@example.com", "Odin Ops");
  // An operator email counts once it is verified: follow the link from the local outbox.
  await expect.poll(() => lastEmailTo("ops-r35@example.com")?.subject ?? "").toContain("Confirm your email");
  await ops.page.goto(lastEmailTo("ops-r35@example.com")!.text.match(/https?:\/\/\S+/)![0]);
  // The report mailed the operator inbox too (at most once per 15 minutes).
  await ops.page.goto("/app/admin/reports");
  const card = ops.page.getByTestId("moderation-report").filter({ hasText: "You are all useless" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Harassment or bullying");
  await expect(card).toContainText("Third time this week");
  await ops.page.screenshot({ path: `${SHOTS}/admin-after-moderation-queue.png` });
  await card.getByTestId("report-dismiss").click();
  await expect(ops.page.getByTestId("moderation-report").filter({ hasText: "You are all useless" })).toHaveCount(0);

  // Settings lists the block with Unblock.
  await a.goto("/app/settings/account");
  await expect(a.getByTestId("blocked-people")).toContainText("Sam Lee");
  await a.screenshot({ path: `${SHOTS}/settings-after-blocked-people.png`, fullPage: true });
  await olive.ctx.close(); await sam.ctx.close(); await ops.ctx.close();
});

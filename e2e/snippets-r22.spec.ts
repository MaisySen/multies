import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 22 (R22.4b) end to end: on a demo workspace, make a saved reply with {{first_name}} in
 * Settings > Mail (live preview), open Reply on a seeded webmail thread, insert it from the Saved
 * replies picker and see the recipient's first name filled in; then insert another with /shortcut + Tab.
 */
let visitor = 0;
const ip = () => `10.126.${test.info().workerIndex % 200}.${++visitor}`;

test("a saved reply made in settings goes into a webmail reply with the first name filled in", async ({ page, context }) => {
  test.setTimeout(90_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });

  // Two replies the team already has, so the picker reads like a real workspace.
  for (const s of [
    { name: "Password reset help", shortcut: "reset", body: "Hi {{first_name}},\n\nI've sent a fresh reset link to {{email}}. It can take a few minutes, and it sometimes lands in spam.\n\n{{my_first_name}}" },
    { name: "Refund approved", shortcut: "refund", body: "Hi {{first_name}},\n\nYour refund is on its way and should show in 3 to 5 business days.\n\n{{my_name}}, {{company}}" },
    { name: "My sign off", body: "Talk soon,\n{{my_first_name}}", shared: false },
  ]) expect((await page.request.post("/api/mail/snippets", { data: s, headers })).status()).toBe(201);

  // Settings > Mail > Saved replies: create one with a live preview.
  await page.goto("/app/settings/mail");
  const section = page.getByTestId("saved-replies-settings");
  await expect(section.getByTestId("saved-reply-row")).toHaveCount(3);
  await section.getByRole("button", { name: "New saved reply" }).click();
  const dialog = page.getByRole("dialog", { name: "New saved reply" });
  await dialog.getByLabel("Name").fill("Thanks for writing");
  await dialog.getByLabel("Shortcut").fill("thanks");
  await dialog.getByLabel("Reply").fill("Hi {{first_name}},\n\nThanks for writing to {{company}}. We're on it and will reply today.\n\n{{my_first_name}}");
  await expect(dialog.getByTestId("saved-reply-preview")).toContainText("Hi Grace,");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(section.getByTestId("saved-reply-row").filter({ hasText: "Thanks for writing" })).toBeVisible();
  await expect(section.getByText("/thanks")).toBeVisible();

  // Reply to Kai's thread in webmail and insert it from the picker.
  const threads = (await (await page.request.get("/api/agents/threads")).json()).data as { id: string; subject: string }[];
  const row = threads.find((t) => t.subject === "Password reset not arriving") ?? threads[0];
  const thread = await (await page.request.get(`/api/agents/threads/${row.id}`)).json();
  const last = thread.messages[thread.messages.length - 1] as { id: string; mailboxId?: string };
  await page.goto(`/app/mail?mailbox=${thread.mailboxId ?? last.mailboxId}&m=${last.id}`);
  await page.getByRole("button", { name: "Reply", exact: true }).first().click();
  const compose = page.getByRole("dialog", { name: "New message" });
  await expect(compose).toBeVisible();
  const body = compose.getByLabel("Message");
  await body.fill("");
  await compose.getByRole("button", { name: "Saved replies" }).click();
  const picker = page.getByTestId("saved-replies-picker");
  await expect(picker.getByRole("option")).toHaveCount(4);
  const search = picker.getByLabel("Search saved replies");
  await search.fill("than");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await search.fill("");
  await expect(picker.getByRole("option", { name: /Thanks for writing/ })).toBeVisible();

  mkdirSync(`${SHOTS_ROOT}/multies-r22`, { recursive: true });
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r22/snippets.png` });

  await search.fill("thanks");
  await search.press("Enter");
  await expect(picker).toBeHidden();
  await expect(body).toHaveValue(/^Hi Kai,\n\nThanks for writing to .+\. We're on it and will reply today\./);
  await expect(body).not.toHaveValue(/\{\{|undefined/);

  // /shortcut then Tab inserts another one in place of what was typed.
  await body.fill("/reset");
  await body.press("End");
  await body.press("Tab");
  await expect(body).toHaveValue(/^Hi Kai,\n\nI've sent a fresh reset link to kai@flatwhite\.example\./);
});

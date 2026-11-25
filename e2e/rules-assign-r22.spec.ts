import { test, expect } from "@playwright/test";
import { confirmEmail } from "./support/confirm-email";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";
import { receiveMail, teamInbox } from "./support/team-inbox";

/**
 * Round 22 (R22.5) end to end: in a team workspace (invites are off in the demo, MB-220, so the spec makes its own:
 * e2e/support/team-inbox.ts), an admin makes a mail rule in Automations that hands
 * new support threads out round robin between two people, two emails arrive at support, each lands with a
 * different person in the shared inbox, and one is set to Waiting and shows under the Waiting view.
 */
let visitor = 0;
const ip = () => `10.122.${test.info().workerIndex % 200}.${++visitor}`;

test("a round robin mail rule assigns new support threads to two people in turn; Waiting has its own view", async ({ page, browser, context }) => {
  test.setTimeout(90_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const base = test.info().project.use.baseURL!;
  const team = await teamInbox(page, { ownerName: "Alex Rivera", mailboxes: ["support"] });
  const headers = team.headers;
  const support = team.mailboxes.support;

  // A second person who can open support.
  const tag = Math.random().toString(36).slice(2, 8);
  const email = `priya-${tag}@example.com`;
  const inv = await page.request.post("/api/team/invites", { data: { email, role: "member", mailboxIds: [support.id] }, headers });
  expect(inv.status()).toBe(201);
  const priyaCtx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const priya = await priyaCtx.newPage();
  expect((await priya.request.post("/api/auth/sign-up/email", { data: { name: "Priya Shah", email, password: "a-strong-password" }, headers })).status()).toBe(200);
  await confirmEmail(priya.request, email);
  expect((await priya.request.post(`/api/invites/${((await inv.json()).link as string).split("/invite/")[1]}/accept`, { headers })).status()).toBe(200);
  await priyaCtx.close();

  // The rule, made in the Automations page.
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto("/app/automations?tab=rules"); // R90: rules are a tab of the Automations home
  await page.getByRole("button", { name: "New rule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Share out support mail");
  await dialog.getByLabel("To mailbox").selectOption(support.id);
  await dialog.getByLabel("Then").selectOption("assign_thread");
  await dialog.getByRole("radio", { name: "Round robin" }).click();
  await dialog.getByRole("checkbox", { name: "Alex Rivera" }).check();
  await dialog.getByRole("checkbox", { name: "Priya Shah" }).check();
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Share out support mail")).toBeVisible();
  await expect(page.getByText(/assign the thread in turn to Alex Rivera, Priya Shah/)).toBeVisible();

  // Two new emails arrive at support from customers.
  for (const subject of ["Order 1182 arrived damaged", "Can I move my billing date"]) {
    await receiveMail(page, team, support.address, { from: "maria@customer.example", fromName: "Maria Gonzalez", subject, text: "Hi team, can you help with this?" });
  }

  // The shared inbox: each one is with a different person.
  await page.goto("/app/inbox");
  await expect(page.getByRole("heading", { name: "Shared inbox" })).toBeVisible();
  const row = (subject: string) => page.getByRole("listitem").filter({ hasText: subject }).filter({ hasText: support.address });
  await expect(row("Order 1182 arrived damaged").getByTestId("thread-assignee")).toContainText("Assigned to Alex Rivera");
  await expect(row("Can I move my billing date").getByTestId("thread-assignee")).toContainText("Assigned to Priya Shah");
  // A thread nobody touched shows its age since the customer last wrote.
  await expect(page.getByTestId("thread-age").first()).toBeVisible();
  await row("Order 1182 arrived damaged").getByRole("button").click();
  await expect(page.getByTestId("thread-assign").getByRole("button", { name: "Waiting" })).toBeVisible();
  const dir = `${SHOTS_ROOT}/multies-r22`;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/rules.png` });

  // Set the billing one to Waiting: it leaves All and shows under Waiting.
  await row("Can I move my billing date").getByRole("button").click();
  await page.getByTestId("thread-assign").getByRole("button", { name: "Waiting" }).click();
  await expect(page.getByText("Waiting on the customer").first()).toBeVisible();
  await expect(page.getByTestId("thread-assign").getByRole("button", { name: "Reopen" })).toBeVisible();
  const views = page.getByTestId("inbox-views");
  await views.getByRole("button", { name: "Waiting" }).click();
  await expect(row("Can I move my billing date")).toBeVisible();
  await expect(row("Order 1182 arrived damaged")).toHaveCount(0);
  await views.getByRole("button", { name: "All" }).click();
  await expect(row("Order 1182 arrived damaged")).toBeVisible();
  await expect(row("Can I move my billing date")).toHaveCount(0);

  await page.goto("/app/automations?tab=rules"); // R90: rules are a tab of the Automations home
  await expect(page.getByText(/Ran 2 times/)).toBeVisible();
  await page.screenshot({ path: `${dir}/rules-automations.png` });
});

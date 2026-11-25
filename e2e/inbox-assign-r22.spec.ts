import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 22 (R22.1 and R22.5) end to end: in the demo workspace's shared inbox, assign a thread to me,
 * find it under Mine and in My Work, mark it done, and read the Reply times card.
 */
let visitor = 0;
const ip = () => `10.122.${test.info().workerIndex % 200}.${++visitor}`;

test("assign a shared inbox thread to me, see it in Mine and My Work, mark it done, read reply times", async ({ page, context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });

  await page.goto("/app/inbox");
  await expect(page.getByRole("heading", { name: "Shared inbox" })).toBeVisible();
  const views = page.getByTestId("inbox-views");
  await expect(views.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");

  // Assign the password reset thread to me from the thread header.
  await page.getByRole("button", { name: /Password reset not arriving/ }).click();
  const controls = page.getByTestId("thread-assign");
  await controls.getByRole("button", { name: "Assign", exact: true }).click();
  await page.getByRole("menuitem", { name: "Assign to me" }).click();
  await expect(controls.getByRole("button", { name: /^Assigned to / })).toBeVisible();
  await expect(controls.getByRole("button", { name: "Mark done" })).toBeVisible();
  // A second one, so Mine has a little list.
  await page.getByRole("button", { name: /Can we move our team over this week/ }).click();
  await page.getByTestId("thread-assign").getByRole("button", { name: "Assign", exact: true }).click();
  await page.getByRole("menuitem", { name: "Assign to me" }).click();
  await expect(page.getByTestId("thread-assign").getByRole("button", { name: /^Assigned to / })).toBeVisible();

  // Mine shows both, with my initials on the rows.
  await views.getByRole("button", { name: "Mine" }).click();
  const list = page.getByRole("list").filter({ has: page.getByRole("button", { name: /Password reset not arriving/ }) });
  await expect(list.getByRole("button", { name: /Password reset not arriving/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /Can we move our team over this week/ })).toBeVisible();
  await expect(list.getByTestId("thread-assignee")).toHaveCount(2);

  // My Work lists them under "Mail assigned to you" and links back to the thread.
  await page.goto("/app/my-work");
  const assigned = page.getByTestId("mywork-assigned-mail");
  await expect(assigned.getByRole("link", { name: /Password reset not arriving/ })).toBeVisible();
  await assigned.getByRole("link", { name: /Password reset not arriving/ }).click();
  await expect(page).toHaveURL(/\/app\/inbox\?thread=/);

  // Mark it done: it leaves Mine and shows under Done.
  await page.getByTestId("thread-assign").getByRole("button", { name: "Mark done" }).click();
  await expect(page.getByText("Marked done").first()).toBeVisible();
  await expect(page.getByTestId("thread-assign").getByRole("button", { name: "Reopen" })).toBeVisible();
  await views.getByRole("button", { name: "Mine" }).click();
  await expect(page.getByRole("button", { name: /Can we move our team over this week/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Password reset not arriving.*Kai|Kai Morgan/ })).toHaveCount(0);
  await views.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: /Kai Morgan/ })).toBeVisible();

  // Reply times: the support mailbox has an answered thread, so a median shows.
  await views.getByRole("button", { name: "All" }).click();
  await page.getByRole("button", { name: "Reply times" }).click();
  const card = page.getByTestId("reply-times");
  await expect(card.getByTestId("median-first").filter({ hasText: /^(Under 1m|\d+[mhd]( \d+[mh])?)$/ }).first()).toBeVisible();
  await card.getByRole("button", { name: "By person" }).click();
  // The approved agent reply counts for the person who approved and sent it (the demo's owner).
  await expect(card.getByRole("row", { name: /Alex Rivera 1 \d+[mhd]/ })).toBeVisible();
  await card.getByRole("button", { name: "By mailbox" }).click();

  await page.getByRole("button", { name: /Can we move our team over this week/ }).click();
  await expect(page.getByTestId("thread-assign").getByRole("button", { name: "Mark done" })).toBeVisible();
  await expect(page.getByText("Marked done")).toHaveCount(0, { timeout: 15_000 });
  mkdirSync(`${SHOTS_ROOT}/multies-r22`, { recursive: true });
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r22/assign.png` });
});

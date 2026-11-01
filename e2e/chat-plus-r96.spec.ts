import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R96 chat plus: topics (create, post into, filter, resolve), a poll, a decision with a block reason, live questions,
 * a word cloud and an announcement with seen by. With SHOTS_DIR set it saves the UX gate screenshots (1280 and 390,
 * light, dark, Forest) and checks each view with axe. Member, guest and other workspace rules are in the unit tests.
 */
const DIR = process.env.SHOTS_DIR;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
async function axe(page: Page, where: string) {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}
async function openGeneral(page: Page) {
  await page.goto("/app/chat");
  await expect(page.getByTestId("topic-bar")).toBeVisible({ timeout: 20_000 });
}
async function add(page: Page, item: "Poll" | "Decision" | "Questions" | "Word cloud" | "Announcement") {
  await page.getByTestId("chat-plus-add").click();
  await page.getByRole("menuitem", { name: new RegExp(`^${item}`) }).click();
}
async function say(page: Page, text: string) {
  await page.getByTestId("chat-composer").fill(text);
  await page.getByTestId("chat-composer").press("Enter");
}

test("R96 topics, polls, decisions, questions and word clouds", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await openGeneral(page);
  const problems: string[] = [];

  // A topic: create it, post into it, see only its messages.
  await page.getByTestId("topic-new").click();
  await page.getByTestId("topic-name").fill("Launch plan");
  await page.getByTestId("topic-save").click();
  await expect(page.getByTestId("posting-in")).toHaveText("Posting in Launch plan");
  await expect(page.getByText("No messages in this topic yet")).toBeVisible();
  await say(page, "Ship the beta on Friday");
  await expect(page.getByTestId("chat-message").filter({ hasText: "Ship the beta on Friday" })).toBeVisible();

  // Error path: a poll with one choice is refused with a plain message.
  await add(page, "Poll");
  await page.getByTestId("poll-question").fill("Lunch?");
  await page.getByTestId("poll-option").first().fill("Thai");
  await page.getByTestId("poll-create").click();
  await expect(page.getByText("Add at least two different choices.")).toBeVisible();
  await page.getByTestId("poll-option").nth(1).fill("Pizza");
  await page.getByTestId("poll-create").click();
  const poll = page.getByTestId("poll-card").filter({ hasText: "Lunch?" });
  await expect(poll).toBeVisible();
  await poll.getByTestId("poll-choice").filter({ hasText: "Pizza" }).click();
  await expect(poll.getByText(/^1 vote/)).toBeVisible();

  // A decision: Block needs a reason first.
  await add(page, "Decision");
  await page.getByTestId("poll-question").fill("Move standup to 10");
  await page.getByTestId("poll-create").click();
  const decision = page.getByTestId("poll-card").filter({ hasText: "Move standup to 10" });
  await decision.getByTestId("poll-choice").filter({ hasText: "Block" }).click();
  await expect(decision.getByTestId("decision-reason")).toHaveAttribute("placeholder", /Say why you block/);
  await decision.getByTestId("decision-reason").fill("Clashes with client calls");
  await decision.getByTestId("poll-choice").filter({ hasText: "Block" }).click();
  await expect(decision.getByTestId("decision-standing")).toContainText("Blocked");
  await expect(decision.getByText("Clashes with client calls")).toBeVisible();

  // Live questions and a word cloud.
  await add(page, "Questions");
  await page.getByTestId("poll-question").fill("Town hall");
  await page.getByTestId("poll-create").click();
  const qa = page.getByTestId("poll-card").filter({ hasText: "Town hall" });
  await qa.getByTestId("qa-input").fill("When is the offsite?");
  await qa.getByTestId("qa-ask").click();
  await expect(qa.getByTestId("qa-item")).toContainText("When is the offsite?");
  await qa.getByRole("button", { name: "Answered" }).click();
  await expect(qa.getByTestId("qa-item")).toContainText("answered");

  await add(page, "Word cloud");
  await page.getByTestId("poll-question").fill("One word for this week");
  await page.getByTestId("poll-create").click();
  const cloud = page.getByTestId("poll-card").filter({ hasText: "One word for this week" });
  await cloud.getByTestId("cloud-input").fill("Fast, calm");
  await cloud.getByTestId("cloud-send").click();
  await expect(cloud.getByTestId("word-cloud")).toContainText("fast");
  await shot(page, "r96-topic-1280-light");
  problems.push(...(await axe(page, "topic 1280 light")));

  // Close the poll: the result shows and the outcome is posted in the thread.
  await poll.getByTestId("poll-close").click();
  await expect(poll.getByTestId("poll-status")).toHaveText("Closed");
  await expect(poll.getByText("Result: Pizza")).toBeVisible();

  // Resolve the topic with a tick, then back to all messages.
  await page.getByTestId("topic-more").click();
  await page.getByRole("menuitem", { name: "Mark as resolved" }).click();
  await expect(page.getByTestId("topic-chip").filter({ hasText: "Launch plan" })).toContainText("✓");
  await page.getByRole("button", { name: "All messages" }).click();
  await expect(page.getByTestId("posting-in")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("R96 announcements, seen by, dark, Forest and phone", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await openGeneral(page);
  const problems: string[] = [];
  await add(page, "Announcement");
  await page.getByTestId("announce-body").fill("Office closed on Friday for the move.");
  await page.getByTestId("announce-post").click();
  await expect(page.getByTestId("announcement-label").first()).toBeVisible();
  await add(page, "Poll");
  await page.getByTestId("poll-question").fill("Which day for the offsite?");
  await page.getByTestId("poll-option").first().fill("Thursday");
  await page.getByTestId("poll-option").nth(1).fill("Friday");
  await page.getByTestId("poll-create").click();
  await expect(page.getByTestId("poll-card").filter({ hasText: "offsite" })).toBeVisible();
  await page.getByTestId("announcements-nav").click();
  await expect(page).toHaveURL(/view=announcements/);
  const item = page.getByTestId("announcement").filter({ hasText: "Office closed on Friday" });
  await expect(item).toBeVisible();
  await expect(item.getByTestId("announcement-seen")).toContainText(/Seen by 1 of \d+/);
  await item.getByTestId("announcement-seen").click();
  await expect(page.getByRole("dialog", { name: "Seen by" })).toBeVisible();
  await page.keyboard.press("Escape");

  const views = async (tag: string) => {
    await page.goto("/app/chat?view=announcements");
    await expect(page.getByTestId("announcements-feed")).toBeVisible();
    await shot(page, `r96-announcements-${tag}`);
    problems.push(...(await axe(page, `announcements ${tag}`)));
    await openGeneral(page);
    await expect(page.getByTestId("poll-card").first()).toBeVisible();
    await shot(page, `r96-chat-${tag}`);
    problems.push(...(await axe(page, `chat ${tag}`)));
  };
  await views("1280-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await views("1280-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await views("390-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await views("390-light");
  // On a phone the topic bar scrolls sideways and nothing overflows the page.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await views("1280-forest");
  await page.setViewportSize({ width: 390, height: 844 });
  await views("390-forest");
  expect(problems).toEqual([]);
});

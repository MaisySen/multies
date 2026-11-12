import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 23 (R23.1): schedule a meeting, open its Notes, type an agenda and two action items with an
 * @mention and a due date, and turn them into tasks in one click. Video is off locally, which the notes
 * do not need.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.79.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
}

test("meeting notes: agenda, action items with @mention and due date, tasks made once", async ({ page }) => {
  test.setTimeout(90_000);
  await demo(page);
  const me = (await (await page.request.get("/api/account/me")).json()).user as { id: string; name: string };

  await page.goto("/app/meetings");
  await page.getByRole("button", { name: "Schedule" }).click();
  await page.getByLabel("Title").fill("Launch planning");
  await page.getByRole("button", { name: "Save without inviting" }).click();
  await expect(page).toHaveURL(/\/app\/meetings\/mtg_/);
  const meetingId = new URL(page.url()).pathname.split("/").pop()!;

  await page.getByTestId("open-notes").click();
  const editor = page.getByRole("textbox", { name: "Meeting notes" });
  await expect(editor).toBeVisible();
  // Agenda: the empty line under the first heading.
  await editor.locator("p").first().click();
  await page.keyboard.type("Launch date and budget");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Press and partner outreach");
  await editor.locator("p").nth(2).click();
  await page.keyboard.type("Venue shortlist is down to two. Budget holds if we keep the guest list under 80.");
  // Action items: the empty checklist item under "Action items".
  await editor.locator('ul[data-type="taskList"] li p').first().click();
  await page.keyboard.type(`Book the venue @${me.name} due Friday`);
  await page.keyboard.press("Enter");
  await page.keyboard.type(`Send the press kit to partners @${me.name} due today`);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Check catering quotes");
  await expect(page.getByTestId("notes-state")).toHaveText("Saved", { timeout: 10_000 });

  const items = page.getByTestId("action-item");
  await expect(items).toHaveCount(3, { timeout: 10_000 });
  await expect(items.nth(0)).toContainText("Book the venue");
  await expect(page.getByLabel("Assignee for Book the venue")).toHaveValue(`member:${me.id}`);
  // R67 (MB-250): date fields show the workspace's order (dd/mm/yyyy here); the value sent stays ISO (checked on the tasks below).
  await expect(page.getByLabel("Due date for Book the venue")).toHaveValue(/^\d{2}\/\d{2}\/\d{4}$/);
  await expect(page.getByLabel("Due date for Send the press kit to partners")).toHaveValue(/^\d{2}\/\d{2}\/\d{4}$/);
  await expect(page.getByLabel("Assignee for Check catering quotes")).toHaveValue("");
  // The third one stays for later: take it off by checking it in the notes (done in the meeting).
  await editor.locator('ul[data-type="taskList"] li').nth(2).locator("input[type=checkbox]").check();
  await expect(page.getByTestId("notes-state")).toHaveText("Saved", { timeout: 10_000 });
  await expect(items).toHaveCount(2, { timeout: 10_000 });

  const mkdir = `${SHOTS_ROOT}/multies-r23`;
  mkdirSync(mkdir, { recursive: true });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByTestId("meeting-notes").scrollIntoViewIfNeeded();
  await page.mouse.click(5, 5);
  await page.screenshot({ path: `${mkdir}/notes.png`, fullPage: true });
  await page.getByRole("button", { name: "Create 2 tasks" }).click();
  await expect(page.getByTestId("action-item-task")).toHaveCount(2);
  await expect(page.getByTestId("action-item")).toHaveCount(0);
  await expect(page.getByTestId("action-items")).toContainText("2 of 2 are tasks");
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r23/notes-created.png` });


  // The tasks are real, assigned and dated, and show in My Work.
  const tasks = (await (await page.request.get("/api/tasks?q=Book the venue")).json()).tasks as { title: string; assignee: { id: string } | null; due: string | null }[];
  expect(tasks).toHaveLength(1);
  expect(tasks[0].assignee?.id).toBe(me.id);
  expect(tasks[0].due).toBeTruthy();
  expect(String(tasks[0].due)).toMatch(/^\d{4}-\d{2}-\d{2}/); // stored ISO, whatever the field shows
  await page.goto("/app/my-work");
  await expect(page.getByTestId("mywork-due")).toContainText("Send the press kit to partners", { timeout: 10_000 });

  // Pressing again makes nothing new.
  const again = await page.request.post(`/api/meeting-notes/${meetingId}/action-items`, { data: {}, headers: { origin: new URL(page.url()).origin } });
  expect(again.status()).toBe(200);
  expect((await again.json()).created).toHaveLength(0);
  expect(((await (await page.request.get("/api/tasks?q=Book the venue")).json()).tasks as unknown[]).length).toBe(1);

  // The doc says whose notes it is, with a link back.
  const docId = (await (await page.request.get(`/api/meeting-notes/${meetingId}`)).json()).doc.id as string;
  await page.goto(`/app/docs/${docId}`);
  await expect(page.getByTestId("doc-meeting-link")).toContainText("Notes for Launch planning");
  await page.getByTestId("doc-meeting-link").click();
  await expect(page).toHaveURL(new RegExp(`/app/meetings/${meetingId}`));
});

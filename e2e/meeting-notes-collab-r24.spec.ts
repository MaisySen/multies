import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Round 24: meeting notes are live. Two windows on one meeting's notes see each other's typing,
 * carets and presence without a reload; the doc page edits the same room; the @ picker still
 * works on the shared editor; one window saves the row and the action items card follows in both.
 * When the collab socket cannot open, the notes fall back to the single editor with REST saves.
 */
let visitor = 0;
const ip = () => `10.81.${test.info().workerIndex % 200}.${++visitor}`;
const headers = (): Record<string, string> => (process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() });

async function twoWindows(browser: Browser) {
  const first = await browser.newContext({ extraHTTPHeaders: headers(), viewport: { width: 1360, height: 900 } });
  const a = await first.newPage();
  await a.goto("/login");
  await a.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(a).toHaveURL(/\/app/, { timeout: 20_000 });
  const second = await browser.newContext({ storageState: await first.storageState(), extraHTTPHeaders: headers(), viewport: { width: 1360, height: 900 } });
  const b = await second.newPage();
  return { a, b, close: async () => { await first.close(); await second.close(); } };
}

async function newMeeting(page: Page, title: string) {
  await page.goto("/app/meetings");
  await page.getByRole("button", { name: "Schedule" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save without inviting" }).click();
  await expect(page).toHaveURL(/\/app\/meetings\/mtg_/);
  return new URL(page.url()).pathname.split("/").pop()!;
}

const notes = (p: Page) => p.getByRole("textbox", { name: "Meeting notes" });
/** The notes text without other people's caret labels, which sit inside the editor. */
const plain = (p: Page) => notes(p).evaluate((el) => {
  const c = el.cloneNode(true) as HTMLElement;
  c.querySelectorAll(".collaboration-carets__caret").forEach((n) => n.remove());
  return c.textContent ?? "";
});
const sees = (p: Page, text: string) => expect.poll(() => plain(p), { timeout: 10_000 }).toContain(text);

test("two windows co-edit one meeting's notes live, with the doc page in the same room", async ({ browser }) => {
  test.setTimeout(120_000);
  const { a, b, close } = await twoWindows(browser);
  const me = (await (await a.request.get("/api/account/me")).json()).user as { id: string; name: string };
  const meetingId = await newMeeting(a, "Quarterly planning");
  await a.getByTestId("open-notes").click();
  await expect(notes(a)).toBeVisible();
  await expect(a.getByTestId("notes-live")).toBeVisible();

  await b.goto(`/app/meetings/${meetingId}`);
  await expect(notes(b)).toBeVisible();
  await expect(b.getByTestId("notes-live")).toBeVisible();
  // The seeded template appears once in each window, not once per window.
  await expect(notes(a).locator("h2, h3")).toHaveCount(await notes(b).locator("h2, h3").count());
  await expect(a.getByTestId("notes-peer")).toHaveCount(1);
  await expect(b.getByTestId("notes-peer")).toHaveCount(1);
  await expect(b.getByTestId("notes-presence")).toContainText("is editing");

  // A types the agenda: B sees it without a reload.
  await notes(a).locator("p").first().click();
  await a.keyboard.type("Hiring plan for Q1");
  await sees(b, "Hiring plan for Q1");

  // B adds an action item with the @ picker on the shared editor: A sees it.
  await notes(b).locator('ul[data-type="taskList"] li p').first().click();
  await b.keyboard.type("Draft the budget @" + me.name.slice(0, 3));
  await expect(b.getByTestId("mention-picker")).toBeVisible();
  await b.keyboard.press("Enter");
  await b.keyboard.type("due Friday");
  await sees(b, `Draft the budget @${me.name} due Friday`);
  await sees(a, `Draft the budget @${me.name} due Friday`);

  // One window saves the merged text to the row; the action items card follows in both windows.
  const docId = (await (await a.request.get(`/api/meeting-notes/${meetingId}`)).json()).doc.id as string;
  await expect.poll(async () => (await (await a.request.get(`/api/docs/${docId}`)).json()).doc.text as string, { timeout: 15_000 })
    .toContain(`Draft the budget @${me.name} due Friday`);
  await expect(a.getByTestId("action-item")).toHaveCount(1, { timeout: 15_000 });
  await expect(b.getByTestId("action-item")).toHaveCount(1, { timeout: 15_000 });
  await expect(a.getByLabel("Assignee for Draft the budget")).toHaveValue(`member:${me.id}`);

  // The full doc page edits the same room: its typing reaches the meeting page live.
  await b.goto(`/app/docs/${docId}`);
  const body = b.getByRole("textbox", { name: "Doc body" });
  await expect(body).toContainText("Hiring plan for Q1");
  await body.getByText("Hiring plan for Q1").click();
  await b.keyboard.press("End");
  await b.keyboard.type(" and onboarding");
  await sees(a, "Hiring plan for Q1 and onboarding");
  await expect.poll(async () => (await (await a.request.get(`/api/docs/${docId}`)).json()).doc.text as string, { timeout: 15_000 })
    .toContain("Hiring plan for Q1 and onboarding");

  // Back on the meeting page in both windows, with a few more lines, for the picture.
  await b.goto(`/app/meetings/${meetingId}`);
  await sees(b, "Hiring plan for Q1 and onboarding");
  await notes(a).locator('ul[data-type="taskList"] li p').last().click();
  await a.keyboard.press("End");
  await a.keyboard.press("Enter");
  await a.keyboard.type("Book the offsite venue due next Wednesday");
  await sees(b, "Book the offsite venue");
  await expect(a.getByTestId("action-item")).toHaveCount(2, { timeout: 15_000 });
  await expect(b.getByTestId("action-item")).toHaveCount(2, { timeout: 15_000 });
  await notes(b).locator('ul[data-type="taskList"] li p').first().click();
  await expect(a.getByTestId("notes-peer")).toHaveCount(1);
  mkdirSync("/home/user/tab/files/multies-r24", { recursive: true });
  await a.getByTestId("meeting-notes").scrollIntoViewIfNeeded();
  await a.screenshot({ path: "/home/user/tab/files/multies-r24/collab.png", fullPage: true });
  await close();
});

test("meeting notes fall back to the single editor when the collab socket is unavailable", async ({ page }) => {
  test.setTimeout(90_000);
  if (!process.env.E2E_BASE_URL) await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  // Refuse the room: the socket closes at once, as when the Durable Object is not there.
  await page.routeWebSocket(/\/collab/, (ws) => { void ws.close(); });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  const meetingId = await newMeeting(page, "Solo notes");
  await page.getByTestId("open-notes").click();
  await expect(notes(page)).toBeVisible();
  await expect(page.getByTestId("notes-live")).toHaveCount(0);
  await notes(page).locator("p").first().click();
  await page.keyboard.type("Typed without the room");
  await expect(page.getByTestId("notes-state")).toHaveText("Saved", { timeout: 10_000 });
  const docId = (await (await page.request.get(`/api/meeting-notes/${meetingId}`)).json()).doc.id as string;
  const row = (await (await page.request.get(`/api/docs/${docId}`)).json()).doc as { text: string; version: number };
  expect(row.text).toContain("Typed without the room");
  // Nothing is lost on reload.
  await page.reload();
  await expect(notes(page)).toContainText("Typed without the room");
});

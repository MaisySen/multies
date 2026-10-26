import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Round 31 meetings end to end, with the browser's fake camera and microphone: the pre-join screen
 * shows the live preview and the device pickers, Enter joins, the call's notes doc is made once
 * (two joins, one doc), and the So far panel lists who is in the call (the video room is faked
 * through the local test hook, CALLS_TEST_HOOK, refused in production). Video keys are not set
 * locally, so the meeting reads as video on and the room token is stubbed in the browser only.
 */
test.use({
  permissions: ["camera", "microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  viewport: { width: 1440, height: 900 },
});
test.describe.configure({ mode: "serial" });

const SHOTS = "/home/user/tab/files/multies-r31";
let visitor = 0;
const ip = () => `10.131.${test.info().workerIndex % 200}.${++visitor}`;

async function signIn(page: Page) {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return headers;
}

/** The local server has no video keys: show the meeting as video on and hand the room a stub token (browser side only). */
async function fakeVideo(page: Page, meetingId: string) {
  await page.route(new RegExp(`/api/meetings/${meetingId}$`), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.meeting.videoEnabled = true;
    await route.fulfill({ response: res, json: body });
  });
  await page.route(new RegExp(`/api/meetings/${meetingId}/join$`), (route) => route.fulfill({ json: { url: "wss://127.0.0.1:9", token: "stub", room: "stub", meeting: { id: meetingId } } }));
}

test("pre-join, Enter joins, one notes doc for two joins, and So far lists who is in", async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, "Uses the local test hook for video rooms.");
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  const headers = await signIn(page);
  const m = (await (await page.request.post("/api/meetings", { data: { title: "Design review" }, headers })).json()).meeting;
  expect((await page.request.post(`/api/chat/calls/${m.id}/test-room`, { data: { participants: [{ name: "Sam Mate" }, { name: "Gail Guest" }] }, headers })).status()).toBe(200);
  await fakeVideo(page, m.id);

  await page.goto(`/app/meetings/${m.id}`);
  await page.getByTestId("join-meeting").click();
  const pre = page.getByTestId("prejoin");
  await expect(pre).toBeVisible();
  await expect(pre.getByRole("heading", { name: "Ready to join?" })).toBeVisible();
  await expect(page.getByTestId("prejoin-joining-as")).toContainText("Ada Owner");
  await expect(page.getByTestId("prejoin-join")).toBeFocused();
  await expect(page.getByTestId("prejoin-in-call")).toContainText("Sam Mate, Gail Guest");
  // The fake camera plays in the preview, and the pickers list the fake devices.
  await expect.poll(() => page.getByTestId("prejoin-preview").evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.getByTestId("prejoin-camera-select").locator("option").count()).toBeGreaterThan(0);
  await expect(page.getByTestId("prejoin-camera-select")).toBeEnabled();
  await expect(page.getByTestId("prejoin-mic-select")).toBeEnabled();
  await expect(page.getByTestId("prejoin-meter")).toBeVisible();
  // The camera toggle carries a pressed state, and turning it back on restores the preview.
  await page.getByTestId("prejoin-cam").click();
  await expect(page.getByTestId("prejoin-cam")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("prejoin-cam").click();
  await expect(page.getByTestId("prejoin-cam")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.getByTestId("prejoin-preview").evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/meet-prejoin.png` });

  // Enter joins from the screen itself, not only from the Join button.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("meeting-room")).toBeVisible();
  // The notes doc is made as the call starts.
  await expect.poll(async () => (await (await page.request.get(`/api/meetings/${m.id}`)).json()).meeting.docId, { timeout: 15_000 }).toBeTruthy();
  const firstDoc = (await (await page.request.get(`/api/meetings/${m.id}`)).json()).meeting.docId as string;

  // So far lists who is in the call.
  await page.getByTestId("call-tab-so-far").click();
  const so = page.getByTestId("so-far");
  await expect(so).toBeVisible();
  await expect(page.getByTestId("so-far-people")).toContainText("Sam Mate");
  await expect(page.getByTestId("so-far-people")).toContainText("Gail Guest");
  await expect(so).toContainText("Digest");
  await expect(so).toContainText("Agenda");
  await page.waitForTimeout(400); // let the panel's fade finish
  await page.screenshot({ path: `${SHOTS}/meet-summary-so-far.png` });

  // Notes opens the call's doc in the panel.
  await page.getByTestId("call-tab-notes").click();
  await expect(page.getByTestId("call-panel")).toBeVisible();

  // Leave and join again: still the same single notes doc.
  await page.getByRole("button", { name: "Leave" }).first().click();
  await page.getByTestId("join-meeting").click();
  await page.getByTestId("prejoin-join").click();
  await expect(page.getByTestId("meeting-room")).toBeVisible();
  const again = await (await page.request.post(`/api/meeting-live/${m.id}/call-notes`, { headers })).json();
  expect(again).toMatchObject({ docId: firstDoc, created: false });
  expect((await (await page.request.get(`/api/meetings/${m.id}`)).json()).meeting.docId).toBe(firstDoc);
});

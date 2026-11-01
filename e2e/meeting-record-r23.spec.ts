import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Round 23 (R23.2) end to end: recording a call and its transcript on the workspace's own AI key.
 * Headless Chromium has no LiveKit room here (no keys locally), so this drives the parts that need no
 * media: the setup prompt without a key (it links to Settings > AI), then, with a key, chunks uploaded
 * through the same route the room's recorder uses, the transcript and summary on the meeting page,
 * and the summary posted once in the call's channel. The AI providers are answered by the local
 * stand in (AI_FAKE=1 on the localhost E2E server only).
 */
test.describe.configure({ mode: "serial" });
let visitor = 0;
const ip = () => `10.123.${test.info().workerIndex % 200}.${++visitor}`;
let page: Page;
let headers: Record<string, string>;
let channelId = "";
let meetingId = "";

test.beforeAll(async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  page = await ctx.newPage();
  headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Olive Owner", email: `olive-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  const channels = (await (await page.request.get("/api/chat/channels")).json()).channels as { id: string; name: string }[];
  channelId = channels.find((c) => c.name === "general")!.id;
  const call = await page.request.post(`/api/chat/channels/${channelId}/call`, { data: {}, headers });
  expect(call.status()).toBe(201);
  meetingId = (await call.json()).meeting.id;
});
test.afterAll(async () => { await page?.context().close(); });

const audio = Buffer.from(Array.from({ length: 256 }, (_, i) => i % 251)).toString("base64");

async function record(chunks: number, durationSec: number) {
  const start = await page.request.post(`/api/meetings/${meetingId}/recordings`, { data: {}, headers });
  expect(start.status()).toBe(201);
  const rid = (await start.json()).recording.id as string;
  for (let seq = 0; seq < chunks; seq++) {
    const r = await page.request.put(`/api/meetings/${meetingId}/recordings/${rid}/chunks/${seq}`, { data: { audioBase64: audio, mime: "audio/webm;codecs=opus", offsetSec: seq * 300, durationSec: Math.min((seq + 1) * 300, durationSec) }, headers });
    expect(r.status()).toBe(200);
  }
  const stop = await page.request.post(`/api/meetings/${meetingId}/recordings/${rid}/stop`, { data: { durationSec }, headers });
  expect(stop.status()).toBe(200);
  return (await stop.json()) as { recording: { status: string; summary: string }; posted: { type: string } | null };
}

test("without a key, the meeting page shows the setup prompt and it opens Settings > AI", async () => {
  await page.goto(`/app/meetings/${meetingId}`);
  const section = page.getByTestId("recording-section");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("record-setup")).toContainText("Add your OpenAI or Groq key in Settings > AI to record and transcribe. Multies doesn't charge for this; your provider bills your key.");
  const link = section.getByTestId("record-setup-link");
  await expect(link).toHaveAttribute("href", "/app/settings#ai");
  // Starting without a key is refused with the code the room's Record button opens the prompt on.
  const refused = await page.request.post(`/api/meetings/${meetingId}/recordings`, { data: {}, headers });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("recording_needs_ai_key");
  await link.click();
  await expect(page).toHaveURL(/\/app\/settings#ai$/);
  await expect(page.locator("#ai")).toBeVisible();
});

test("with a key, chunks become a transcript, the summary shows on the meeting page and posts once to the channel", async () => {
  expect((await page.request.put("/api/ai/key", { data: { provider: "openai", apiKey: "sk-e2e-0123456789abcdefWXYZ" }, headers })).status()).toBe(200);
  const first = await record(2, 412);
  expect(first.recording.status).toBe("done");
  expect(first.posted?.type).toBe("chat");
  const second = await record(3, 754);
  expect(second.posted?.type).toBe("chat");

  await page.goto(`/app/meetings/${meetingId}`);
  const items = page.getByTestId("recording-item");
  await expect(items).toHaveCount(2);
  const newest = items.first();
  await expect(newest).toContainText("Done");
  await expect(newest).toContainText("12 min");
  await expect(newest).toContainText("recorded by Olive Owner");
  await expect(newest.getByTestId("recording-summary")).toContainText("The team agreed to ship the new pricing page this week.");
  await expect(newest.getByTestId("recording-summary")).toContainText("Ship the pricing page on Friday");
  await expect(newest).toContainText("Write the launch email");
  await expect(newest).toContainText("Sam, due Thursday");
  await newest.getByTestId("recording-transcript").locator("summary").click();
  await expect(newest.getByTestId("recording-transcript")).toContainText("[10:00] Maria: Let's ship the pricing page on Friday.");
  mkdirSync("/home/user/tab/files/multies-r23", { recursive: true });
  await page.getByTestId("recording-section").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/home/user/tab/files/multies-r23/record.png", fullPage: true });

  // The channel the call started from has one summary per recording, from the person who recorded.
  await page.goto(`/app/chat/${channelId}`);
  const cards = page.getByRole("region", { name: /^Messages in / }).getByTestId("chat-message").filter({ hasText: "Call summary: #general call" });
  await expect(cards).toHaveCount(2);
  await expect(cards.last()).toContainText("Write the launch email (Sam, due Thursday)");
  await expect(cards.last()).toContainText(`/app/meetings/${meetingId}`);

  // Delete takes a recording and its transcript away.
  await page.goto(`/app/meetings/${meetingId}`);
  // Delete asks in the app's own dialog (it replaced the browser's confirm box).
  await page.getByTestId("recording-item").last().getByTestId("recording-delete").click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete recording" }).click();
  await expect(page.getByTestId("recording-item")).toHaveCount(1);
});

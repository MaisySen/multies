import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

/**
 * PAR1: the VID2 transcript side file, end to end on a local LiveKit dev server with the AI stand in (AI_FAKE=1, no real
 * provider). With a key: record a call video, Stop, and "<video name> transcript.txt" is saved next to the video with
 * the call's words; the video carries its length (MB-352). With the workspace AI switch off (ASK_TD1 on): the dialog
 * says so plainly, the video still records, and no recording or audio chunk reaches the server (so no AI provider).
 */
const LIVE = /^ws:\/\/(localhost|127\.0\.0\.1)/.test(process.env.LIVEKIT_URL ?? "");
const TMP = process.env.PAR1_TMP ?? "/tmp/par1-transcript-e2e";
test.skip(!LIVE, "needs the local LiveKit dev server");
test.describe.configure({ mode: "serial" });
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] } });
test.setTimeout(540_000);

let visitor = 0;
const ip = () => `10.197.${test.info().workerIndex % 200}.${++visitor}`;
let ctx: BrowserContext, owner: Page, meetingId = "", origin = "";
const tag = Math.random().toString(36).slice(2, 8);
const headers = () => ({ origin });
const probe = (path: string) => execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8", timeout: 60_000 }).trim();

async function joinCall(page: Page) {
  await page.goto(`/app/meetings/${meetingId}?join=1`);
  await expect(page.getByTestId("prejoin-join").or(page.getByTestId("call-screen"))).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId("prejoin-join").isVisible()) await page.getByTestId("prejoin-join").click({ timeout: 5_000 }).catch(() => undefined);
  await expect(page.getByTestId("call-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("record-start").or(page.getByTestId("recording-banner"))).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(TMP, { recursive: true });
  const base = test.info().project.use.baseURL!;
  origin = new URL(base).origin;
  ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 860 }, permissions: ["camera", "microphone"], acceptDownloads: true, reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  owner = await ctx.newPage();
  owner.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
  owner.on("console", (m) => { if (m.type() === "error" || m.text().startsWith("REC ")) console.log("CONSOLE", m.text().slice(0, 300)); });
  if (process.env.PAR1_DEBUG) await owner.addInitScript(() => {
    const s = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function (this: MediaRecorder, ms?: number) {
      const tracks = this.stream.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted ? "muted" : "live"}`).join(",");
      console.log(`REC start ${this.mimeType} ${ms} ${tracks}`);
      let n = 0, bytes = 0;
      this.addEventListener("dataavailable", (e) => { n++; bytes += e.data.size; if (n <= 2 || n % 10 === 0) console.log(`REC data ${this.mimeType} #${n} ${e.data.size} total ${bytes}`); });
      this.addEventListener("error", (e) => console.log(`REC error ${String((e as unknown as { error?: Error }).error)}`));
      this.addEventListener("stop", () => console.log(`REC stop ${this.mimeType} chunks ${n} bytes ${bytes}`));
      return s.call(this, ms);
    };
  });
  // Save in the browser (a download), so the files land where the test can read them.
  await owner.addInitScript(() => { delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  expect((await owner.request.post("/api/auth/sign-up/email", { data: { name: "Olive Owner", email: `olive-par1-${tag}@example.com`, password: "a-strong-password" }, headers: headers() })).status()).toBe(200);
  await owner.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers: headers() });
  const made = await owner.request.post("/api/meetings", { data: { title: "Weekly sync", startsAt: new Date().toISOString(), durationMin: 30 }, headers: headers() });
  expect(made.status()).toBe(201);
  meetingId = (await made.json()).meeting.id;
  const key = ["sk", "e2e", "0123456789abcdefWXYZ"].join("-");
  expect((await owner.request.put("/api/ai/key", { data: { provider: "openai", apiKey: key }, headers: headers() })).status()).toBe(200);
});
test.afterAll(async () => { await ctx?.close(); rmSync(TMP, { recursive: true, force: true }); });

async function recordAndStop(seconds: number) {
  const files: Record<string, string> = {};
  const onDl = async (d: import("@playwright/test").Download) => { const p = `${TMP}/${d.suggestedFilename()}`; await d.saveAs(p); files[d.suggestedFilename()] = p; };
  owner.on("download", onDl);
  await owner.getByTestId("video-rec-memory").click();
  await expect(owner.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 20_000 });
  await owner.waitForTimeout(seconds * 1000);
  await owner.getByTestId("record-stop").click();
  // The saved video arrives as a download (a summary toast can stand in front of "Video saved").
  await expect.poll(() => Object.keys(files).some((n) => /\.(webm|mp4)$/.test(n)), { timeout: 60_000, intervals: [1000] }).toBe(true);
  return { files, done: () => owner.off("download", onDl) };
}

test("with a key: the transcript is saved next to the video, with the call's words; the video has its length", async () => {
  await joinCall(owner);
  await owner.getByTestId("record-start").click();
  await expect(owner.getByTestId("video-rec-transcript")).toContainText("A transcript and summary are made too");
  const { files, done } = await recordAndStop(8);
  await expect.poll(() => Object.keys(files).some((n) => n.endsWith(" transcript.txt")), { timeout: 150_000, intervals: [2000] }).toBe(true);
  done();
  const video = Object.keys(files).find((n) => /\.(webm|mp4)$/.test(n))!;
  const name = Object.keys(files).find((n) => n.endsWith(" transcript.txt"))!;
  expect(name).toBe(video.replace(/\.(webm|mp4)$/, " transcript.txt"));
  const text = readFileSync(files[name], "utf8");
  expect(text).toContain("Transcript of Weekly sync");
  expect(text).toContain("Recording started");
  expect(text.split("\n").filter((l) => l.trim()).length).toBeGreaterThan(2);
  console.log(`PAR1 TRANSCRIPT ${name}: ${JSON.stringify(text.slice(0, 200))}`);
  // MB-352: the saved video now says how long it is.
  if (video.endsWith(".webm")) {
    const d = Number(probe(files[video]));
    console.log(`PAR1 VIDEO DURATION ${d}`);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(4);
    expect(d).toBeLessThan(30);
  }
  for (const p of Object.values(files)) rmSync(p, { force: true });
});

test("AI switched off: the dialog says so plainly, the video records, and no audio goes to the server", async () => {
  const off = await owner.request.put("/api/ai-trust", { data: { enabled: false }, headers: headers() });
  expect(off.status()).toBe(200);
  const sent: string[] = [];
  owner.on("request", (r) => { if (r.method() !== "GET" && /\/recordings(\/|$)/.test(r.url())) sent.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await joinCall(owner);
  await owner.getByTestId("record-start").click();
  await expect(owner.getByTestId("video-rec-transcript")).toHaveText("AI is off for this workspace, so no transcript is made. The video still records.");
  const { files, done } = await recordAndStop(5);
  await expect.poll(() => Object.keys(files).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await owner.waitForTimeout(8000);
  done();
  expect(Object.keys(files).some((n) => n.endsWith(" transcript.txt"))).toBe(false);
  expect(Object.keys(files).some((n) => /\.(webm|mp4)$/.test(n))).toBe(true);
  // Only the video permit check (no audio, nothing for an AI) may reach the server.
  expect(sent.filter((x) => !x.endsWith("/recordings/video"))).toEqual([]);
  const list = await (await owner.request.get(`/api/meetings/${meetingId}/recordings`)).json();
  expect(list.setup).toMatchObject({ ready: false, code: "recording_needs_ai_on" });
  for (const p of Object.values(files)) rmSync(p, { force: true });
  expect((await owner.request.put("/api/ai-trust", { data: { enabled: true }, headers: headers() })).status()).toBe(200);
});

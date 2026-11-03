import { test, expect, devices, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { confirmEmail } from "./support/confirm-email";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";

/**
 * VID3 end to end: meeting recording on phone browsers, on a real local LiveKit dev server (LIVEKIT_URL=ws://localhost,
 * outside production only) with Chromium's fake camera and microphone and Playwright's iPhone and Pixel profiles
 * (Chromium emulation: the user agent, touch and phone widths; not real Safari). The owner records on an iPhone
 * profile, pauses, resumes and stops; Save video hands the video and the chat to the share sheet (stubbed, so the
 * files can be read back); on a Pixel profile with no share sheet Save video is a download link with a real file. The
 * call going off screen pauses the recording and says so. A member is refused. Widths 375, 390 and 430 in light, dark
 * and Forest: no sideways scroll, every control 44 px tall, axe 0 serious. Nothing is uploaded. With VIDEO_PHONE_VID3
 * off a phone gets VID2 exactly (the video downloads at Stop, no Save list).
 */
const LIVE = /^ws:\/\/(localhost|127\.0\.0\.1)/.test(process.env.LIVEKIT_URL ?? "");
const ON = String(process.env.FEATURES ?? "").split(",").map((s) => s.trim()).includes("VIDEO_PHONE_VID3");
const SHOTS = process.env.SHOTS_DIR ?? "/home/user/tab/files/catalogue/vid3/shots";
const TMP = "/tmp/vid3-e2e";
test.skip(!LIVE, "needs the local LiveKit dev server (run with LIVEKIT_URL=ws://localhost:<port>)");
test.describe.configure({ mode: "serial" });
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] } });
test.setTimeout(180_000);

let visitor = 0;
const ip = () => `10.191.${test.info().workerIndex % 200}.${++visitor}`;
let origin = "";
const tag = Math.random().toString(36).slice(2, 8);
const PASSWORD = "a-strong-password";
const ownerEmail = `olive-vid3-${tag}@example.com`;
let meetingId = "";
let iphoneCtx: BrowserContext, pixelCtx: BrowserContext, mateCtx: BrowserContext;
let iphone: Page, pixel: Page, mate: Page;

const { defaultBrowserType: _a, ...IPHONE } = devices["iPhone 13"];
const { defaultBrowserType: _b, ...PIXEL } = devices["Pixel 7"];

async function phone(browser: Browser, profile: typeof IPHONE, width: number, height: number) {
  const base = test.info().project.use.baseURL!;
  origin = new URL(base).origin;
  const ctx = await browser.newContext({ ...profile, deviceScaleFactor: 1, baseURL: base, viewport: { width, height }, permissions: ["camera", "microphone"], acceptDownloads: true, reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  return { ctx, page: await ctx.newPage() };
}
const headers = () => ({ origin });
async function axeSerious(page: Page, include?: string) {
  await page.waitForTimeout(400);
  let b = new AxeBuilder({ page });
  if (include) b = b.include(include);
  const { violations } = await b.analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}
async function shot(page: Page, name: string) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}.png` }); }
async function theme(page: Page, t: "light" | "dark") { await page.evaluate((v) => { localStorage.setItem("multies-theme", v); document.documentElement.dataset.theme = v; }, t); }
async function joinCall(page: Page) {
  await page.goto(`/app/meetings/${meetingId}?join=1`);
  await expect(page.getByTestId("prejoin-join").or(page.getByTestId("call-screen"))).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId("prejoin-join").isVisible()) await page.getByTestId("prejoin-join").click({ timeout: 5_000 }).catch(() => undefined);
  await expect(page.getByTestId("call-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("record-start").or(page.getByTestId("recording-banner"))).toBeVisible({ timeout: 30_000 });
}
/** The phone's share sheet, stubbed so the test can read what was handed to it (names, sizes, types, first bytes). */
const fakeShare = () => {
  const w = window as unknown as { __shared: { name: string; size: number; type: string; head: number[] }[][] };
  w.__shared = [];
  Object.defineProperty(navigator, "canShare", { configurable: true, value: (d?: { files?: File[] }) => !!d?.files?.length });
  Object.defineProperty(navigator, "share", { configurable: true, value: async (d: { files?: File[] }) => {
    const out = [];
    for (const f of d.files ?? []) out.push({ name: f.name, size: f.size, type: f.type, head: [...new Uint8Array(await f.slice(0, 12).arrayBuffer())] });
    w.__shared.push(out);
  } });
};
/** Sideways scroll, controls under 44 px tall, controls off screen or on top of each other, in the recording layer. */
const layout = (page: Page) => page.evaluate(() => {
  const bad: string[] = [];
  const W = window.innerWidth;
  if (document.documentElement.scrollWidth > W + 1) bad.push(`page scrolls sideways ${document.documentElement.scrollWidth} > ${W}`);
  const root = document.querySelector("[data-testid=recording-layer]");
  if (!root) return ["no recording layer"];
  const ctl = Array.from(root.querySelectorAll<HTMLElement>("button, a[href], label:has(input[type=radio])")).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  for (const e of ctl) {
    const r = e.getBoundingClientRect();
    const name = (e.textContent ?? "").trim().slice(0, 24) || e.getAttribute("data-testid") || e.tagName;
    if (r.height < 43.5) bad.push(`small "${name}" ${Math.round(r.height)}px`);
    if (r.left < -1 || r.right > W + 1) bad.push(`offscreen "${name}"`);
  }
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    const a = ctl[i].getBoundingClientRect(), b = ctl[j].getBoundingClientRect();
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(`overlap "${(ctl[i].textContent ?? "").trim().slice(0, 16)}" "${(ctl[j].textContent ?? "").trim().slice(0, 16)}"`);
  }
  return bad;
});
const away = (page: Page, state: "hidden" | "visible") => page.evaluate((s) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}, state);
function watchUploads(page: Page) {
  const uploads: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "GET" || r.url().startsWith("data:") || r.url().startsWith("blob:")) return;
    const size = r.postDataBuffer()?.length ?? 0;
    const type = r.headers()["content-type"] ?? "";
    if (size > 200_000 || /video|octet-stream|multipart/i.test(type)) uploads.push(`${r.method()} ${r.url()} ${type} ${size}`);
  });
  return uploads;
}
async function startRecording(page: Page) {
  await page.getByTestId("record-start").click();
  const dialog = page.getByTestId("video-rec-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("video-rec-memory")).toBeEnabled({ timeout: 15_000 });
  return dialog;
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(TMP, { recursive: true });
  ({ ctx: iphoneCtx, page: iphone } = await phone(browser, IPHONE, 390, 844));
  expect((await iphone.request.post("/api/auth/sign-up/email", { data: { name: "Olive Owner", email: ownerEmail, password: PASSWORD }, headers: headers() })).status()).toBe(200);
  await iphone.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers: headers() });
  const made = await iphone.request.post("/api/meetings", { data: { title: "Weekly sync", startsAt: new Date().toISOString(), durationMin: 30 }, headers: headers() });
  expect(made.status()).toBe(201);
  meetingId = (await made.json()).meeting.id;
  // The same owner on an Android phone (signed in on a second device).
  ({ ctx: pixelCtx, page: pixel } = await phone(browser, PIXEL, 430, 932));
  await confirmEmail(pixel.request, ownerEmail).catch(() => undefined);
  expect((await pixel.request.post("/api/auth/sign-in/email", { data: { email: ownerEmail, password: PASSWORD }, headers: headers() })).status()).toBe(200);
  // A member, on a phone too.
  const invite = await iphone.request.post("/api/team/invites", { data: { email: `sam-vid3-${tag}@example.com`, role: "member" }, headers: headers() });
  const token = ((await invite.json()).link as string).split("/invite/")[1];
  ({ ctx: mateCtx, page: mate } = await phone(browser, PIXEL, 375, 812));
  expect((await mate.request.post("/api/auth/sign-up/email", { data: { name: "Sam Mate", email: `sam-vid3-${tag}@example.com`, password: PASSWORD }, headers: headers() })).status()).toBe(200);
  await confirmEmail(mate.request, `sam-vid3-${tag}@example.com`);
  expect([200, 410]).toContain((await mate.request.post(`/api/invites/${token}/accept`, { data: {}, headers: headers() })).status());
  expect((await (await mate.request.get("/api/account/me")).json()).organization?.role).toBe("member");
});
test.afterAll(async () => { await iphoneCtx?.close(); await pixelCtx?.close(); await mateCtx?.close(); rmSync(TMP, { recursive: true, force: true }); });

test.describe("flag on", () => {
  test.skip(!ON, "VIDEO_PHONE_VID3 is off in this run");

  test("a member on a phone is refused the video permit (403); config says on", async () => {
    // The member is not on this meeting, so the meeting is hidden from them (404) or refused (403); never 200.
    expect([403, 404]).toContain((await mate.request.post(`/api/meetings/${meetingId}/recordings/video`, { data: {}, headers: headers() })).status());
    // A call in the team chat they belong to: the meeting is theirs to see, the video permit still refused.
    const g = ((await (await mate.request.get("/api/chat/channels")).json()).channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const call = await mate.request.post(`/api/chat/channels/${g.id}/call`, { data: {}, headers: headers() });
    expect([200, 201]).toContain(call.status());
    const callId = (await call.json()).meeting.id as string;
    expect((await mate.request.post(`/api/meetings/${callId}/recordings/video`, { data: {}, headers: headers() })).status()).toBe(403);
    expect((await iphone.request.post(`/api/meetings/${callId}/recordings/video`, { data: {}, headers: headers() })).status()).toBe(200);
    expect((await (await iphone.request.get("/api/config")).json()).videoPhoneVid3).toBe(true);
  });

  test("iPhone: record, pause, resume, stop; Save video hands the video and the chat to the share sheet; nothing uploaded", async () => {
    await iphone.addInitScript(fakeShare);
    const uploads = watchUploads(iphone);
    await joinCall(iphone);
    const dialog = await startRecording(iphone);
    await expect(iphone.getByTestId("video-rec-where")).toContainText("tap Save video to keep it in Files, Photos or your gallery");
    await expect(iphone.getByTestId("video-rec-quality-hd1080")).toBeDisabled();
    expect(await axeSerious(iphone, "dialog")).toEqual([]);
    await shot(iphone, "vid3-390-light-dialog");
    await iphone.getByTestId("video-rec-memory").click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await expect(iphone.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await iphone.waitForTimeout(2500);
    expect(await layout(iphone)).toEqual([]);
    expect(await axeSerious(iphone, "[data-testid=recording-layer]")).toEqual([]);
    await shot(iphone, "vid3-390-light-recording");
    await iphone.getByTestId("record-pause").click();
    await expect(iphone.getByTestId("recording-banner")).toHaveAttribute("data-paused", "1");
    await iphone.getByTestId("record-resume").click();
    await expect(iphone.getByTestId("recording-banner")).not.toHaveAttribute("data-paused", "1");
    await iphone.waitForTimeout(2500);
    await iphone.getByTestId("record-stop").click();
    const ready = iphone.getByTestId("video-ready");
    await expect(ready).toBeVisible({ timeout: 20_000 });
    await expect(ready).toHaveAttribute("data-mode", "share");
    await expect(ready).toContainText("Video ready to save");
    // Nothing was saved on its own: a phone saves only from the person's tap.
    expect(await iphone.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length)).toBe(0);
    expect(await layout(iphone)).toEqual([]);
    expect(await axeSerious(iphone, "[data-testid=recording-layer]")).toEqual([]);
    await shot(iphone, "vid3-390-light-ready");
    await iphone.getByTestId("video-ready-save").click();
    await expect(ready).toHaveAttribute("data-saves", "1");
    await expect(ready).toContainText("Video saved");
    const shared = await iphone.evaluate(() => (window as unknown as { __shared: { name: string; size: number; type: string; head: number[] }[][] }).__shared);
    expect(shared.length).toBe(1);
    const [video, ...sides] = shared[0];
    expect(video.size).toBeGreaterThan(20_000);
    expect(video.type).toMatch(/^video\/(mp4|webm)/);
    expect(video.name).toMatch(new RegExp(`^Meeting Weekly sync \\d{1,2} [A-Z][a-z]{2} \\d{4} \\d{2}\\.\\d{2}\\.${video.type.includes("mp4") ? "mp4" : "webm"}$`));
    if (video.type.includes("webm")) expect(video.head.slice(0, 4)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    else expect(String.fromCharCode(...video.head.slice(4, 8))).toBe("ftyp");
    expect(sides.map((s) => s.name)).toEqual([video.name.replace(/\.(mp4|webm)$/, " chat.txt")]);
    expect(sides[0].type).toMatch(/^text\/plain/);
    await shot(iphone, "vid3-390-light-saved");
    await iphone.getByTestId("video-ready-done").click();
    await expect(ready).toHaveCount(0);
    expect(uploads).toEqual([]);
  });

  test("the call going off screen pauses the recording and says so; Resume carries on; Discard asks twice", async () => {
    if (!(await iphone.getByTestId("call-screen").count())) await joinCall(iphone);
    await startRecording(iphone);
    await iphone.getByTestId("video-rec-memory").click();
    await expect(iphone.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await iphone.waitForTimeout(1500);
    await away(iphone, "hidden");
    await expect(iphone.getByTestId("recording-banner")).toHaveAttribute("data-paused", "1");
    await away(iphone, "visible");
    await expect(iphone.getByTestId("record-consent")).toContainText("Recording paused while the call was off screen");
    expect(await layout(iphone)).toEqual([]);
    await theme(iphone, "dark");
    await shot(iphone, "vid3-390-dark-paused-away");
    await iphone.getByTestId("record-resume").click();
    await expect(iphone.getByTestId("recording-banner")).not.toHaveAttribute("data-paused", "1");
    await expect(iphone.getByTestId("record-consent")).not.toContainText("off screen");
    await iphone.waitForTimeout(1500);
    await iphone.getByTestId("record-stop").click();
    const ready = iphone.getByTestId("video-ready");
    await expect(ready).toBeVisible({ timeout: 20_000 });
    await shot(iphone, "vid3-390-dark-ready");
    await iphone.getByTestId("video-ready-done").click();
    await expect(iphone.getByTestId("video-ready-done")).toHaveText("Tap again to discard");
    await iphone.getByTestId("video-ready-done").click();
    await expect(ready).toHaveCount(0);
    await theme(iphone, "light");
  });

  test("Android with no share sheet: Save video is a download link with a real file", async () => {
    await pixel.addInitScript(() => { Object.defineProperty(navigator, "share", { configurable: true, value: undefined }); Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined }); });
    const uploads = watchUploads(pixel);
    await joinCall(pixel);
    await startRecording(pixel);
    await pixel.getByTestId("video-rec-memory").click();
    await expect(pixel.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await pixel.waitForTimeout(3000);
    expect(await layout(pixel)).toEqual([]);
    await shot(pixel, "vid3-430-light-recording");
    await pixel.getByTestId("record-stop").click();
    const ready = pixel.getByTestId("video-ready");
    await expect(ready).toBeVisible({ timeout: 20_000 });
    await expect(ready).toHaveAttribute("data-mode", "download");
    await expect(ready).toContainText("Save video downloads it to this phone");
    const [dl] = await Promise.all([pixel.waitForEvent("download"), pixel.getByTestId("video-ready-save").click()]);
    const name = dl.suggestedFilename();
    expect(name).toMatch(/^Meeting Weekly sync .+\.(mp4|webm)$/);
    const path = `${TMP}/${name}`;
    await dl.saveAs(path);
    expect(statSync(path).size).toBeGreaterThan(20_000);
    const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path], { encoding: "utf8", timeout: 60_000 });
    expect(streams).toContain("video");
    expect(streams).toContain("audio");
    await expect(ready).toHaveAttribute("data-saves", "1");
    // The chat is offered on its own link (this browser can't share several files).
    const side = pixel.getByTestId("video-ready-side");
    await expect(side).toHaveCount(1);
    const [cdl] = await Promise.all([pixel.waitForEvent("download"), side.click()]);
    expect(cdl.suggestedFilename()).toMatch(/ chat\.txt$/);
    expect(await layout(pixel)).toEqual([]);
    expect(await axeSerious(pixel, "[data-testid=recording-layer]")).toEqual([]);
    await shot(pixel, "vid3-430-light-saved");
    await theme(pixel, "dark");
    await shot(pixel, "vid3-430-dark-saved");
    await theme(pixel, "light");
    await pixel.getByTestId("video-ready-done").click();
    expect(uploads).toEqual([]);
  });

  test("375, 390 and 430 in light, dark and Forest: controls 44 px, no sideways scroll, axe clean", async () => {
    // Forest for the workspace (owner, on the phone).
    await iphone.setViewportSize({ width: 390, height: 844 });
    await iphone.goto("/app/settings/branding");
    await expect(iphone.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
    await iphone.getByRole("button", { name: "Forest", exact: true }).click();
    const save = iphone.getByTestId("brand-actions").getByRole("button", { name: /save/i });
    if (await save.count()) await save.first().click();
    await iphone.waitForTimeout(800);
    await joinCall(iphone);
    await startRecording(iphone);
    await iphone.getByTestId("video-rec-memory").click();
    await expect(iphone.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    for (const [w, h] of [[375, 812], [390, 844], [430, 932]] as const) for (const t of ["light", "dark"] as const) {
      await iphone.setViewportSize({ width: w, height: h });
      await theme(iphone, t);
      await iphone.waitForTimeout(300);
      expect(await layout(iphone), `recording ${w} ${t}`).toEqual([]);
      expect(await axeSerious(iphone, "[data-testid=recording-layer]"), `recording ${w} ${t}`).toEqual([]);
      await shot(iphone, `vid3-${w}-${t}-forest-recording`);
    }
    await iphone.getByTestId("record-stop").click();
    await expect(iphone.getByTestId("video-ready")).toBeVisible({ timeout: 20_000 });
    for (const [w, h] of [[375, 812], [390, 844], [430, 932]] as const) for (const t of ["light", "dark"] as const) {
      await iphone.setViewportSize({ width: w, height: h });
      await theme(iphone, t);
      await iphone.waitForTimeout(300);
      expect(await layout(iphone), `ready ${w} ${t}`).toEqual([]);
      expect(await axeSerious(iphone, "[data-testid=recording-layer]"), `ready ${w} ${t}`).toEqual([]);
      await shot(iphone, `vid3-${w}-${t}-forest-ready`);
    }
    // Hanging up keeps the video: the meeting page shows the same Save list.
    await theme(iphone, "light");
    await iphone.setViewportSize({ width: 390, height: 844 });
    await iphone.locator(".lk-disconnect-button").first().click();
    await expect(iphone.getByTestId("call-screen")).toHaveCount(0, { timeout: 15_000 });
    await expect(iphone.getByTestId("video-ready")).toBeVisible({ timeout: 15_000 });
    expect(await axeSerious(iphone, "[data-testid=video-ready-list]")).toEqual([]);
    await shot(iphone, "vid3-390-light-forest-meeting-page");
  });
});

test.describe("flag off", () => {
  test.skip(ON, "VIDEO_PHONE_VID3 is on in this run");
  test("a phone gets VID2 exactly: the video downloads at Stop and no Save list shows", async () => {
    expect((await (await iphone.request.get("/api/config")).json()).videoPhoneVid3).toBe(false);
    await joinCall(iphone);
    await startRecording(iphone);
    // VID2 as it is: Chromium (even with the iPhone profile) offers its save picker; save at the end downloads at Stop.
    await expect(iphone.getByTestId("video-rec-where")).toContainText("Choose where to save the video");
    await iphone.getByTestId("video-rec-memory").click();
    await expect(iphone.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await iphone.waitForTimeout(2500);
    const [dl] = await Promise.all([iphone.waitForEvent("download", { timeout: 30_000 }), iphone.getByTestId("record-stop").click()]);
    expect(dl.suggestedFilename()).toMatch(/\.webm$/);
    await expect(iphone.getByTestId("video-ready")).toHaveCount(0);
    await shot(iphone, "vid3-390-light-flag-off");
  });
});

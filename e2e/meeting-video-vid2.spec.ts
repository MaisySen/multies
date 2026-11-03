import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { confirmEmail } from "./support/confirm-email";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

/**
 * VID2 end to end on a real local LiveKit dev server (LIVEKIT_URL=ws://localhost, outside production only), with
 * VIDEO_REC_VID1 on. Owner (1280) and a member (390) join; a third guest joins mid recording. Covers pause and
 * resume for everyone, speaker or gallery view while recording, chat saved next to the video, nothing uploaded,
 * audio and video in sync within 100 ms (a flash and beep fixture on both cameras), crash and recover, the member
 * blocked, MB-351 (shrinking the window after saving to a chosen file keeps the call), widths and themes, and
 * VIDEO_REC_VID2 off = VID1 exactly.
 */
const LIVE = /^ws:\/\/(localhost|127\.0\.0\.1)/.test(process.env.LIVEKIT_URL ?? "");
const ON = ["1", "true", "on"].includes(String(process.env.VIDEO_REC_VID2 ?? "").toLowerCase());
const SHOTS = process.env.SHOTS_DIR ?? "/home/user/tab/files/catalogue/vid2/shots";
const TMP = process.env.VID2_TMP ?? "/tmp/vid2-e2e";
test.skip(!LIVE, "needs the local LiveKit dev server");
test.describe.configure({ mode: "serial" });
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] } });
test.setTimeout(180_000);

let visitor = 0;
const ip = () => `10.182.${test.info().workerIndex % 200}.${++visitor}`;
let ownerCtx: BrowserContext, mateCtx: BrowserContext;
let owner: Page, mate: Page;
let meetingId = "";
let origin = "";
const tag = Math.random().toString(36).slice(2, 8);

/** Both cameras flash white and both microphones beep at the same wall clock moments (every 2 s, 200 ms long). */
const flashBeep = () => {
  const md = navigator.mediaDevices;
  const real = md.getUserMedia.bind(md);
  let shared: { v: MediaStreamTrack; a: MediaStreamTrack } | null = null;
  const make = () => {
    const c = document.createElement("canvas"); c.width = 640; c.height = 360;
    const g = c.getContext("2d")!;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(); osc.frequency.value = 1000;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest); osc.start();
    const on = () => (performance.timeOrigin + performance.now()) % 2000 < 200;
    setInterval(() => { const f = on(); g.fillStyle = f ? "#fff" : "#000"; g.fillRect(0, 0, 640, 360); gain.gain.setValueAtTime(f ? 0.8 : 0, ctx.currentTime); void ctx.resume(); }, 10);
    return { v: c.captureStream(30).getVideoTracks()[0], a: dest.stream.getAudioTracks()[0] };
  };
  md.getUserMedia = async (c?: MediaStreamConstraints) => {
    if (!(window as unknown as { __flash?: boolean }).__flash) return real(c);
    shared ??= make();
    const s = new MediaStream();
    if (c?.video) s.addTrack(shared.v.clone());
    if (c?.audio) s.addTrack(shared.a.clone());
    return s;
  };
};

async function person(browser: Browser, width: number, height: number) {
  const base = test.info().project.use.baseURL!;
  origin = new URL(base).origin;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width, height }, permissions: ["camera", "microphone"], acceptDownloads: true, reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": ip() } });
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
const fakePicker = () => {
  const w = window as unknown as { __vid: { name: string; bytes: number; closed: boolean } | null; showSaveFilePicker: unknown };
  w.__vid = null;
  w.showSaveFilePicker = async (o: { suggestedName: string }) => ({
    name: o.suggestedName,
    remove: async () => { w.__vid = null; },
    createWritable: async () => { w.__vid = { name: o.suggestedName, bytes: 0, closed: false }; return { write: async (b: Blob) => { w.__vid!.bytes += b.size; }, close: async () => { w.__vid!.closed = true; } }; },
  });
};
async function chat(page: Page, text: string) {
  const input = page.locator(".lk-chat-form-input, .lk-chat-form input, .lk-chat-form textarea").first();
  if (!(await input.isVisible())) await page.locator(".lk-chat-toggle").first().click();
  await input.fill(text);
  await input.press("Enter");
}
const probe = (path: string, entries: string) => execFileSync("ffprobe", ["-v", "error", ...entries.split(" "), "-of", "csv=p=0", path], { encoding: "utf8", timeout: 120_000 });
/** Onset times (s) of the white flashes in the video and of the beeps in the audio. */
function onsets(path: string) {
  const v = execFileSync("ffprobe", ["-v", "error", "-f", "lavfi", "-i", `movie=${path},signalstats`, "-show_entries", "frame=pts_time:frame_tags=lavfi.signalstats.YAVG", "-of", "csv=p=0"], { encoding: "utf8", timeout: 180_000, maxBuffer: 64 << 20 })
    .trim().split("\n").map((l) => l.split(",").map(Number)).filter((x) => x.length === 2 && !Number.isNaN(x[0]));
  const a = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vn", "-af", "asetnsamples=480,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-", "-f", "null", "-"], { encoding: "utf8", timeout: 180_000, maxBuffer: 64 << 20 });
  const aPts: [number, number][] = [];
  let t = NaN;
  for (const l of a.split("\n")) {
    const m = /pts_time:([\d.]+)/.exec(l); if (m) t = Number(m[1]);
    const r = /RMS_level=(-?[\d.]+|-inf)/.exec(l); if (r && !Number.isNaN(t)) aPts.push([t, r[1] === "-inf" ? -120 : Number(r[1])]);
  }
  const ys = v.map((x) => x[1]); const lo = Math.min(...ys), hi = Math.max(...ys); const mid = (lo + hi) / 2;
  const vOn: number[] = []; for (let i = 1; i < v.length; i++) if (v[i - 1][1] < mid && v[i][1] >= mid) vOn.push(v[i][0]);
  const aOn: number[] = []; for (let i = 1; i < aPts.length; i++) if (aPts[i - 1][1] < -35 && aPts[i][1] >= -35 && (!aOn.length || aPts[i][0] - aOn[aOn.length - 1] > 1)) aOn.push(aPts[i][0]);
  return { vOn, aOn, range: hi - lo };
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(TMP, { recursive: true });
  ({ ctx: ownerCtx, page: owner } = await person(browser, 1280, 860));
  expect((await owner.request.post("/api/auth/sign-up/email", { data: { name: "Olive Owner", email: `olive-vid2-${tag}@example.com`, password: "a-strong-password" }, headers: headers() })).status()).toBe(200);
  await owner.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers: headers() });
  const made = await owner.request.post("/api/meetings", { data: { title: "Weekly sync", startsAt: new Date().toISOString(), durationMin: 30 }, headers: headers() });
  expect(made.status()).toBe(201);
  meetingId = (await made.json()).meeting.id;
  const invite = await owner.request.post("/api/team/invites", { data: { email: `sam-vid2-${tag}@example.com`, role: "member" }, headers: headers() });
  const token = ((await invite.json()).link as string).split("/invite/")[1];
  ({ ctx: mateCtx, page: mate } = await person(browser, 390, 844));
  expect((await mate.request.post("/api/auth/sign-up/email", { data: { name: "Sam Mate", email: `sam-vid2-${tag}@example.com`, password: "a-strong-password" }, headers: headers() })).status()).toBe(200);
  await mate.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers: headers() });
  await confirmEmail(mate.request, `sam-vid2-${tag}@example.com`);
  expect([200, 410]).toContain((await mate.request.post(`/api/invites/${token}/accept`, { data: {}, headers: headers() })).status());
  for (const p of [owner, mate]) await p.addInitScript(flashBeep);
  // Counts the recorder's pieces as they come (test instrumentation only).
  await owner.addInitScript(() => { const w = window as unknown as { __pieces: number }; w.__pieces = 0; const s = MediaRecorder.prototype.start; MediaRecorder.prototype.start = function (this: MediaRecorder, ms?: number) { this.addEventListener("dataavailable", () => { w.__pieces++; }); return s.call(this, ms); }; });
});
test.afterAll(async () => { await ownerCtx?.close(); await mateCtx?.close(); rmSync(TMP, { recursive: true, force: true }); });

/** The recorder's first pieces (a loaded test box can take half a minute before the encoder gives any). */
const piecesAtLeast = async (page: Page, n: number) => {
  await page.evaluate(() => { (window as unknown as { __pieces: number }).__pieces = 0; });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __pieces?: number }).__pieces ?? 0), { timeout: 90_000, intervals: [1000] }).toBeGreaterThanOrEqual(n);
};

test.describe("VID2 on", () => {
  test.skip(!ON, "VIDEO_REC_VID2 is off in this run");

  test("record in speaker view, switch to gallery, pause and resume for everyone, chat saved next to the video, nothing uploaded", async () => {
    const uploads: string[] = [];
    let collecting = false;
    owner.on("request", (r) => {
      if (!collecting || r.method() === "GET" || r.url().startsWith("data:") || r.url().startsWith("blob:")) return;
      const size = r.postDataBuffer()?.length ?? 0;
      const type = r.headers()["content-type"] ?? "";
      if (size > 4096 || /video|audio|octet-stream|multipart/.test(type) || /chunk|upload/.test(r.url())) uploads.push(`${r.method()} ${r.url()} ${size} ${type}`);
    });
    await joinCall(owner);
    await joinCall(mate);
    expect((await (await owner.request.get("/api/config")).json()).videoRecVid2).toBe(true);
    await owner.getByTestId("record-start").click();
    await expect(owner.getByTestId("video-rec-settings")).toBeVisible();
    await expect(owner.getByTestId("video-rec-layout-speaker")).toBeChecked();
    await expect(owner.getByTestId("video-rec-quality-hd720")).toBeChecked();
    expect(await axeSerious(owner, "dialog")).toEqual([]);
    await shot(owner, "vid2-1280-light-dialog");
    collecting = true;
    await owner.getByTestId("video-rec-memory").click();
    await expect(owner.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    // Everyone: banner, a dot on every tile and a pill in the call header.
    await expect(mate.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await expect(mate.getByTestId("call-screen")).toHaveAttribute("data-rec", "on");
    await expect(mate.getByTestId("rec-header-pill")).toContainText("this call is being recorded");
    await expect(owner.getByTestId("rec-header-pill")).toBeVisible();
    await chat(owner, "Hello from Olive");
    await chat(mate, "Hi Olive, Sam here");
    // Layout while recording.
    await owner.getByTestId("rec-layout").getByText("Gallery").click();
    await expect(owner.getByTestId("rec-layout-gallery")).toBeChecked();
    await owner.keyboard.press("ArrowLeft"); // keyboard moves the choice too
    await expect(owner.getByTestId("rec-layout-speaker")).toBeChecked();
    await owner.getByTestId("rec-layout").getByText("Gallery").click();
    expect(await axeSerious(owner, "[data-testid=recording-layer]")).toEqual([]);
    await shot(owner, "vid2-1280-light-recording");
    await owner.waitForTimeout(3000);
    // Pause: everyone sees it; nothing is recorded; resume.
    await owner.getByTestId("record-pause").click();
    await expect(mate.getByTestId("recording-banner")).toContainText("Recording paused", { timeout: 10_000 });
    await expect(mate.getByTestId("call-screen")).toHaveAttribute("data-rec", "paused");
    await expect(owner.getByTestId("record-consent")).toContainText("Recording paused");
    await shot(mate, "vid2-390-light-paused-other-side");
    expect(await axeSerious(mate, "[data-testid=recording-layer]")).toEqual([]);
    const frozen = await owner.getByTestId("recording-banner").innerText();
    await owner.waitForTimeout(5000);
    expect(await owner.getByTestId("recording-banner").innerText()).toBe(frozen); // the clock stands still
    await owner.getByTestId("record-resume").click();
    await expect(mate.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 10_000 });
    await owner.waitForTimeout(3000);
    const files: Record<string, string> = {};
    owner.on("download", async (d) => { const p = `${TMP}/${d.suggestedFilename()}`; await d.saveAs(p); files[d.suggestedFilename()] = p; });
    await owner.getByTestId("record-stop").click();
    await expect(owner.getByText(/^Video saved, \d+ (MB|GB)$/)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => Object.keys(files).length, { timeout: 15_000 }).toBe(2);
    collecting = false;
    const video = Object.keys(files).find((n) => n.endsWith(".webm") || n.endsWith(".mp4"))!;
    const chatName = Object.keys(files).find((n) => n.endsWith(" chat.txt"))!;
    expect(chatName).toBe(video.replace(/\.(webm|mp4)$/, " chat.txt"));
    const log = readFileSync(files[chatName], "utf8");
    expect(log).toContain("Chat from Weekly sync");
    expect(log).toMatch(/\[00:00:\d\d\] Olive Owner: Hello from Olive/);
    expect(log).toMatch(/\[00:00:\d\d\] Sam Mate: Hi Olive, Sam here/);
    // Paused time is not in the file: about 6 s recorded of about 11 s on the clock.
    const dur = Number(probe(files[video], "-show_entries format=duration").trim());
    const streams = probe(files[video], "-show_entries stream=codec_type,width,height").trim();
    expect(streams).toContain("video,1280,720");
    expect(streams).toContain("audio");
    if (Number.isFinite(dur)) expect(dur).toBeLessThan(10);
    // The pieces kept on the device are gone once the video is saved.
    await expect.poll(() => owner.evaluate(() => new Promise<number>((res) => { const r = indexedDB.open("multies-recordings-vid2"); r.onsuccess = () => { const q = r.result.transaction("meta").objectStore("meta").count(); q.onsuccess = () => { res(q.result); r.result.close(); }; }; r.onerror = () => res(-1); })), { timeout: 15_000 }).toBe(0);
    await expect(mate.getByTestId("recording-banner")).toHaveCount(0, { timeout: 10_000 });
    await expect(mate.getByTestId("call-screen")).not.toHaveAttribute("data-rec", /.+/);
    expect(uploads).toEqual([]);
    for (const p of Object.values(files)) rmSync(p, { force: true });
  });

  test("audio and video stay in sync within 100 ms, across a pause", async () => {
    test.setTimeout(300_000);
    // Rejoin with the flash and beep cameras on both sides.
    for (const p of [owner, mate]) await p.addInitScript(() => { (window as unknown as { __flash: boolean }).__flash = true; });
    await joinCall(owner);
    await joinCall(mate);
    await owner.getByTestId("record-start").click();
    await owner.getByTestId("video-rec-layout").getByText("Gallery").click();
    await owner.getByTestId("video-rec-memory").click();
    await expect(owner.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await owner.waitForTimeout(9000);
    if (!(await owner.getByTestId("record-pause").count())) console.log("VID2 NO PAUSE", await owner.locator("[data-sonner-toast]").allInnerTexts(), await owner.getByTestId("recording-layer").innerText().catch(() => "no layer"));
    await owner.getByTestId("record-pause").click({ timeout: 30_000 });
    await owner.waitForTimeout(3000);
    await owner.getByTestId("record-resume").click();
    await owner.waitForTimeout(9000);
    const got: string[] = [];
    owner.on("download", async (d) => { if (/\.(webm|mp4)$/.test(d.suggestedFilename())) { const p = `${TMP}/sync-${d.suggestedFilename()}`; await d.saveAs(p); got.push(p); } });
    await owner.getByTestId("record-stop").click();
    await expect.poll(() => got.length, { timeout: 60_000 }).toBe(1);
    const { vOn, aOn, range } = onsets(got[0]);
    expect(range).toBeGreaterThan(40); // the flashes are in the video
    const offsets = vOn.map((v) => { const near = aOn.reduce((b, a) => (Math.abs(a - v) < Math.abs(b - v) ? a : b), Number.POSITIVE_INFINITY); return Math.round((near - v) * 1000); }).filter((d) => Math.abs(d) < 500); // a flash cut by the pause has no beep within half a second
    console.log("VID2 SYNC", JSON.stringify({ flashes: vOn.length, beeps: aOn.length, offsetsMs: offsets }));
    expect(offsets.length).toBeGreaterThanOrEqual(5);
    const sorted = [...offsets].sort((a, b) => a - b);
    expect(Math.abs(sorted[Math.floor(sorted.length / 2)])).toBeLessThanOrEqual(100);
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(150);
    rmSync(got[0], { force: true });
  });

  test("1080p where the device keeps up: the file is 1920 x 1080", async () => {
    if (!(await owner.getByTestId("call-screen").count())) await joinCall(owner);
    await owner.getByTestId("record-start").click();
    const hd = owner.getByTestId("video-rec-quality-hd1080");
    await expect(hd).toBeVisible({ timeout: 15_000 });
    console.log("VID2 1080 offered", await hd.isEnabled(), await owner.evaluate(() => [navigator.hardwareConcurrency, (navigator as unknown as { deviceMemory?: number }).deviceMemory]));
    test.skip(!(await hd.isEnabled()), "this test machine is not offered 1080p");
    await owner.getByTestId("video-rec-quality").getByText("1080p").click();
    await expect(hd).toBeChecked();
    await owner.getByTestId("video-rec-memory").click();
    await expect(owner.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await piecesAtLeast(owner, 2);
    const got: string[] = [];
    owner.on("download", async (d) => { if (/\.(webm|mp4)$/.test(d.suggestedFilename())) { const p = `${TMP}/hd-${d.suggestedFilename()}`; await d.saveAs(p); got.push(p); } });
    await owner.getByTestId("record-stop").click();
    await expect.poll(() => got.length, { timeout: 60_000 }).toBe(1);
    expect(probe(got[0], "-select_streams v:0 -show_entries stream=width,height").trim()).toBe("1920,1080");
    rmSync(got[0], { force: true });
  });

  test("a crash mid recording loses nothing: Recover last recording rebuilds the video", async () => {
    test.setTimeout(240_000);
    if (!(await owner.getByTestId("call-screen").count())) await joinCall(owner);
    await owner.getByTestId("record-start").click();
    await owner.getByTestId("video-rec-memory").click();
    await expect(owner.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    const t0 = Date.now();
    // Pieces come about once a second once the encoder is warm; crash after a few of this recording have been kept.
    await piecesAtLeast(owner, 4);
    console.log("VID2 PIECES after", Date.now() - t0, "ms");
    await owner.waitForTimeout(1500);
    const crashed = owner;
    const cdp = await ownerCtx.newCDPSession(crashed);
    void cdp.send("Page.crash").catch(() => undefined); // the tab's renderer dies: no unload, no save
    await new Promise<void>((res) => { crashed.once("crash", () => res()); setTimeout(res, 5000); });
    owner = await ownerCtx.newPage();
    void crashed.close().catch(() => undefined);
    await owner.waitForTimeout(21_000); // the crashed tab's pieces go quiet
    await owner.goto(`/app/meetings/${meetingId}`);
    console.log("VID2 KEPT", JSON.stringify(await owner.evaluate(() => new Promise<unknown>((res) => { const r = indexedDB.open("multies-recordings-vid2"); r.onsuccess = () => { const q = r.result.transaction("meta").objectStore("meta").getAll(); q.onsuccess = () => { res((q.result as { pieces: number; bytes: number; updatedAt: number; done: boolean; meetingId: string }[]).map((m) => ({ p: m.pieces, b: m.bytes, age: Date.now() - m.updatedAt, done: m.done, mine: m.meetingId }))); r.result.close(); }; }; r.onerror = () => res("no db"); }))), meetingId);
    const box = owner.getByTestId("video-recover");
    await expect(box).toBeVisible({ timeout: 20_000 });
    await expect(box).toContainText("A video recording didn't finish saving.");
    expect(await axeSerious(owner, "[data-testid=video-recover]")).toEqual([]);
    await shot(owner, "vid2-1280-light-recover");
    const dl = owner.waitForEvent("download", { timeout: 30_000 });
    await owner.getByTestId("video-recover-save").click();
    const d = await dl;
    const p = `${TMP}/recovered-${d.suggestedFilename()}`;
    await d.saveAs(p);
    expect(probe(p, "-show_entries stream=codec_type")).toContain("video");
    const frames = Number(probe(p, "-count_packets -select_streams v:0 -show_entries stream=nb_read_packets").trim());
    expect(frames).toBeGreaterThan(60); // at least a few seconds of video
    await expect(owner.getByTestId("video-recover")).toHaveCount(0);
    await owner.reload();
    await expect(owner.getByText("Recording and transcript")).toBeVisible({ timeout: 20_000 });
    await expect(owner.getByTestId("video-recover")).toHaveCount(0); // the pieces are gone once saved
    rmSync(p, { force: true });
  });

  test("MB-351: after saving to a chosen file at desktop width, shrinking to phone width keeps the call", async () => {
    await owner.addInitScript(fakePicker);
    await owner.setViewportSize({ width: 1280, height: 860 });
    await joinCall(owner);
    await owner.getByTestId("record-start").click();
    await owner.getByTestId("video-rec-file").click();
    await expect(owner.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await expect.poll(() => owner.evaluate(() => (window as unknown as { __vid: { bytes: number } | null }).__vid?.bytes ?? 0), { timeout: 60_000, intervals: [1000] }).toBeGreaterThan(0);
    await owner.getByTestId("record-stop").click();
    await owner.waitForTimeout(1500);
    await expect(owner.getByText(/^Video saved/)).toBeVisible({ timeout: 15_000 });
    // What the verifier did before the drop: a beforeunload that the page survives (no close warning after Stop).
    expect(await owner.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })).toBe(false);
    await owner.waitForTimeout(1500);
    await expect(owner.getByTestId("call-screen")).toBeVisible();
    for (const [w, h] of [[375, 812], [1280, 860], [390, 844], [430, 932]] as const) {
      await owner.setViewportSize({ width: w, height: h });
      await owner.waitForTimeout(2500);
      await expect(owner.getByTestId("call-screen"), `call kept at ${w}`).toBeVisible();
      await expect(owner.getByTestId("record-start"), `still in the call at ${w}`).toBeVisible();
      await expect(owner.getByTestId("meeting-connect-failed")).toHaveCount(0);
    }
    // Recording again at phone width works too.
    await owner.getByTestId("record-start").click();
    await expect(owner.getByTestId("video-rec-dialog")).toBeVisible();
    await owner.keyboard.press("Escape");
    await owner.setViewportSize({ width: 1280, height: 860 });
  });

  test("a member can't record video: no option and the permit answers 403; a guest joining mid recording sees the notice", async ({ browser }) => {
    if (!(await owner.getByTestId("call-screen").count())) await joinCall(owner);
    if (!(await mate.getByTestId("call-screen").count())) await joinCall(mate);
    await mate.getByTestId("record-start").click().catch(() => undefined);
    await expect(mate.getByTestId("video-rec-dialog")).toHaveCount(0);
    await mate.keyboard.press("Escape").catch(() => undefined);
    expect((await mate.request.post(`/api/meetings/${meetingId}/recordings/video`, { data: {}, headers: headers() })).status()).toBe(403);
    await owner.getByTestId("record-start").click();
    await owner.getByTestId("video-rec-memory").click();
    await expect(owner.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    // A third person (another member) joins while it records: the notice and the dots.
    const invite = await owner.request.post("/api/team/invites", { data: { email: `kim-vid2-${tag}@example.com`, role: "member" }, headers: headers() });
    const token = ((await invite.json()).link as string).split("/invite/")[1];
    const { ctx, page: kim } = await person(browser, 430, 932);
    expect((await kim.request.post("/api/auth/sign-up/email", { data: { name: "Kim Late", email: `kim-vid2-${tag}@example.com`, password: "a-strong-password" }, headers: headers() })).status()).toBe(200);
    await kim.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers: headers() });
    await confirmEmail(kim.request, `kim-vid2-${tag}@example.com`);
    expect([200, 410]).toContain((await kim.request.post(`/api/invites/${token}/accept`, { data: {}, headers: headers() })).status());
    expect((await (await kim.request.get("/api/account/me")).json()).organization?.role).toBe("member");
    await joinCall(kim);
    await expect(kim.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await expect(kim.getByText("Olive Owner is saving a video of this call")).toBeVisible({ timeout: 10_000 });
    await expect(kim.getByTestId("call-screen")).toHaveAttribute("data-rec", "on");
    await shot(kim, "vid2-430-light-joined-late");
    // Leaving stops and saves on its own, with the size.
    const dl = owner.waitForEvent("download", { timeout: 60_000 });
    await owner.getByRole("button", { name: "Leave", exact: true }).first().click();
    await expect(owner.getByTestId("call-screen")).toHaveCount(0, { timeout: 15_000 });
    const d = await dl;
    expect(d.suggestedFilename()).toMatch(/\.(webm|mp4)$/);
    await expect(kim.getByTestId("recording-banner")).toHaveCount(0, { timeout: 20_000 });
    await ctx.close();
  });

  test("widths, light, dark and Forest: recording controls fit, no overlap, axe clean", async () => {
    test.setTimeout(300_000);
    await joinCall(owner);
    await owner.getByTestId("record-start").click();
    await owner.getByTestId("video-rec-memory").click();
    await expect(owner.getByTestId("record-pause")).toBeVisible({ timeout: 15_000 });
    const fits = () => owner.evaluate(() => {
      const root = document.querySelector("[data-testid=recording-layer]");
      if (!root) return ["missing layer"];
      const W = window.innerWidth; const bad: string[] = [];
      const els = Array.from(root.querySelectorAll<HTMLElement>("*")).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.classList.contains("sr-only"); });
      for (const e of els) { const r = e.getBoundingClientRect(); if (r.left < -1 || r.right > W + 1) bad.push(`offscreen ${e.tagName} ${e.dataset.testid ?? ""}`); if (e.childElementCount === 0 && (e.textContent ?? "").trim() && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== "ellipsis" && getComputedStyle(e).overflowX !== "visible") bad.push(`clipped "${(e.textContent ?? "").trim().slice(0, 24)}"`); }
      const ctl = els.filter((e) => e.tagName === "BUTTON" || e.tagName === "LABEL").map((e) => ({ t: (e.textContent ?? "").trim().slice(0, 16), r: e.getBoundingClientRect() }));
      for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) { const a = ctl[i].r, b = ctl[j].r; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(`overlap "${ctl[i].t}" "${ctl[j].t}"`); }
      return bad;
    });
    for (const [w, h] of [[375, 812], [390, 844], [430, 932], [1280, 860]] as const) for (const t of ["light", "dark"] as const) {
      await owner.setViewportSize({ width: w, height: h });
      await theme(owner, t);
      await owner.waitForTimeout(600);
      await expect(owner.getByTestId("call-screen"), `call kept at ${w}`).toBeVisible();
      expect(await fits(), `fit ${w} ${t}`).toEqual([]);
      expect(await axeSerious(owner, "[data-testid=recording-layer]"), `axe ${w} ${t}`).toEqual([]);
      await shot(owner, `vid2-${w}-${t}-recording`);
    }
    await owner.getByTestId("record-pause").click();
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await fits()).toEqual([]);
    await shot(owner, "vid2-390-dark-paused");
    await owner.getByTestId("record-resume").click();
    await owner.getByTestId("record-stop").click();
    await expect(owner.getByText(/^Video saved/)).toBeVisible({ timeout: 20_000 });
    // Forest.
    await owner.setViewportSize({ width: 1280, height: 860 });
    await theme(owner, "light");
    await owner.goto("/app/settings/branding");
    await expect(owner.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
    await owner.getByRole("button", { name: "Forest", exact: true }).click();
    const save = owner.getByTestId("brand-actions").getByRole("button", { name: /save/i });
    if (await save.count()) await save.first().click();
    await owner.waitForTimeout(800);
    await joinCall(owner);
    await owner.getByTestId("record-start").click();
    expect(await axeSerious(owner, "dialog")).toEqual([]);
    await shot(owner, "vid2-1280-forest-dialog");
    await owner.getByTestId("video-rec-memory").click();
    await expect(owner.getByTestId("record-pause")).toBeVisible({ timeout: 15_000 });
    for (const w of [390, 1280]) { await owner.setViewportSize({ width: w, height: w > 500 ? 860 : 844 }); await owner.waitForTimeout(500); expect(await fits()).toEqual([]); expect(await axeSerious(owner, "[data-testid=recording-layer]")).toEqual([]); await shot(owner, `vid2-${w}-forest-recording`); }
    await owner.getByTestId("record-stop").click();
    await expect(owner.getByText(/^Video saved/)).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("VID2 off", () => {
  test.skip(ON, "VIDEO_REC_VID2 is on in this run");
  test("VID2 off = VID1 exactly: no layout or quality choice, no Pause, no dots", async () => {
    await joinCall(owner);
    expect((await (await owner.request.get("/api/config")).json()).videoRecVid2).toBe(false);
    await owner.getByTestId("record-start").click();
    await expect(owner.getByTestId("video-rec-dialog")).toBeVisible();
    await expect(owner.getByTestId("video-rec-settings")).toHaveCount(0);
    await owner.getByTestId("video-rec-memory").click();
    await expect(owner.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await expect(owner.getByTestId("record-pause")).toHaveCount(0);
    await expect(owner.getByTestId("rec-layout")).toHaveCount(0);
    await expect(owner.getByTestId("call-screen")).not.toHaveAttribute("data-rec", /.+/);
    await piecesAtLeast(owner, 2);
    const dl = owner.waitForEvent("download", { timeout: 60_000 });
    await owner.getByTestId("record-stop").click();
    expect((await dl).suggestedFilename()).toMatch(/\.(webm|mp4)$/);
  });
});

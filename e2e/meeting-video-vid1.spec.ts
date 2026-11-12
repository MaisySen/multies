import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { confirmEmail } from "./support/confirm-email";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, readFileSync, rmSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * VID1 end to end: an owner saves a video of the whole call on their own device. Two people join a real local
 * LiveKit dev server (LIVEKIT_URL=ws://localhost, allowed outside production only) with Chromium's fake camera
 * and microphone. The owner records (to a chosen file, and to memory with a download at Stop), the other person
 * sees the Recording video banner, the saved file has video and sound, nothing is uploaded, and a member gets no
 * video option. With VIDEO_REC_VID1 off the Record control is exactly today's.
 */
const LIVE = /^ws:\/\/(localhost|127\.0\.0\.1)/.test(process.env.LIVEKIT_URL ?? "");
const ON = ["1", "true", "on"].includes(String(process.env.VIDEO_REC_VID1 ?? "").toLowerCase());
const SHOTS = process.env.SHOTS_DIR ?? `${SHOTS_ROOT}/catalogue/vid1/shots`;
test.skip(!LIVE, "needs the local LiveKit dev server (run with LIVEKIT_URL=ws://localhost:<port>)");
test.describe.configure({ mode: "serial" });
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] } });
test.setTimeout(150_000);

let visitor = 0;
const ip = () => `10.181.${test.info().workerIndex % 200}.${++visitor}`;
let ownerCtx: BrowserContext, mateCtx: BrowserContext;
let owner: Page, mate: Page;
let meetingId = "";
let origin = "";
const tag = Math.random().toString(36).slice(2, 8);

async function person(browser: Browser, width: number, height: number) {
  const base = test.info().project.use.baseURL!;
  origin = new URL(base).origin;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width, height }, permissions: ["camera", "microphone"], acceptDownloads: true, reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  return { ctx, page: await ctx.newPage() };
}
const headers = () => ({ origin });

async function axeSerious(page: Page, include?: string) {
  await page.waitForTimeout(400); // let the dialog finish opening
  let b = new AxeBuilder({ page });
  if (include) b = b.include(include);
  const { violations } = await b.analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}
async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
async function theme(page: Page, t: "light" | "dark") {
  await page.evaluate((v) => { localStorage.setItem("multies-theme", v); document.documentElement.dataset.theme = v; }, t);
}
async function joinCall(page: Page) {
  await page.goto(`/app/meetings/${meetingId}?join=1`);
  // The camera and name check, unless this browser already passed it for the call.
  try {
    await expect(page.getByTestId("prejoin-join").or(page.getByTestId("call-screen"))).toBeVisible({ timeout: 30_000 });
  } catch (e) {
    console.log("JOINDEBUG", page.url(), (await page.locator("body").innerText()).slice(0, 600).replace(/\s+/g, " "));
    throw e;
  }
  // The check can join on its own a moment later, so a click that finds nothing is fine.
  if (await page.getByTestId("prejoin-join").isVisible()) await page.getByTestId("prejoin-join").click({ timeout: 5_000 }).catch(() => undefined);
  await expect(page.getByTestId("call-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("record-start")).toBeVisible({ timeout: 30_000 });
}
/** A stand in for the browser's save picker that keeps what is written (the real one is a native dialog). */
const fakePicker = () => {
  const w = window as unknown as { __vid: { name: string; bytes: number; head: number[]; closed: boolean } | null; showSaveFilePicker: unknown };
  w.__vid = null;
  w.showSaveFilePicker = async (o: { suggestedName: string }) => ({
    name: o.suggestedName,
    remove: async () => { w.__vid = null; },
    createWritable: async () => {
      w.__vid = { name: o.suggestedName, bytes: 0, head: [], closed: false };
      return {
        write: async (b: Blob) => { const v = w.__vid!; if (v.head.length < 4) v.head.push(...new Uint8Array(await b.slice(0, 4 - v.head.length).arrayBuffer())); v.bytes += b.size; },
        close: async () => { w.__vid!.closed = true; },
      };
    },
  });
};

test.beforeAll(async ({ browser }) => {
  ({ ctx: ownerCtx, page: owner } = await person(browser, 1280, 860));
  expect((await owner.request.post("/api/auth/sign-up/email", { data: { name: "Olive Owner", email: `olive-vid1-${tag}@example.com`, password: "a-strong-password" }, headers: headers() })).status()).toBe(200);
  await owner.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers: headers() });
  const made = await owner.request.post("/api/meetings", { data: { title: "Weekly sync", startsAt: new Date().toISOString(), durationMin: 30 }, headers: headers() });
  expect(made.status()).toBe(201);
  meetingId = (await made.json()).meeting.id;
  const invite = await owner.request.post("/api/team/invites", { data: { email: `sam-vid1-${tag}@example.com`, role: "member" }, headers: headers() });
  const token = ((await invite.json()).link as string).split("/invite/")[1];
  ({ ctx: mateCtx, page: mate } = await person(browser, 390, 844));
  expect((await mate.request.post("/api/auth/sign-up/email", { data: { name: "Sam Mate", email: `sam-vid1-${tag}@example.com`, password: "a-strong-password" }, headers: headers() })).status()).toBe(200);
  await mate.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers: headers() });
  await confirmEmail(mate.request, `sam-vid1-${tag}@example.com`);
  // Confirming the address can already join the invited workspace (410 then means the invite was used).
  expect([200, 410]).toContain((await mate.request.post(`/api/invites/${token}/accept`, { data: {}, headers: headers() })).status());
  expect((await (await mate.request.get("/api/account/me")).json()).organization?.role).toBe("member");
});
test.afterAll(async () => { await ownerCtx?.close(); await mateCtx?.close(); });

test.describe("flag on", () => {
  test.skip(!ON, "VIDEO_REC_VID1 is off in this run");

  test("owner records to a chosen file: the other person sees the video banner, the file fills, nothing is uploaded", async () => {
    await owner.addInitScript(fakePicker);
    // Every request the owner's page sends while the video records: nothing may carry media (any host).
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
    // A member never gets the video option: Record is today's audio control.
    await expect(mate.getByTestId("record-start")).toBeVisible();
    // The dialog, reached with the keyboard.
    await owner.getByTestId("record-start").focus();
    await owner.keyboard.press("Enter");
    const dialog = owner.getByTestId("video-rec-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("A video of the whole call is saved to this device when you stop. Nothing is uploaded.");
    await expect(owner.getByTestId("video-rec-transcript")).toContainText("The transcript is off.");
    await expect(owner.getByTestId("video-rec-where")).toContainText("Choose where to save the video");
    await expect(owner.getByTestId("video-rec-file")).toBeEnabled();
    expect(await axeSerious(owner, "dialog")).toEqual([]);
    await shot(owner, "vid1-1280-light-dialog");
    await owner.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await owner.getByTestId("record-start").click();
    collecting = true;
    await owner.getByTestId("video-rec-file").click();
    await expect(owner.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await expect(owner.getByTestId("recording-banner")).toContainText("started by you");
    await expect(owner.getByTestId("record-consent")).toContainText("you are saving a video of it on this device");
    // The other side: banner and a one time notice in plain words.
    await expect(mate.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await expect(mate.getByTestId("recording-banner")).toContainText("started by Olive Owner");
    await expect(mate.getByText("Olive Owner is saving a video of this call")).toBeVisible();
    await expect(mate.getByTestId("record-start")).toHaveCount(0);
    await shot(owner, "vid1-1280-light-recording");
    expect(await axeSerious(owner, "[data-testid=recording-layer]")).toEqual([]);
    await theme(mate, "dark");
    await shot(mate, "vid1-390-dark-other-side");
    expect(await axeSerious(mate, "[data-testid=recording-layer]")).toEqual([]);
    await owner.waitForTimeout(4000);
    await expect.poll(() => owner.evaluate(() => (window as unknown as { __vid: { bytes: number } | null }).__vid?.bytes ?? 0), { timeout: 10_000 }).toBeGreaterThan(10_000);
    await owner.getByTestId("record-stop").click();
    await expect(owner.getByText("Video saved")).toBeVisible({ timeout: 15_000 });
    collecting = false;
    const vid = await owner.evaluate(() => (window as unknown as { __vid: { name: string; bytes: number; head: number[]; closed: boolean } }).__vid);
    expect(vid.closed).toBe(true);
    expect(vid.name).toMatch(/^Meeting Weekly sync \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}\.\d{2}\.webm$/);
    expect(vid.name).not.toMatch(/[-\u2013\u2014:]/);
    expect(vid.head).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // a webm file
    await expect(mate.getByTestId("recording-banner")).toHaveCount(0, { timeout: 10_000 });
    expect(uploads).toEqual([]);
  });

  test("phone and desktop widths, light and dark: dialog, banner, Stop and footer fit with no overlap and pass contrast", async () => {
    test.setTimeout(330_000);
    if (!(await owner.getByTestId("call-screen").count())) await joinCall(owner);
    await expect(owner.getByTestId("record-start")).toBeVisible({ timeout: 30_000 });
    const DES = ["1", "true", "on"].includes(String(process.env.DESIGN_DES1 ?? "").toLowerCase()) ? "des1" : "plain";
    const fits = (sel: string) => owner.evaluate((s) => {
      const root = document.querySelector(s);
      if (!root) return [`missing ${s}`];
      const bad: string[] = [];
      const W = window.innerWidth;
      const els = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))] as HTMLElement[];
      const shown = els.filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; });
      for (const e of shown) {
        const r = e.getBoundingClientRect();
        if (r.left < -1 || r.right > W + 1) bad.push(`offscreen ${e.tagName}.${(e.getAttribute("data-testid") ?? "")} ${Math.round(r.left)}..${Math.round(r.right)}`);
        const cs = getComputedStyle(e);
        if (e.childElementCount === 0 && (e.textContent ?? "").trim() && e.scrollWidth > e.clientWidth + 1 && cs.textOverflow !== "ellipsis" && cs.overflowX !== "visible") bad.push(`clipped ${e.tagName} "${(e.textContent ?? "").trim().slice(0, 30)}"`);
      }
      const btns = shown.filter((e) => e.tagName === "BUTTON" || e.tagName === "A").map((e) => ({ t: (e.textContent ?? "").trim().slice(0, 20), r: e.getBoundingClientRect() }));
      for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) {
        const a = btns[i].r, b = btns[j].r;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(`overlap "${btns[i].t}" "${btns[j].t}"`);
      }
      return bad;
    }, sel);
    const widths: [number, number][] = [[375, 812], [390, 844], [430, 932], [1280, 860]];
    for (const [w, h] of widths) for (const t of ["light", "dark"] as const) {
      await owner.setViewportSize({ width: w, height: h });
      await theme(owner, t);
      await owner.getByTestId("record-start").click();
      await expect(owner.getByTestId("video-rec-dialog")).toBeVisible();
      expect(await axeSerious(owner, "dialog"), `dialog ${w} ${t}`).toEqual([]);
      expect(await fits("dialog[open]"), `dialog fit ${w} ${t}`).toEqual([]);
      await shot(owner, `vid1-${DES}-${w}-${t}-dialog`);
      await owner.keyboard.press("Escape");
      await expect(owner.getByTestId("video-rec-dialog")).toHaveCount(0);
    }
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.getByTestId("record-start").click();
    await owner.getByTestId("video-rec-memory").click();
    await expect(owner.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    for (const [w, h] of widths) for (const t of ["light", "dark"] as const) {
      await owner.setViewportSize({ width: w, height: h });
      await theme(owner, t);
      await owner.waitForTimeout(300);
      expect(await axeSerious(owner, "[data-testid=recording-layer]"), `recording ${w} ${t}`).toEqual([]);
      expect(await fits("[data-testid=recording-layer]"), `recording fit ${w} ${t}`).toEqual([]);
      const stopCss = await owner.getByTestId("record-stop").evaluate((e) => { const c = getComputedStyle(e); return `${c.backgroundColor} ${c.color}`; });
      expect(stopCss, `solid Stop ${w} ${t}`).toBe("rgb(215, 0, 21) rgb(255, 255, 255)");
      expect(await owner.getByTestId("call-tab-so-far").evaluate((e) => e.getBoundingClientRect().height), `So far one line ${w}`).toBeLessThanOrEqual(48);
      await shot(owner, `vid1-${DES}-${w}-${t}-recording`);
    }
    const download = owner.waitForEvent("download", { timeout: 20_000 });
    await owner.getByTestId("record-stop").click();
    const d = await download;
    const sp = await d.path();
    expect(sp && statSync(sp).size, "the sweep recording has bytes").toBeGreaterThan(20_000);
    await d.delete();
    await expect(owner.getByTestId("video-save-again")).toBeVisible();
    for (const [w, h] of widths) {
      await owner.setViewportSize({ width: w, height: h });
      expect(await fits("[data-testid=recording-layer]"), `saved fit ${w}`).toEqual([]);
    }
    await theme(owner, "light");
    await owner.setViewportSize({ width: 1280, height: 860 });
  });

  test("owner records with save at the end: Stop downloads one playable webm with video and sound", async () => {
    await owner.setViewportSize({ width: 390, height: 844 });
    await theme(owner, "dark");
    await owner.getByTestId("record-start").click();
    await expect(owner.getByTestId("video-rec-dialog")).toBeVisible();
    expect(await axeSerious(owner, "dialog")).toEqual([]);
    await shot(owner, "vid1-390-dark-dialog");
    await owner.getByTestId("video-rec-memory").click();
    await expect(owner.getByTestId("recording-banner")).toContainText("Recording video", { timeout: 15_000 });
    await shot(owner, "vid1-390-dark-recording");
    expect(await axeSerious(owner, "[data-testid=recording-layer]")).toEqual([]);
    // Leaving or reloading asks first while a video records.
    const asked = await owner.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    expect(asked).toBe(true);
    await owner.waitForTimeout(5000);
    const download = owner.waitForEvent("download", { timeout: 20_000 });
    await owner.getByTestId("record-stop").click();
    const d = await download;
    expect(d.suggestedFilename()).toMatch(/^Meeting Weekly sync .+\.webm$/);
    const path = `/tmp/vid1-e2e-${tag}.webm`;
    await d.saveAs(path);
    expect(statSync(path).size).toBeGreaterThan(20_000);
    expect([...readFileSync(path).subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    try {
      const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", path], { encoding: "utf8", timeout: 30_000 });
      expect(probe).toMatch(/vp[89],video/);
      expect(probe).toMatch(/opus,audio/);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    rmSync(path, { force: true });
    await expect(owner.getByTestId("video-save-again")).toBeVisible();
    await shot(owner, "vid1-390-dark-saved");
    expect(await axeSerious(owner, "[data-testid=recording-layer]")).toEqual([]);
    // Choosing Stay kept the call: still in it after the leave warning above.
    await expect(owner.getByTestId("call-screen")).toBeVisible();
    const asked2 = await owner.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    expect(asked2).toBe(false);
    await theme(owner, "light");
    await owner.setViewportSize({ width: 1280, height: 860 });
  });

  test("a member cannot start a video recording: no video option and the permit is refused", async () => {
    await joinCall(mate);
    await mate.getByTestId("record-start").click();
    await expect(mate.getByTestId("video-rec-dialog")).toHaveCount(0);
    await expect(mate.getByTestId("record-setup")).toBeVisible();
    await mate.keyboard.press("Escape");
    const r = await mate.request.post(`/api/meetings/${meetingId}/recordings/video`, { data: {}, headers: headers() });
    expect(r.status()).toBe(403);
  });

  test("the page security policy is unchanged on the call page", async () => {
    const res = await owner.request.get(`/app/meetings/${meetingId}`);
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).not.toMatch(/(^|[\s;])'unsafe-eval'/);
    if (process.env.MAIN_CSP_FILE && existsSync(process.env.MAIN_CSP_FILE)) expect(csp).toBe(readFileSync(process.env.MAIN_CSP_FILE, "utf8").trim());
  });

  test("Forest at 1280: dialog and recording", async () => {
    await owner.goto("/app/settings/branding");
    await expect(owner.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
    await owner.getByRole("button", { name: "Forest", exact: true }).click();
    const save = owner.getByTestId("brand-actions").getByRole("button", { name: /save/i });
    if (await save.count()) await save.first().click();
    await owner.waitForTimeout(800);
    await joinCall(owner);
    await owner.getByTestId("record-start").click();
    await expect(owner.getByTestId("video-rec-dialog")).toBeVisible();
    expect(await axeSerious(owner, "dialog")).toEqual([]);
    await shot(owner, "vid1-1280-forest-dialog");
    await owner.keyboard.press("Escape");
  });
});

test.describe("flag off", () => {
  test.skip(ON, "VIDEO_REC_VID1 is on in this run");
  test("flag off = today: Record is the audio control and the video path is 404", async () => {
    await joinCall(owner);
    await owner.getByTestId("record-start").click();
    await expect(owner.getByTestId("video-rec-dialog")).toHaveCount(0);
    await expect(owner.getByTestId("record-setup")).toBeVisible();
    expect((await owner.request.post(`/api/meetings/${meetingId}/recordings/video`, { data: {}, headers: headers() })).status()).toBe(404);
    expect((await (await owner.request.get("/api/config")).json()).videoRecVid1).toBe(false);
  });
});

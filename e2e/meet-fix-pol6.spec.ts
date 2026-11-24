import { test, expect, type Page, type Browser } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * MEET fixes (POL6, 12 Nov 2026) end to end:
 * - the call stays when the person opens another page of the app: it moves to the floating window, Expand brings
 *   it back, and the meeting is joined once (no second room token),
 * - the floating window fits a 375 px phone screen,
 * - one waiting guest shows one Admit (the toast only tells), even after the guest reloads and asks again,
 * - pre-join says which workspace the person joins from.
 * Video keys are not set locally, so the room token is stubbed in the browser; the stub room's socket is held open
 * and silent, so the call stays "connecting" while the test moves around the app.
 */
test.use({
  permissions: ["camera", "microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  viewport: { width: 1440, height: 900 },
});
test.describe.configure({ mode: "serial" });

const SHOTS = `${SHOTS_ROOT}/multies-pol6-meet`;
let visitor = 0;
const ip = () => `10.133.${test.info().workerIndex % 200}.${++visitor}`;

async function signIn(page: Page, name = "Ada Owner") {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return headers;
}

/** Video on, a stub token, and a room socket that stays open and quiet. Counts the joins. */
async function fakeVideo(page: Page, meetingId: string) {
  const joins = { n: 0 };
  await page.route(new RegExp(`/api/meetings/${meetingId}$`), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.meeting.videoEnabled = true;
    await route.fulfill({ response: res, json: body });
  });
  await page.route(new RegExp(`/api/meetings/${meetingId}/join$`), (route) => { joins.n++; return route.fulfill({ json: { url: "wss://127.0.0.1:9", token: "stub", room: "stub", meeting: { id: meetingId } } }); });
  await page.routeWebSocket(/127\.0\.0\.1:9/, () => { /* held open, says nothing */ });
  return joins;
}

/** A link click inside the app (no page load), as the sidebar does. */
async function openInApp(page: Page, path: string) {
  await page.evaluate((p) => { window.history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
}

async function joinFromPage(page: Page, meetingId: string) {
  await page.goto(`/app/meetings/${meetingId}`);
  await page.getByTestId("join-meeting").click();
  await expect(page.getByTestId("prejoin")).toBeVisible();
  await page.getByTestId("prejoin-join").click();
  await expect(page.getByTestId("meeting-room")).toBeVisible();
}

test("the call moves to the floating window on another page and back with Expand, joined once", async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, "Uses the local stubs for video rooms.");
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  const headers = await signIn(page);
  const m = (await (await page.request.post("/api/meetings", { data: { title: "Design review" }, headers })).json()).meeting;
  const joins = await fakeVideo(page, m.id);

  await page.goto(`/app/meetings/${m.id}`);
  await page.getByTestId("join-meeting").click();
  // Pre-join names the workspace the person joins from.
  await expect(page.getByTestId("prejoin-joining-as")).toContainText("Ada Owner");
  await expect(page.getByTestId("prejoin-joining-as")).toContainText(" in ");
  await page.getByTestId("prejoin-join").click();
  await expect(page.getByTestId("meeting-room")).toBeVisible();
  expect(joins.n).toBe(1);

  // Another page of the app: the call is in the floating window, not gone.
  await openInApp(page, "/app/tasks");
  await expect(page.getByTestId("meeting-room")).toHaveCount(0);
  const dock = page.getByTestId("call-dock");
  await expect(dock).toBeVisible();
  await expect(dock).toHaveAttribute("data-meeting-id", m.id);
  await expect(dock.getByTestId("call-dock-leave")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dock-after-leaving-page.png` });

  // And another one: still there.
  await openInApp(page, "/app/chat");
  await expect(dock).toBeVisible();

  // Expand: back on the meeting page, the same call (no second join).
  await dock.getByTestId("call-dock-expand").click();
  await expect(page).toHaveURL(new RegExp(`/app/meetings/${m.id}$`));
  await expect(page.getByTestId("meeting-room")).toBeVisible();
  await expect(page.getByTestId("call-dock")).toHaveCount(0);
  expect(joins.n).toBe(1);

  // Leave ends it everywhere.
  await page.getByTestId("meeting-leave").click();
  await expect(page.getByTestId("meeting-room")).toHaveCount(0);
  await openInApp(page, "/app/tasks");
  await expect(page.getByTestId("call-dock")).toHaveCount(0);
});

test("on a 375 px phone the floating window stays inside the screen", async ({ browser }) => {
  test.skip(!!process.env.E2E_BASE_URL, "Uses the local stubs for video rooms.");
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 375, height: 667 }, baseURL: test.info().project.use.baseURL, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const headers = await signIn(page);
  const m = (await (await page.request.post("/api/meetings", { data: { title: "Phone check" }, headers })).json()).meeting;
  await fakeVideo(page, m.id);
  await joinFromPage(page, m.id);
  await openInApp(page, "/app/tasks");
  const dock = page.getByTestId("call-dock");
  await expect(dock).toBeVisible();
  const box = (await dock.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await page.screenshot({ path: `${SHOTS}/dock-phone-375.png` });
  await ctx.close();
});

/** A guest in their own browser context, with video shown as on and the token stubbed after admission. */
async function guestPage(browser: Browser, token: string) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1440, height: 900 }, baseURL: test.info().project.use.baseURL, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await page.route(new RegExp(`/api/public/meetings/${token}$`), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.meeting.videoEnabled = true;
    await route.fulfill({ response: res, json: body });
  });
  await page.route(new RegExp(`/api/public/meetings/${token}/join$`), async (route) => {
    const res = await route.fetch();
    if (res.status() !== 200 && res.status() !== 503) return route.fulfill({ response: res });
    await route.fulfill({ json: { url: "wss://127.0.0.1:9", token: "stub", room: "stub", meeting: { id: "guest" } } });
  });
  await page.goto(`/m/${token}`);
  return { ctx, page };
}

async function askToJoin(page: Page, name: string) {
  await expect(page.getByTestId("prejoin")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("prejoin-name").fill(name);
  await page.getByTestId("prejoin-join").click();
  await expect(page.getByTestId("lobby-state")).toHaveAttribute("data-state", "pending", { timeout: 15_000 });
}

test("one waiting guest shows one Admit, even after the guest reloads and asks again; one click lets them in", async ({ page, browser }) => {
  test.skip(!!process.env.E2E_BASE_URL, "Uses the local stubs for video rooms.");
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const headers = await signIn(page);
  const m = (await (await page.request.post("/api/meetings", { data: { title: "Design review" }, headers })).json()).meeting;
  const token = (m.guestUrl as string).split("/m/")[1];
  await fakeVideo(page, m.id);
  await joinFromPage(page, m.id);

  const g = await guestPage(browser, token);
  await askToJoin(g.page, "Grace Hopper");
  // The guest reloads and asks again: still one request.
  await g.page.reload();
  await askToJoin(g.page, "Grace Hopper");

  const row = page.getByTestId("lobby-row").filter({ hasText: "Grace Hopper" });
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId("lobby-admit")).toHaveCount(1);
  // The toast tells, it has no Admit of its own.
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Grace Hopper" }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-sonner-toast] button", { hasText: "Admit" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/one-admit.png` });

  await row.getByTestId("lobby-admit").click();
  await expect(page.getByTestId("lobby-row")).toHaveCount(0, { timeout: 15_000 });
  await expect(g.page.getByTestId("meeting-room")).toBeVisible({ timeout: 20_000 });
  await g.ctx.close();
});

const LIVE = /^ws:\/\/(localhost|127\.0\.0\.1)/.test(process.env.LIVEKIT_URL ?? "");

test("live: a real two person call carries on while the host moves around the app (local LiveKit dev server)", async ({ page, browser }) => {
  test.skip(!LIVE || !!process.env.E2E_BASE_URL, "needs the local LiveKit dev server (LIVEKIT_URL=ws://localhost:<port>)");
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const headers = await signIn(page);
  const m = (await (await page.request.post("/api/meetings", { data: { title: "Live check" }, headers })).json()).meeting;
  expect((await page.request.patch(`/api/meeting-lobby/${m.id}/settings`, { data: { guestsWait: false }, headers })).status()).toBe(200);
  const token = (m.guestUrl as string).split("/m/")[1];
  let joins = 0;
  page.on("request", (r) => { if (r.method() === "POST" && new RegExp(`/api/meetings/${m.id}/join$`).test(r.url())) joins++; });
  await joinFromPage(page, m.id);
  await expect(page.locator("[data-call-state=connected]")).toBeVisible({ timeout: 30_000 });

  // A guest joins from the link in their own browser.
  const gctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1280, height: 800 }, baseURL: test.info().project.use.baseURL, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const guest = await gctx.newPage();
  await guest.goto(`/m/${token}`);
  await expect(guest.getByTestId("prejoin")).toBeVisible({ timeout: 20_000 });
  await guest.getByTestId("prejoin-name").fill("Grace Hopper");
  await guest.getByTestId("prejoin-join").click();
  await expect(guest.locator(".lk-participant-tile")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator(".lk-participant-tile")).toHaveCount(2, { timeout: 30_000 });

  // The host opens other pages: the call moves to the floating window and stays connected.
  await openInApp(page, "/app/tasks");
  const dock = page.getByTestId("call-dock");
  await expect(dock).toBeVisible();
  await expect(dock.locator("[data-call-state=connected]")).toBeVisible();
  await expect(dock.locator(".lk-participant-tile")).toHaveCount(2, { timeout: 15_000 });
  await openInApp(page, "/app/chat");
  await page.waitForTimeout(4000);
  // The guest never saw the host leave.
  await expect(guest.locator(".lk-participant-tile")).toHaveCount(2);
  await page.screenshot({ path: `${SHOTS}/live-dock.png` });

  // Back to the page with Expand: the same connection, no second join.
  await dock.getByTestId("call-dock-expand").click();
  await expect(page.locator("[data-testid=meeting-room] [data-call-state=connected]")).toBeVisible();
  await expect(page.locator(".lk-participant-tile")).toHaveCount(2, { timeout: 15_000 });
  expect(joins).toBe(1);

  // The meeting is still open (this local server reads rooms through its test hook, so who is in is not asked here).
  expect((await (await page.request.get(`/api/meetings/${m.id}`, { headers })).json()).meeting.status).toBe("scheduled");

  // The host leaves; the guest is still in, so the meeting stays open.
  await page.getByTestId("meeting-leave").click();
  await expect(guest.locator(".lk-participant-tile")).toHaveCount(1, { timeout: 30_000 });
  expect((await (await page.request.get(`/api/meetings/${m.id}`, { headers })).json()).meeting.status).toBe("scheduled");
  await gctx.close();
});

import { test, expect, type Page, type Browser } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 32: the meeting waiting room end to end. A guest opens the meeting link, gives a name on the
 * pre-join screen, asks to join and waits; the host, in the call, sees the request and admits it;
 * a second guest is denied and sees the polite message. Video keys are not set locally, so the
 * meeting reads as video on and room tokens are stubbed in the browser only (as in meet-r31).
 */
test.use({
  permissions: ["camera", "microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  viewport: { width: 1440, height: 900 },
});
test.describe.configure({ mode: "serial" });

const SHOTS = `${SHOTS_ROOT}/multies-r32`;
let visitor = 0;
const ip = () => `10.132.${test.info().workerIndex % 200}.${++visitor}`;

async function signIn(page: Page) {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return headers;
}

async function hostVideo(page: Page, meetingId: string) {
  await page.route(new RegExp(`/api/meetings/${meetingId}$`), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.meeting.videoEnabled = true;
    await route.fulfill({ response: res, json: body });
  });
  await page.route(new RegExp(`/api/meetings/${meetingId}/join$`), (route) => route.fulfill({ json: { url: "wss://127.0.0.1:9", token: "stub", room: "stub", meeting: { id: meetingId } } }));
}

/** A guest in their own browser context (no cookies), with video shown as on and the room token stubbed after admission. */
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
    // The real server checks the lobby first; only a request it lets through gets the stub token.
    const res = await route.fetch();
    if (res.status() !== 200 && res.status() !== 503) return route.fulfill({ response: res });
    await route.fulfill({ json: { url: "wss://127.0.0.1:9", token: "stub", room: "stub", meeting: { id: "guest" } } });
  });
  await page.goto(`/m/${token}`);
  return { ctx, page };
}

async function askToJoin(page: Page, name: string) {
  await expect(page.getByTestId("prejoin")).toBeVisible({ timeout: 20_000 });
  const field = page.getByTestId("prejoin-name"); // guests: "Your name", required, remembered
  await field.fill(name);
  await page.getByTestId("prejoin-join").click();
  await expect(page.getByTestId("lobby-state")).toHaveAttribute("data-state", "pending", { timeout: 15_000 });
}

test("a guest names themself, waits in the lobby, and the host admits; a second guest is denied", async ({ page, browser }) => {
  test.skip(!!process.env.E2E_BASE_URL, "Uses the local stubs for video rooms.");
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const headers = await signIn(page);
  const m = (await (await page.request.post("/api/meetings", { data: { title: "Design review" }, headers })).json()).meeting;
  expect(m.guestsWait).toBe(true);
  const token = (m.guestUrl as string).split("/m/")[1];

  // Guest one asks with a name.
  const g1 = await guestPage(browser, token);
  await askToJoin(g1.page, "Grace Hopper");
  await g1.page.screenshot({ path: `${SHOTS}/meet-prejoin-guest.png` });

  // The host joins the call and sees the request.
  await hostVideo(page, m.id);
  await page.goto(`/app/meetings/${m.id}`);
  await page.getByTestId("join-meeting").click();
  await expect(page.getByTestId("prejoin")).toBeVisible();
  await page.getByTestId("prejoin-join").click();
  await expect(page.getByTestId("meeting-room")).toBeVisible();
  const row = page.getByTestId("lobby-row").filter({ hasText: "Grace Hopper" });
  await expect(row).toBeVisible({ timeout: 20_000 });

  // Guest two asks too; the host now sees both, and Admit all appears.
  const g2 = await guestPage(browser, token);
  await askToJoin(g2.page, "Alan Turing");
  await expect(page.getByTestId("lobby-row")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId("lobby-admit-all")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/meet-lobby-host.png` });

  // Deny the second, admit the first.
  await page.getByTestId("lobby-row").filter({ hasText: "Alan Turing" }).getByTestId("lobby-deny").click();
  await row.getByTestId("lobby-admit").click();
  await expect(page.getByTestId("lobby-row")).toHaveCount(0, { timeout: 15_000 });

  await expect(g1.page.getByTestId("meeting-room")).toBeVisible({ timeout: 20_000 });
  await expect(g2.page.getByTestId("lobby-state")).toHaveAttribute("data-state", "denied", { timeout: 20_000 });
  await g1.ctx.close();
  await g2.ctx.close();
});

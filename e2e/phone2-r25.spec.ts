import { test, expect, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 25 wave 2 phone pass at 390 x 844 on a touch screen: chat message actions sit behind one
 * More button or a long press (a bottom sheet) so message text runs the full width, the mail star is
 * a visible 40 px target, and the nav drawer, compose, task panel, a meeting, the docs toolbar,
 * Settings tabs, the landing page and pricing fit with no sideways scroll. Any page error fails.
 */
test.describe.configure({ mode: "serial" });
const SHOTS = `${SHOTS_ROOT}/multies-r25`;
let ctx: BrowserContext, page: Page;
const errors: string[] = [];
let visitor = 0;
const ip = () => `10.126.${test.info().workerIndex % 200}.${++visitor}`;

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const base = test.info().project.use.baseURL!;
  ctx = await browser.newContext({
    baseURL: base, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    permissions: ["clipboard-read", "clipboard-write"],
    extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() },
  });
  page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
});
test.afterAll(async () => { await ctx?.close(); });
test.afterEach(() => { expect(errors, errors.join("\n")).toEqual([]); });

/**
 * R42: wait for a real ready signal, not network idle. The mail view keeps one live mail heartbeat open (a long poll
 * of up to 25 s, src/web/lib/live-mail.ts), so the network is never idle there and the old wait ran into the test
 * timeout. Ready means the page has loaded, no skeleton is left and layout has had two frames to settle.
 */
async function ready() {
  await page.waitForLoadState("load");
  await expect(page.locator(".skeleton")).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function noSidewaysScroll(label: string) {
  await ready();
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `${label}: page is ${m.sw} px wide on a ${m.iw} px screen`).toBeLessThanOrEqual(m.iw);
  expect(m.bw, `${label}: body is ${m.bw} px wide`).toBeLessThanOrEqual(m.iw);
  expect(m.iw).toBe(390);
}
async function atLeast40(label: string, box: { width: number; height: number } | null) {
  expect(box, `${label} is on screen`).not.toBeNull();
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(40);
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(40);
}
/** Polled: under a loaded test run the sheet or toolbar can still be laying out when first measured. */
async function atLeast40Settled(label: string, l: import("@playwright/test").Locator) {
  await expect.poll(async () => { const b = await l.boundingBox(); return b ? Math.min(Math.round(b.width), Math.round(b.height)) : 0; }, { message: `${label} is at least 40 px`, timeout: 10_000 }).toBeGreaterThanOrEqual(40);
}
async function fullBox(l: import("@playwright/test").Locator) {
  const b = await l.boundingBox();
  return b && { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}
/** A real long press: a touch held for 700 ms, through the browser's own touch input. */
async function longPress(cdp: CDPSession, x: number, y: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("chat: one More button or a long press opens the message actions as a sheet, and text runs the full width", async () => {
  await page.goto("/app/chat");
  const msg = page.getByTestId("chat-message").first();
  await expect(msg).toBeVisible({ timeout: 15_000 });
  // No inline icon row beside the message on a phone.
  await expect(msg.getByRole("button", { name: "Add reaction" })).toHaveCount(0);
  await expect(msg.getByRole("button", { name: "Reply in thread" })).toHaveCount(0);
  await expect(msg.getByRole("button", { name: "More message actions" })).toHaveCount(0);
  const more = msg.getByTestId("message-more");
  await atLeast40("More button", await more.boundingBox());
  // The text column takes the width the icons used to (about 200 px before, 314 px now).
  const textWidth = await msg.locator("p").first().evaluate((el) => el.getBoundingClientRect().width);
  expect(textWidth).toBeGreaterThanOrEqual(300);
  await noSidewaysScroll("chat");

  // The More button opens the sheet with every action this person may take.
  await more.tap();
  const sheet = page.getByRole("dialog", { name: "Message actions" });
  await expect(sheet).toBeVisible();
  for (const name of ["Reply in thread", "Copy text", "Send to triage", "Make task", "Pin to channel"]) await expect(sheet.getByRole("button", { name, exact: true })).toBeVisible();
  // The demo person is the workspace owner, so Delete is offered on anyone's message.
  await expect(sheet.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  const sheetBox = (await sheet.boundingBox())!;
  expect(sheetBox.width).toBe(390);
  expect(Math.round(sheetBox.y + sheetBox.height)).toBeGreaterThanOrEqual(840); // a bottom sheet
  for (const b of await sheet.getByRole("button").all()) {
    const box = await b.boundingBox();
    if (box) expect(box.height, `${await b.getAttribute("aria-label") ?? await b.textContent()} height`).toBeGreaterThanOrEqual(40);
  }
  await noSidewaysScroll("chat sheet");
  await page.screenshot({ path: `${SHOTS}/phone-chat-actions.png` });

  // Copy puts the message text, with mentions and links as words, on the clipboard.
  await sheet.getByRole("button", { name: "Copy text", exact: true }).tap();
  await expect(sheet).toBeHidden();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.length).toBeGreaterThan(10);
  expect(copied).not.toContain("<#");

  // A reaction from the sheet lands on the message.
  await more.tap();
  await sheet.getByRole("button", { name: "React with \u{1F389}" }).tap();
  await expect(sheet).toBeHidden();
  await expect(msg.getByRole("button", { name: /\u{1F389}/u })).toBeVisible();

  // A long press on the message opens the same sheet; a short tap does not.
  const cdp = await ctx.newCDPSession(page);
  // (On the author's name: the text itself can hold a task link that a tap would follow.)
  const name = msg.locator("span.font-semibold").first();
  await name.tap();
  await page.waitForTimeout(700);
  await expect(sheet).toBeHidden();
  const box = (await name.boundingBox())!;
  await longPress(cdp, box.x + box.width / 2, box.y + box.height / 2);
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Reply in thread", exact: true }).tap();
  await expect(page).toHaveURL(/thread=/);
  await cdp.detach();
});

test("chat on a desktop keeps its inline action row and has no More sheet button", async ({ browser }) => {
  const desk = await browser.newContext({ baseURL: test.info().project.use.baseURL!, viewport: { width: 1280, height: 800 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const p = await desk.newPage();
  p.on("pageerror", (e) => errors.push(`desktop ${p.url()}: ${e.message}`));
  await p.goto("/login");
  await p.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(p).toHaveURL(/\/app/, { timeout: 30_000 });
  await p.goto("/app/chat");
  const msg = p.getByTestId("chat-message").first();
  await expect(msg).toBeVisible({ timeout: 15_000 });
  await msg.hover();
  await expect(msg.getByRole("button", { name: "Add reaction" })).toBeVisible();
  await expect(msg.getByRole("button", { name: "Reply in thread" })).toBeVisible();
  await expect(msg.getByRole("button", { name: "More message actions" })).toBeVisible();
  await expect(msg.getByTestId("message-more")).toHaveCount(0);
  await desk.close();
});

test("mail: the star shows on touch and is a 40 px target", async () => {
  await page.goto("/app/mail");
  const star = page.getByTestId("mail-star").first();
  await expect(star).toBeVisible({ timeout: 15_000 });
  expect(Number(await star.evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
  await atLeast40("star", await star.boundingBox());
  const was = await star.getAttribute("aria-pressed");
  await star.tap();
  await expect(star).toHaveAttribute("aria-pressed", was === "true" ? "false" : "true");
  await star.tap();
  await expect(star).toHaveAttribute("aria-pressed", was ?? "false");
  await atLeast40("Compose", await page.getByRole("button", { name: "Compose" }).boundingBox());
  await noSidewaysScroll("mail");
});

test("walk: nav drawer, compose, task panel, meeting, docs toolbar and Settings tabs fit a 390 px phone", async () => {
  // The nav drawer opens and closes.
  await page.goto("/app/my-work");
  // R46 mobile: on a phone the menu opens from the More tab of the tab bar.
  await page.getByTestId("tab-more").tap();
  const close = page.getByRole("button", { name: "Close navigation" });
  await expect(close).toBeVisible();
  await noSidewaysScroll("nav open");
  await close.tap();
  await expect(close).toBeHidden();

  // Compose is a full screen sheet.
  await page.goto("/app/mail");
  await page.getByRole("button", { name: "Compose" }).tap();
  const compose = page.getByRole("dialog", { name: "New message" });
  await expect(compose.getByLabel("Subject")).toBeVisible();
  // (Polled: the sheet pops in with a short scale animation.)
  await expect.poll(() => fullBox(compose)).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  // Every control in the compose sheet is on the screen (the footer used to push Discard off it).
  for (const name of ["Send", "Discard", "Close and save draft"]) {
    const b = (await compose.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(b.x, `${name} left`).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, `${name} right`).toBeLessThanOrEqual(390);
  }
  await atLeast40Settled("Discard", compose.getByRole("button", { name: "Discard" }));
  await atLeast40Settled("Close and save draft", compose.getByRole("button", { name: "Close and save draft" }));
  const offscreen = await compose.evaluate((el) => [...el.querySelectorAll("button, select, input, textarea")].filter((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && (r.right > 391 || r.left < -1); }).map((c) => c.getAttribute("aria-label") ?? c.textContent));
  expect(offscreen).toEqual([]);
  await noSidewaysScroll("compose");
  await page.screenshot({ path: `${SHOTS}/phone-compose.png` });

  // The task panel is a full screen sheet.
  const tasks = (await (await page.request.get("/api/tasks")).json()).tasks as { id: string }[];
  await page.goto(`/app/tasks?view=list&task=${tasks[0].id}`);
  const panel = page.getByRole("dialog", { name: "Task" });
  await expect(panel).toBeVisible();
  await expect.poll(() => fullBox(panel)).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  await noSidewaysScroll("task panel");

  // A meeting page.
  await page.goto("/app/meetings");
  await expect(page.locator("main").getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
  const meetings = (await (await page.request.get("/api/meetings")).json()).meetings as { id: string }[];
  expect(meetings.length).toBeGreaterThan(0);
  await page.goto(`/app/meetings/${meetings[0].id}`);
  await expect(page.locator("main").getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
  await noSidewaysScroll("meeting");

  // The docs editor toolbar wraps inside the screen, with 40 px buttons, and the link picker fits.
  const docs = (await (await page.request.get("/api/docs")).json()).docs as { id: string }[];
  await page.goto(`/app/docs/${docs[0].id}`);
  const bar = page.getByRole("toolbar", { name: "Formatting" });
  await expect(bar).toBeVisible({ timeout: 15_000 });
  const barBox = (await bar.boundingBox())!;
  expect(barBox.x).toBeGreaterThanOrEqual(0);
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(390);
  expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const b of await bar.getByRole("button").all()) await atLeast40Settled(`toolbar ${await b.getAttribute("aria-label")}`, b);
  await atLeast40Settled("Delete doc", page.getByRole("button", { name: "Delete doc" }));
  await bar.getByRole("button", { name: "Link a page or task" }).tap();
  await noSidewaysScroll("docs link picker");
  await page.keyboard.press("Escape");
  await noSidewaysScroll("docs");

  // R38: on a phone, Settings is a grouped list hub (no sideways tab row); every pane is reachable and has a back row.
  await page.goto("/app/settings");
  const hub = page.getByTestId("settings-hub");
  await expect(hub).toBeVisible({ timeout: 15_000 });
  const last = hub.getByRole("link").last();
  await last.scrollIntoViewIfNeeded();
  const lb = (await last.boundingBox())!;
  expect(lb.x + lb.width).toBeLessThanOrEqual(390);
  await last.click();
  await expect(page.getByTestId("settings-back")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("settings-back").click();
  await expect(hub).toBeVisible({ timeout: 15_000 });
  await noSidewaysScroll("settings");
});

test("landing and pricing fit a 390 px phone", async () => {
  for (const path of ["/", "/pricing"]) {
    await page.goto(path);
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    await noSidewaysScroll(path);
    const cookie = page.getByRole("button", { name: "Close cookie notice" });
    if (await cookie.isVisible()) await atLeast40("cookie notice close", await cookie.boundingBox());
  }
});

import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";
import { shieldAnswers } from "./support/shield";

/**
 * R92 Booking plus (BOOKING_PLUS=true, SHIELD_DIFFICULTY low in the e2e server). Flows: resources added by an admin and
 * booked from the day grid, approvals, a member who cannot add resources; a time poll answered logged out and the winner
 * picked; a free event with a QR ticket, a waitlist when full, and door check in by code; the spam shield refusing a
 * form with no answer and passing the real booking page. SHOTS_DIR writes shots at 1280 and 390, light, dark and Forest,
 * and runs axe (serious or critical fails).
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.192.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function axe(page: Page, label: string) {
  await page.waitForTimeout(400);
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string, full = false) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: full });
}
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
async function person(browser: Browser, email: string, name: string) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 860 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
}
async function anon(browser: Browser, w = 390) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: w, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  return ctx.newPage();
}
/** Tomorrow (or the next weekday) in the browser's zone as yyyy-mm-dd plus an ISO time at hh:00 local. */
function nextWeekday(hour: number, plusDays = 1) {
  const d = new Date();
  d.setDate(d.getDate() + plusDays);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

test("resources: an admin adds a room, books it from the grid, and sees it in My bookings; approval goes to admins", async ({ page }) => {
  test.setTimeout(120_000);
  await demo(page);
  await page.goto("/app/scheduling?tab=resources");
  const tab = page.getByTestId("resources-tab");
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Add resource" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Add resource" });
  await dlg.getByLabel("Name").fill("Harbour room");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toBeHidden();
  // Book the next open weekday from the grid at 1280.
  const day = nextWeekday(10);
  await page.getByLabel("Day", { exact: true }).first().fill(ymd(day));
  const cell = page.getByRole("button", { name: /^Book Harbour room at / }).first();
  await expect(cell).toBeVisible({ timeout: 15_000 });
  await cell.click();
  const book = page.getByRole("dialog", { name: "Book Harbour room" });
  await book.getByRole("button", { name: "Book", exact: true }).click();
  await expect(book).toBeHidden();
  await expect(page.getByRole("region", { name: "My bookings" }).or(page.locator("section", { hasText: "My bookings" })).first()).toContainText("Harbour room", { timeout: 10_000 });
  // Admins book straight away even where members need approval; a booking outside the open hours is refused with a reason.
  const made = await page.request.post("/api/booking/resources", { data: { name: "Van one", kind: "vehicle", needsApproval: true, timezone: tz, days: ["mon", "tue", "wed", "thu", "fri"], openFrom: "08:00", openTo: "18:00", stepMin: 30, minMin: 30, maxMin: 240 } });
  expect(made.status(), await made.text()).toBe(201);
  const van = (await made.json()).resource as { id: string };
  const req = await page.request.post("/api/booking/resource-bookings", { data: { resourceId: van.id, startsAt: nextWeekday(11).toISOString(), endsAt: nextWeekday(12).toISOString(), title: "Site visit" } });
  expect(req.status(), await req.text()).toBe(201);
  expect((await req.json()).booking.status).toBe("confirmed");
  const late = await page.request.post("/api/booking/resource-bookings", { data: { resourceId: van.id, startsAt: nextWeekday(19).toISOString(), endsAt: nextWeekday(20).toISOString() } });
  expect(late.status()).toBeGreaterThanOrEqual(400);
  expect(late.status()).toBeLessThan(500);
  expect((await late.json()).error.message.length).toBeGreaterThan(10);
});

test("resources: a member books but cannot add or change resources", async ({ browser }) => {
  test.setTimeout(150_000);
  const tag = Math.random().toString(36).slice(2, 8);
  const ada = await person(browser, `ada-${tag}@example.com`, "Ada Owner");
  expect((await ada.page.request.post("/api/account/onboarding", { headers: ada.headers, data: { name: "Ada Owner", timezone: tz, locale: "en-AU", company: "Ada Co", workspaceTimezone: tz } })).status()).toBeLessThan(300);
  const room = await ada.page.request.post("/api/booking/resources", { headers: ada.headers, data: { name: "Quiet desk", kind: "desk", timezone: tz, days: ["mon", "tue", "wed", "thu", "fri"], openFrom: "08:00", openTo: "18:00", stepMin: 30, minMin: 30, maxMin: 120, quotaMinWeek: 60 } });
  expect(room.status(), await room.text()).toBe(201);
  const desk = (await room.json()).resource as { id: string };
  const invite = await (await ada.page.request.post("/api/team/invites", { data: { email: `ben-${tag}@example.com`, role: "member" }, headers: ada.headers })).json();
  const ben = await person(browser, `ben-${tag}@example.com`, "Ben Mate");
  await confirmEmail(ben.page.request, `ben-${tag}@example.com`);
  expect([200, 410]).toContain((await ben.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: ben.headers })).status());
  expect((await ben.page.request.post("/api/account/onboarding", { headers: ben.headers, data: { name: "Ben Mate", timezone: tz, locale: "en-AU" } })).status()).toBeLessThan(300);
  // Members cannot add or change resources.
  expect((await ben.page.request.post("/api/booking/resources", { headers: ben.headers, data: { name: "Mine" } })).status()).toBe(403);
  expect((await ben.page.request.patch(`/api/booking/resources/${desk.id}`, { headers: ben.headers, data: { name: "Taken" } })).status()).toBe(403);
  // Members book within the rules; the weekly quota stops the second hour.
  const one = await ben.page.request.post("/api/booking/resource-bookings", { headers: ben.headers, data: { resourceId: desk.id, startsAt: nextWeekday(9).toISOString(), endsAt: nextWeekday(10).toISOString() } });
  expect(one.status(), await one.text()).toBe(201);
  const two = await ben.page.request.post("/api/booking/resource-bookings", { headers: ben.headers, data: { resourceId: desk.id, startsAt: nextWeekday(13).toISOString(), endsAt: nextWeekday(14).toISOString() } });
  expect(two.status()).toBe(422);
  expect((await two.json()).error.message).toMatch(/hour|week|quota|limit/i);
  // A member's booking on a resource that needs approval waits; members cannot decide it; the admin approves it.
  const vanR = await ada.page.request.post("/api/booking/resources", { headers: ada.headers, data: { name: "Van one", kind: "vehicle", needsApproval: true, timezone: tz, days: ["mon", "tue", "wed", "thu", "fri"], openFrom: "08:00", openTo: "18:00", stepMin: 30, minMin: 30, maxMin: 240 } });
  const van = (await vanR.json()).resource as { id: string };
  const ask = await ben.page.request.post("/api/booking/resource-bookings", { headers: ben.headers, data: { resourceId: van.id, startsAt: nextWeekday(11).toISOString(), endsAt: nextWeekday(12).toISOString(), title: "Site visit" } });
  expect(ask.status(), await ask.text()).toBe(201);
  const asked = (await ask.json()).booking as { id: string; status: string };
  expect(asked.status).toBe("pending");
  expect((await ben.page.request.post(`/api/booking/resource-bookings/${asked.id}/decide`, { headers: ben.headers, data: { approve: true } })).status()).toBe(403);
  await ada.page.goto("/app/scheduling?tab=resources");
  const waiting = ada.page.getByTestId("approvals");
  await expect(waiting).toContainText("Van one", { timeout: 20_000 });
  await waiting.getByRole("button", { name: "Approve" }).first().click();
  await expect(waiting).toBeHidden({ timeout: 10_000 });
  await ben.page.goto("/app/scheduling?tab=resources");
  await expect(ben.page.getByTestId("resources-tab")).toBeVisible({ timeout: 20_000 });
  await expect(ben.page.getByRole("button", { name: "Add resource" })).toHaveCount(0);
  await expect(ben.page.getByRole("button", { name: /^Edit Quiet desk/ })).toHaveCount(0);
  await expect(ben.page.getByTestId("approvals")).toHaveCount(0);
  await ada.ctx.close(); await ben.ctx.close();
});

test("time poll: guests answer without an account, the host picks the winner and a meeting is made", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await demo(page);
  const a = nextWeekday(10, 2), b = nextWeekday(14, 2), c = nextWeekday(10, 3);
  const r = await page.request.post("/api/booking/polls", { data: { title: "Planning lunch", durationMin: 60, timezone: tz, options: [a, b, c].map((d) => d.toISOString()) } });
  expect(r.status(), await r.text()).toBe(201);
  const poll = (await r.json()).poll as { id: string; token?: string; url?: string; options: { id: string }[] };
  const url = poll.url ?? `/book/poll/${poll.token}`;
  // A guest answers on a phone, logged out.
  const guest = await anon(browser, 390);
  await guest.goto(new URL(url, "http://x").pathname);
  await expect(guest.getByTestId("poll-option").first()).toBeVisible({ timeout: 20_000 });
  await noHScroll(guest);
  await guest.getByLabel("Your name").fill("Kim Guest");
  const groups = guest.getByRole("radiogroup");
  await groups.nth(0).getByRole("radio").first().click();
  await groups.nth(1).getByRole("radio").nth(1).click();
  await guest.getByRole("button", { name: "Send answers" }).click();
  await expect(guest.getByText(/thank|saved|answers are in/i).first()).toBeVisible({ timeout: 15_000 });
  // Empty answers are refused with a reason.
  const g2 = await anon(browser, 390);
  await g2.goto(new URL(url, "http://x").pathname);
  await g2.getByLabel("Your name").fill("Lee");
  await g2.getByRole("button", { name: "Send answers" }).click();
  await expect(g2.getByText("Answer at least one time.")).toBeVisible();
  // A post with no shield answer is refused with a plain reason.
  const raw = await g2.request.post(`/api/pub/booking/polls/${new URL(url, "http://x").pathname.split("/").pop()}/votes`, { data: { name: "Bot", answers: { [poll.options[0].id]: "yes" } } });
  expect(raw.status()).toBe(422);
  expect((await raw.json()).error.message).toContain("Wait a moment and send it again");
  await guest.context().close(); await g2.context().close();
  // The host sees the answer and picks the best time.
  await page.goto("/app/scheduling?tab=polls");
  await expect(page.getByTestId("polls-tab")).toBeVisible({ timeout: 20_000 });
  await page.getByText("Planning lunch").first().click();
  const detail = page.getByTestId("poll-detail");
  await expect(detail).toContainText("Kim Guest", { timeout: 15_000 });
  await detail.getByRole("button", { name: "Pick" }).first().click();
  await page.getByRole("button", { name: /^Pick this time/ }).click();
  await expect(detail.getByRole("button", { name: "Pick" })).toHaveCount(0, { timeout: 15_000 });
});

test("free event: RSVP logged out gets a QR ticket, a full event offers the waitlist, the door checks people in", async ({ page, browser }) => {
  test.setTimeout(150_000);
  await demo(page);
  const start = nextWeekday(18, 4), end = nextWeekday(20, 4);
  const r = await page.request.post("/api/booking/events", { data: { title: "Open studio night", description: "Come and see the new space.", location: "1 Harbour St", startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: tz, capacity: 1, waitlist: true, status: "published" } });
  expect(r.status(), await r.text()).toBe(201);
  const ev = (await r.json()).event as { id: string; slug: string; url?: string };
  const path = ev.url ? new URL(ev.url, "http://x").pathname : `/book/event/${ev.slug}`;
  const guest = await anon(browser, 390);
  await guest.goto(path);
  await expect(guest.getByRole("heading", { name: "Open studio night" })).toBeVisible({ timeout: 20_000 });
  await noHScroll(guest);
  await guest.getByLabel("Your name").fill("Kim Guest");
  await guest.getByLabel("Email").fill("kim@example.com");
  const answered = guest.waitForResponse((r) => r.url().includes("/rsvp") && r.request().method() === "POST");
  await guest.getByRole("button", { name: "Get my ticket" }).click();
  const done = guest.getByTestId("rsvp-done");
  await expect(done).toBeVisible({ timeout: 15_000 });
  await expect(done).toContainText("You're going");
  await expect(done.getByTestId("ticket-code")).toBeVisible();
  const got = (await (await answered).json()) as { status: string; url: string };
  expect(got.status).toBe("going");
  const href = new URL(got.url).pathname + new URL(got.url).search;
  expect(href).toContain("/book/ticket/");
  await guest.goto(href);
  await expect(guest.getByTestId("ticket")).toBeVisible({ timeout: 15_000 });
  const code = (await guest.getByTestId("ticket-code").innerText()).trim();
  expect(code.length).toBeGreaterThan(4);
  // The ticket page leaks nothing without its code.
  const ticketId = new URL(href, "http://x").pathname.split("/").pop()!;
  expect((await guest.request.get(`/api/pub/booking/tickets/${ticketId}?c=WRONG`)).status()).toBeGreaterThanOrEqual(400);
  // Full now: the next person joins the waitlist.
  const second = await anon(browser, 1280);
  await second.goto(path);
  await expect(second.getByRole("button", { name: "Join the waitlist" })).toBeVisible({ timeout: 20_000 });
  const [ans] = await shieldAnswers(second.request, "event", 1);
  const w = await second.request.post(`/api/pub/booking/events/${ev.slug}/rsvp`, { data: { name: "Lee Late", email: "lee@example.com", shield: ans } });
  expect(w.status(), await w.text()).toBe(201);
  expect((await w.json()).status).toBe("waitlist");
  await guest.context().close(); await second.context().close();
  // Door check in by typed code; a second scan says already in.
  await page.goto("/app/scheduling?tab=events");
  await expect(page.getByTestId("events-tab")).toBeVisible({ timeout: 20_000 });
  await page.getByText("Open studio night").first().click();
  const detail = page.getByTestId("event-detail");
  await expect(detail).toContainText("Kim Guest", { timeout: 15_000 });
  await expect(detail).toContainText("Lee Late");
  const scanner = page.getByTestId("scanner");
  if (!(await scanner.isVisible())) await page.getByRole("button", { name: "Check in", exact: true }).first().click();
  await page.getByLabel("Ticket code").fill(code);
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByTestId("scanner")).toContainText(/checked in|welcome/i, { timeout: 10_000 });
  await page.getByLabel("Ticket code").fill(code);
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByTestId("scanner")).toContainText(/already/i, { timeout: 10_000 });
  // Attendees export as CSV for the organiser.
  const csv = await page.request.get(`/api/booking/events/${ev.id}/attendees.csv`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain("Kim Guest");
});

test("spam shield: the real booking page still books with Booking plus on; a post with no answer is refused with a reason", async ({ page, browser }) => {
  test.setTimeout(90_000);
  await demo(page);
  const slug = `shield-${Date.now().toString(36)}`;
  const week = [["08:00", "18:00"]];
  expect((await page.request.put("/api/scheduling/page", { data: { slug, title: "Intro call", timezone: tz, hours: { mon: week, tue: week, wed: week, thu: week, fri: week }, slotMin: 30, minNoticeMin: 0, maxDaysAhead: 14 } })).status()).toBe(200);
  const guest = await anon(browser, 390);
  const pub = (await (await guest.request.get(`/api/book/${slug}?days=14`)).json()) as { slots: string[] };
  const bare = await guest.request.post(`/api/book/${slug}`, { data: { startsAt: pub.slots[0], name: "Bot", email: "bot@example.com" } });
  expect(bare.status()).toBe(422);
  expect((await bare.json()).error.code).toBe("spam_check_failed");
  await guest.goto(`/book/${slug}`);
  await guest.getByRole("button", { name: /\d/ }).filter({ hasText: /:/ }).first().click();
  await guest.getByLabel("Name").fill("Kim Real");
  await guest.getByLabel("Email").fill("kim.real@example.com");
  await guest.getByRole("button", { name: "Confirm booking" }).click();
  await expect(guest.getByText(/booked|confirmed|you're in|see you/i).first()).toBeVisible({ timeout: 15_000 });
  await guest.context().close();
});

test("shots: resources, polls, events and the public pages at 1280 and 390, light, dark and Forest", async ({ page, browser }) => {
  test.skip(!DIR, "shots only when SHOTS_DIR is set");
  test.setTimeout(400_000);
  await demo(page);
  await page.request.post("/api/booking/resources", { data: { name: "Board room with a very long name for the north wing", kind: "room", timezone: tz, days: ["mon", "tue", "wed", "thu", "fri"], openFrom: "08:00", openTo: "18:00", stepMin: 30, minMin: 30, maxMin: 240, checkinRequired: true } });
  const p = (await (await page.request.post("/api/booking/polls", { data: { title: "Team offsite day", durationMin: 60, timezone: tz, options: [nextWeekday(10, 2), nextWeekday(14, 2)].map((d) => d.toISOString()) } })).json()).poll as { token?: string; url?: string };
  const ev = (await (await page.request.post("/api/booking/events", { data: { title: "Launch evening", location: "1 Harbour St", startsAt: nextWeekday(18, 4).toISOString(), endsAt: nextWeekday(20, 4).toISOString(), timezone: tz, capacity: 40, waitlist: true, status: "published" } })).json()).event as { slug: string; url?: string };
  const pollPath = p.url ? new URL(p.url, "http://x").pathname : `/book/poll/${p.token}`;
  const evPath = ev.url ? new URL(ev.url, "http://x").pathname : `/book/event/${ev.slug}`;
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      for (const t of ["resources", "polls", "events"]) {
        await page.goto(`/app/scheduling?tab=${t}`);
        await expect(page.getByTestId(`${t}-tab`)).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(500);
        const go = page.getByRole("button", { name: /^Go to / }).filter({ visible: true });
        if (t === "resources" && (await go.count())) { await go.first().click(); await page.waitForTimeout(500); }
        await noHScroll(page);
        await shot(page, `${t}-${w}-${theme}`, w === 1280);
        await axe(page, `${t} ${w} ${theme}`);
      }
      for (const [n, path] of [["poll-public", pollPath], ["event-public", evPath]] as const) {
        await page.goto(path);
        await page.waitForTimeout(800);
        await noHScroll(page);
        await shot(page, `${n}-${w}-${theme}`, w === 1280);
        await axe(page, `${n} ${w} ${theme}`);
      }
    }
  };
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await run(scheme); }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  await run("forest");
  void browser;
});

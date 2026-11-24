import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { sydneyMonth } from "./support/sydney-month";
import { SHOTS_ROOT } from "./support/shots";
import { connectCode } from "./support/connect-code"; // PRIV1b (P60)

/**
 * Round 23 (R23.4) end to end: Settings > Calendar turns on a personal feed whose .ics holds a meeting
 * just scheduled; Reset gives a new address and the old one answers 404; a calendar link (ICS) served
 * by this test's own HTTP server shows its events read only on the work calendar. With the local
 * Stalwart test server (STALWART_TEST_*), a connected mailbox's CalDAV calendar shows too.
 * Runs on the identity provider app (E2E_IDP_PORT), whose server may reach 127.0.0.1 (test only).
 */
test.skip(!!process.env.E2E_BASE_URL, "local only: the calendar link is served from this machine");
const BASE = `http://localhost:${process.env.E2E_IDP_PORT ?? "8790"}`;
const live = !!process.env.STALWART_TEST_URL;
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
test.use({ extraHTTPHeaders: { "x-forwarded-for": ip() }, timezoneId: "Australia/Sydney" });

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

/** A family calendar like Google's secret address: an all day event, a timed one and a weekly one, this month. */
function familyIcs(now: Date) {
  const { y, m } = sydneyMonth(now);
  const d = (n: number) => new Date(Date.UTC(y, m, n));
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Family//EN", "X-WR-CALNAME:Family", "X-WR-TIMEZONE:Australia/Sydney",
    "BEGIN:VEVENT", "UID:fam-1", `DTSTART;VALUE=DATE:${day(d(12))}`, `DTEND;VALUE=DATE:${day(d(13))}`, "SUMMARY:Grandma visits", "END:VEVENT",
    "BEGIN:VEVENT", "UID:fam-2", `DTSTART;TZID=Australia/Sydney:${day(d(9))}T171500`, `DTEND;TZID=Australia/Sydney:${day(d(9))}T180000`, "SUMMARY:Swimming lesson", "END:VEVENT",
    "BEGIN:VEVENT", "UID:fam-3", `DTSTART;TZID=Australia/Sydney:${day(d(1))}T150000`, `DTEND;TZID=Australia/Sydney:${day(d(1))}T153000`, "RRULE:FREQ=WEEKLY;COUNT=5", "SUMMARY:School pickup", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
}

async function signInFresh(page: Page, email: string, name: string) {
  await page.route("https://idp.multies.test/**", async (route) => {
    const url = new URL(route.request().url());
    const code = Buffer.from(JSON.stringify({ nonce: url.searchParams.get("nonce"), email, name })).toString("base64url");
    await route.fulfill({ status: 302, headers: { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` } });
  });
  await page.goto(`${BASE}/login`);
  await page.getByRole("button", { name: "Continue with Multies" }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

let server: Server;
let icsUrl = "";
test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/family.ics") { res.writeHead(200, { "content-type": "text/calendar" }); res.end(familyIcs(new Date())); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  icsUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/family.ics`;
});
test.afterAll(async () => { await new Promise((r) => server.close(r)); });

test("calendar feed with a meeting, reset, and a calendar link shown read only on the work calendar", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  await signInFresh(page, `cal-${stamp}@example.com`, "Ada Lovelace");
  const headers = { origin: BASE };
  expect((await page.request.post(`${BASE}/api/account/onboarding`, { data: { name: "Ada Lovelace", timezone: "Australia/Sydney", locale: "en-AU", company: "Analytical Engines", workspaceTimezone: "Australia/Sydney" }, headers })).status()).toBeLessThan(300);
  const me = await (await page.request.get(`${BASE}/api/account/me`)).json();

  // A meeting and two tasks with due dates this month, so the calendar reads like a real one.
  const now = new Date();
  const shown = sydneyMonth(now);
  const at = (n: number, h: number) => new Date(Date.UTC(shown.y, shown.m, n, h)).toISOString();
  const meeting = await page.request.post(`${BASE}/api/meetings`, { data: { title: "Pricing review with Grace", startsAt: at(14, 0), durationMin: 45 }, headers });
  expect(meeting.status()).toBe(201);
  for (const [title, n] of [["Send Harbour Coffee the quote", 16], ["Board pack", 21]] as const) {
    expect((await page.request.post(`${BASE}/api/tasks`, { data: { title, due: at(n, 0).slice(0, 10), assignee: `member:${me.user.id}` }, headers })).status()).toBe(201);
  }

  // Settings > Calendar: turn on the feed.
  await page.goto(`${BASE}/app/settings/calendar`);
  await page.getByRole("button", { name: "Turn on calendar feed" }).click();
  const field = page.getByTestId("calendar-feed-url");
  await expect(field).toHaveValue(/\/cal\/[A-Za-z0-9]{32}\.ics$/);
  const first = await field.inputValue();
  const ics = await page.request.get(first);
  expect(ics.status()).toBe(200);
  expect(ics.headers()["content-type"]).toContain("text/calendar");
  const body = await ics.text();
  expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  expect(body).toContain("SUMMARY:Pricing review with Grace");
  expect(body).toContain("SUMMARY:Due: Send Harbour Coffee the quote");
  expect(body).toContain("END:VCALENDAR\r\n");

  // Reset: a new address, and the old one stops at once.
  await page.getByRole("button", { name: "Reset link" }).click();
  await expect(field).not.toHaveValue(first);
  const second = await field.inputValue();
  expect((await page.request.get(first)).status()).toBe(404);
  expect((await page.request.get(second)).status()).toBe(200);

  // Add a calendar link (ICS) served by this test.
  await page.getByTestId("ics-url").fill(icsUrl);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("calendar-sources")).toContainText("Family");
  await expect(page.getByTestId("calendar-sources")).not.toContainText("family.ics");

  if (live) {
    const acct = JSON.parse(execFileSync("npx", ["tsx", "e2e/support/stalwart-account.ts", `cal${stamp}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { user: string; pass: string };
    const [imapHost, imapPort] = (process.env.STALWART_TEST_IMAP ?? "127.0.0.1:1143").split(":");
    const [smtpHost, smtpPort] = (process.env.STALWART_TEST_SMTP ?? "127.0.0.1:1587").split(":");
    const conn = await page.request.post(`${BASE}/api/connections`, { data: { email: acct.user, password: acct.pass, preset: "custom", imap: { host: imapHost, port: Number(imapPort), security: "starttls" }, smtp: { host: smtpHost, port: Number(smtpPort), security: "starttls" } }, headers });
    expect(conn.status()).toBe(201);
    const connectionId = (await conn.json()).connection?.id;
    // PRIV1b (P60): an unrecognised server waits for the code emailed to the address.
    expect((await page.request.post(`${BASE}/api/connections/${connectionId}/verify`, { data: { code: await connectCode(acct.user) }, headers })).status()).toBe(200);
    const cal = `${process.env.STALWART_TEST_URL}/dav/cal/${encodeURIComponent(acct.user)}/default/standup.ics`;
    const put = await fetch(cal, { method: "PUT", headers: { authorization: `Basic ${Buffer.from(`${acct.user}:${acct.pass}`).toString("base64")}`, "content-type": "text/calendar" }, body: ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//T//T//EN", "BEGIN:VEVENT", "UID:stalwart-1", `DTSTAMP:${day(now)}T000000Z`, `DTSTART:${day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 20)))}T230000Z`, `DTEND:${day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 20)))}T233000Z`, "SUMMARY:Team standup (Stalwart)", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n") });
    expect(put.status).toBeLessThan(300);
    const add = await page.request.post(`${BASE}/api/calendar/sources`, { data: { kind: "caldav", connectionId, url: `${process.env.STALWART_TEST_URL}/`, name: "Work mail calendar" }, headers });
    expect(add.status()).toBe(201);
  }

  // The work calendar: the other calendar's events, read only and muted, beside the due dates.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${BASE}/app/tasks?view=calendar`);
  const bar = page.getByTestId("other-calendars");
  await expect(bar.getByRole("button", { name: "Hide Family" })).toBeVisible();
  const cal = page.getByTestId("task-calendar");
  await expect(cal.getByText("Grandma visits")).toBeVisible({ timeout: 15_000 });
  await expect(cal.getByText("School pickup").first()).toBeVisible();
  await expect(cal.getByText("Send Harbour Coffee the quote")).toBeVisible();
  await expect(cal.getByText("Pricing review with Grace")).toBeVisible();
  if (live) await expect(cal.getByText("Team standup (Stalwart)")).toBeVisible({ timeout: 15_000 });
  // Read only: clicking it opens nothing.
  await cal.getByText("Grandma visits").click();
  await expect(page).toHaveURL(/view=calendar/);
  mkdirSync(`${SHOTS_ROOT}/multies-r23`, { recursive: true });
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r23/calendar.png` });
  // Toggle the layer off.
  await bar.getByRole("button", { name: "Hide Family" }).click();
  await expect(cal.getByText("Grandma visits")).toHaveCount(0);
  // Multies meetings show on the calendar too: a toggle hides them, and a click opens the meeting.
  await bar.getByRole("button", { name: "Hide meetings" }).click();
  await expect(cal.getByText("Pricing review with Grace")).toHaveCount(0);
  await bar.getByRole("button", { name: "Show meetings" }).click();
  await cal.getByText("Pricing review with Grace").click();
  await expect(page).toHaveURL(/\/app\/meetings\/mtg_/);
});

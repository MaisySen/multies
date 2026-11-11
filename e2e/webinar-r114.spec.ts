import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { confirmEmail } from "./support/confirm-email";
import { mkdirSync, readFileSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R114 webinar mode end to end (WEBINAR_R114=on): the host turns on webinar mode and sees the real cap, someone
 * registers on the public page, opens their personal page, asks a question; the host answers it and launches a
 * poll; the attendee votes and sees results; the report shows the numbers and the CSV downloads; the replay page
 * says there is none yet; a full webinar says so. Video keys are not set locally, so the stage itself (real media)
 * is not exercised here: the attendee page says video is not switched on, and the controls and API are tested.
 */
test.describe.configure({ mode: "serial" });
const SHOTS = process.env.SHOTS_DIR ?? `${SHOTS_ROOT}/catalogue/r114/shots`;
mkdirSync(SHOTS, { recursive: true });
let visitor = 0;
const ip = () => `10.114.${test.info().workerIndex % 200}.${++visitor}`;
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${label}: ${v.id} ${v.nodes[0]?.target}`);
}
async function signIn(page: Page) {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return headers;
}
async function meeting(page: Page, headers: Record<string, string>, title: string, durationMin = 60) {
  const r = await page.request.post("/api/meetings", { data: { title, startsAt: new Date(Date.now() + 60_000).toISOString(), durationMin }, headers });
  expect(r.status()).toBe(201);
  return (await r.json()).meeting as { id: string };
}

let regUrl = "";
let attendeeUrl = "";
let meetingId = "";
const problems: string[] = [];

test("host turns on webinar mode and sees the real cap", async ({ page }) => {
  const headers = await signIn(page);
  meetingId = (await meeting(page, headers, "Spring product launch")).id;
  await page.goto(`/app/meetings/${meetingId}`);
  const card = page.getByTestId("webinar-card");
  await expect(card).toBeVisible();
  await card.getByRole("switch", { name: "Make this a webinar" }).click();
  await expect(card.getByTestId("webinar-cap")).toHaveText(/^Up to 15 attendees on your plan\./);
  regUrl = await card.getByLabel("Registration link").inputValue();
  expect(regUrl).toMatch(/\/w\/[A-Za-z0-9]+$/);
  await shot(page, "r114-meeting-card-1280-light");
  problems.push(...(await axe(page, "meeting card")));
  // a webinar host page with nothing yet
  await card.getByTestId("open-webinar").click();
  await expect(page.getByTestId("webinar-questions")).toContainText("No questions yet");
  await shot(page, "r114-host-empty-1280-light");
});

test("someone registers and asks a question", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  await page.goto(new URL(regUrl).pathname);
  await expect(page.getByRole("heading", { name: "Spring product launch" })).toBeVisible();
  await expect(page).not.toHaveTitle(/Page not found/);
  await expect(page.getByTestId("webinar-register")).toContainText("Up to 15 attendees.");
  problems.push(...(await axe(page, "register")));
  await shot(page, "r114-register-1280-light");
  await page.getByLabel("Your name").fill("Rita Reader");
  await page.getByLabel("Email").fill("not an email");
  await page.getByTestId("webinar-register-submit").click();
  await expect(page.getByRole("alert")).toHaveText("Enter an email like name@example.com.");
  await page.getByLabel("Email").fill("rita@example.com");
  await page.waitForTimeout(2100);
  await page.getByTestId("webinar-register-submit").click();
  await expect(page.getByTestId("webinar-registered")).toContainText("You're registered");
  await shot(page, "r114-registered-1280-light");
  await page.getByRole("link", { name: "Open your webinar page" }).click();
  await expect(page.getByTestId("webinar-attendee")).toContainText("watching as Rita Reader");
  attendeeUrl = page.url();
  await page.getByLabel("Your question").fill("Will there be a replay?");
  await page.getByTestId("webinar-ask").click();
  await expect(page.getByText("Will there be a replay?")).toBeVisible();
  problems.push(...(await axe(page, "attendee")));
  await shot(page, "r114-attendee-1280-light");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "r114-attendee-390-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "r114-attendee-390-dark");
  problems.push(...(await axe(page, "attendee 390 dark")));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  // the same email again: no link on screen
  await page.goto(new URL(regUrl).pathname);
  await page.getByLabel("Your name").fill("Someone");
  await page.getByLabel("Email").fill("RITA@example.com");
  await page.waitForTimeout(2100);
  await page.getByTestId("webinar-register-submit").click();
  await expect(page.getByTestId("webinar-registered")).toContainText("You're already registered");
  await expect(page.getByRole("link", { name: "Open your webinar page" })).toHaveCount(0);
  await ctx.close();
});

test("host flow in one session: answer, poll, report, CSV, replay, full", async ({ page, browser }) => {
  const headers = await signIn(page);
  const m = await meeting(page, headers, "Customer webinar");
  await page.request.patch(`/api/webinars/${m.id}`, { data: { enabled: true }, headers });
  const w = (await (await page.request.get(`/api/webinars/${m.id}`)).json()).webinar;
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const a = await ctx.newPage();
  await a.goto(new URL(w.registrationUrl).pathname);
  await a.getByLabel("Your name").fill("Ben Buyer");
  await a.getByLabel("Email").fill("ben@example.com");
  await a.waitForTimeout(2100);
  await a.getByTestId("webinar-register-submit").click();
  await a.getByRole("link", { name: "Open your webinar page" }).click();
  await a.getByLabel("Your question").fill("How much does it cost?");
  await a.getByTestId("webinar-ask").click();
  await expect(a.getByText("How much does it cost?")).toBeVisible();
  // host answers and launches a poll
  await page.goto(`/app/meetings/${m.id}/webinar`);
  const qs = page.getByTestId("webinar-questions");
  await expect(qs).toContainText("How much does it cost?");
  await qs.getByRole("button", { name: "Type an answer" }).click();
  await qs.getByLabel("Answer").fill("Free for up to 3 people");
  await qs.getByRole("button", { name: "Send" }).click();
  await expect(qs).toContainText("Free for up to 3 people");
  // a hidden question stays readable for the host: axe light and dark, then show it again
  await qs.getByRole("button", { name: "Hide question" }).click();
  await expect(qs).toContainText("Hidden from attendees");
  problems.push(...(await axe(page, "host hidden question light")));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400); // colours transition after the scheme switch
  problems.push(...(await axe(page, "host hidden question dark")));
  await shot(page, "r114-host-hidden-question-1280-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await qs.getByRole("button", { name: "Show question" }).click();
  await expect(qs).not.toContainText("Hidden from attendees");
  await page.getByTestId("webinar-new-poll").click();
  await page.getByLabel("Poll question").fill("Which plan fits you?");
  await page.getByLabel("Choice 1").fill("Free");
  await page.getByLabel("Choice 2").fill("Team");
  await page.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page.getByTestId("webinar-polls")).toContainText("Which plan fits you?");
  await page.getByTestId("webinar-host-chat").getByLabel("Chat message").fill("Welcome everyone");
  await page.getByTestId("webinar-host-chat").getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("webinar-host-chat")).toContainText("Welcome everyone");
  await shot(page, "r114-host-live-1280-light");
  problems.push(...(await axe(page, "host live")));
  // attendee sees the answer, votes, sees results and chat
  await a.reload();
  await expect(a.getByText("Free for up to 3 people")).toBeVisible();
  await a.getByTestId("attendee-tab-polls").click();
  await a.getByLabel("Team").check();
  await a.getByTestId("attendee-vote").click();
  await expect(a.getByTestId("attendee-poll")).toContainText("1 vote");
  await a.getByTestId("attendee-tab-chat").click();
  await expect(a.getByText("Welcome everyone")).toBeVisible();
  await shot(a, "r114-attendee-poll-1280-light");
  const token = new URL(a.url()).pathname.split("/w/a/")[1];
  // replay: none yet
  await a.goto(`/w/a/${token}/replay`);
  await expect(a.getByTestId("webinar-no-replay")).toContainText("No replay yet");
  await ctx.close();
  // report and CSV
  await page.getByTestId("webinar-tab-report").click();
  await expect(page.getByTestId("webinar-report")).toContainText("ben@example.com");
  await expect(page.getByTestId("webinar-report")).toContainText("Which plan fits you?");
  const dl = page.waitForEvent("download");
  await page.getByTestId("webinar-csv").click();
  const csv = readFileSync(await (await dl).path(), "utf8");
  expect(csv).toContain("Name,Email,Registered at,Attended,First joined,Minutes watched,Questions asked");
  expect(csv).toContain("Ben Buyer,ben@example.com");
  expect(csv).toContain("Which plan fits you?,Team,1");
  await shot(page, "r114-report-1280-light");
  problems.push(...(await axe(page, "report")));
  // the registrations table scrolls sideways at 390 wide: it must be reachable by keyboard (axe scrollable-region-focusable)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByRole("region", { name: "Registrations" })).toHaveAttribute("tabindex", "0");
  await shot(page, "r114-report-390-dark");
  problems.push(...(await axe(page, "report 390 dark")));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByTestId("webinar-tab-replay").click();
  await expect(page.getByTestId("webinar-replay-settings")).toContainText("No finished recordings yet");
  await page.getByTestId("webinar-tab-settings").click();
  await expect(page.getByTestId("webinar-settings")).toContainText("Up to 15 attendees on your plan");
  // dark, Forest and phone on the host page
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByTestId("webinar-tab-live").click();
  await shot(page, "r114-host-live-1280-dark");
  problems.push(...(await axe(page, "host dark")));
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "r114-host-live-390-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.goto(`/app/meetings/${m.id}/webinar`);
  await expect(page.getByTestId("webinar-questions")).toBeVisible();
  await shot(page, "r114-host-live-1280-forest");
  problems.push(...(await axe(page, "host forest")));
  // full: an eight hour webinar on the free plan holds one attendee
  const big = await meeting(page, headers, "All day workshop", 480);
  const bw = (await (await page.request.patch(`/api/webinars/${big.id}`, { data: { enabled: true }, headers })).json()).webinar;
  expect(bw.cap.cap).toBe(1);
  const slug = bw.registrationUrl.split("/w/")[1];
  const r1 = await page.request.post(`/api/public/webinars/r/${slug}/register`, { data: { name: "One", email: "one@example.com", openedAt: Date.now() - 5000 }, headers: { ...headers, "x-forwarded-for": ip() } });
  expect(r1.status()).toBe(201);
  const ctx2 = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const f = await ctx2.newPage();
  await f.goto(`/w/${slug}`);
  await expect(f.getByTestId("webinar-full")).toContainText("This webinar is full.");
  await shot(f, "r114-register-full-1280-light");
  await ctx2.close();
});

test("member vs host: a member cannot manage; the host adds a panelist, hides a chat message and turns chat off; not started", async ({ page, browser }) => {
  const headers = await signIn(page);
  const m = await meeting(page, headers, "Team town hall");
  const base = test.info().project.use.baseURL!;
  const tag = Math.random().toString(36).slice(2, 8);
  const invite = await (await page.request.post("/api/team/invites", { data: { email: `ben-${tag}@example.com`, role: "member" }, headers })).json();
  const ctxB = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const b = await ctxB.newPage();
  expect((await b.request.post("/api/auth/sign-up/email", { data: { name: "Ben Mate", email: `ben-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await b.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  await confirmEmail(b.request, `ben-${tag}@example.com`);
  const acc = await b.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers });
  // signing up with the invited address may join the workspace already; either way Ben is a plain member now
  expect([200, 410], await acc.text()).toContain(acc.status());
  // a member sees the card but cannot turn it on, and the API refuses settings and the report
  await b.goto(`/app/meetings/${m.id}`);
  await expect(b.getByTestId("webinar-card")).toContainText("Only the host or an admin can turn on webinar mode.");
  await expect(b.getByRole("switch", { name: "Make this a webinar" })).toHaveCount(0);
  expect((await b.request.patch(`/api/webinars/${m.id}`, { data: { enabled: true }, headers })).status()).toBe(403);
  const w = (await (await page.request.patch(`/api/webinars/${m.id}`, { data: { enabled: true }, headers })).json()).webinar;
  expect((await b.request.get(`/api/webinars/${m.id}/report`)).status()).toBe(403);
  expect((await b.request.get(`/api/webinars/${m.id}/report.csv`)).status()).toBe(403);
  await b.goto(`/app/meetings/${m.id}/webinar`);
  await expect(b.getByTestId("webinar-not-host")).toContainText("Hosts and panelists run this webinar");
  problems.push(...(await axe(b, "member not host")));
  await expect(b.getByTestId("webinar-tab-report")).toHaveCount(0);
  await expect(b.getByTestId("webinar-tab-settings")).toHaveCount(0);
  await expect(b.getByLabel("Who can chat")).toHaveCount(0);
  // an attendee chats
  const slug = w.registrationUrl.split("/w/")[1];
  const reg = await (await page.request.post(`/api/public/webinars/r/${slug}/register`, { data: { name: "Rita Reader", email: `rita-${tag}@example.com`, openedAt: Date.now() - 5000 }, headers: { ...headers, "x-forwarded-for": ip() } })).json();
  const ctxA = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const a = await ctxA.newPage();
  await a.goto(new URL(reg.joinUrl).pathname);
  await a.getByTestId("attendee-tab-chat").click();
  await a.getByLabel("Chat message").fill("Hello from Rita");
  await a.getByRole("button", { name: "Send" }).click();
  await expect(a.getByText("Hello from Rita")).toBeVisible();
  // the host adds Ben as a panelist, hides Rita's message, then turns chat off
  await page.goto(`/app/meetings/${m.id}/webinar`);
  await page.getByLabel("Add a panelist").selectOption({ label: "Ben Mate" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: "Move to audience" })).toBeVisible();
  const chat = page.getByTestId("webinar-host-chat");
  await expect(chat).toContainText("Hello from Rita");
  await chat.getByRole("button", { name: "Hide message" }).click();
  await expect(chat.getByRole("button", { name: "Show message" })).toBeVisible();
  // a hidden message stays readable for the host (no dimmed text): axe in light and dark
  problems.push(...(await axe(page, "host hidden chat light")));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400); // colours transition after the scheme switch
  problems.push(...(await axe(page, "host hidden chat dark")));
  await page.emulateMedia({ colorScheme: "light" });
  // arrow keys move between the host page tabs
  await page.getByTestId("webinar-tab-live").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("webinar-tab-report")).toBeFocused();
  await expect(page.getByTestId("webinar-tab-report")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("webinar-tab-live")).toHaveAttribute("aria-selected", "true");
  await chat.getByLabel("Who can chat").selectOption("off");
  await expect(chat.getByLabel("Who can chat")).toHaveValue("off");
  await shot(page, "r114-host-moderation-1280-light");
  await a.reload();
  await a.getByTestId("attendee-tab-chat").click();
  await expect(a.getByTestId("attendee-chat-off")).toContainText("The host turned chat off.");
  await expect(a.getByText("Hello from Rita")).toHaveCount(0);
  // Ben, now a panelist, sees the live questions and chat, but still no settings or report
  await b.reload();
  await expect(b.getByTestId("webinar-questions")).toBeVisible();
  await expect(b.getByTestId("webinar-tab-settings")).toHaveCount(0);
  await expect(b.getByLabel("Who can chat")).toHaveCount(0);
  await ctxA.close();
  await ctxB.close();
  // a webinar three hours away: registration works and the attendee page says not started
  const later = await page.request.post("/api/meetings", { data: { title: "Later launch", startsAt: new Date(Date.now() + 3 * 3600_000).toISOString(), durationMin: 30 }, headers });
  const lm = (await later.json()).meeting;
  const lw = (await (await page.request.patch(`/api/webinars/${lm.id}`, { data: { enabled: true }, headers })).json()).webinar;
  const lslug = lw.registrationUrl.split("/w/")[1];
  const lreg = await (await page.request.post(`/api/public/webinars/r/${lslug}/register`, { data: { name: "Early Bird", email: `early-${tag}@example.com`, openedAt: Date.now() - 5000 }, headers: { ...headers, "x-forwarded-for": ip() } })).json();
  const ctxC = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const c = await ctxC.newPage();
  await c.goto(new URL(lreg.joinUrl).pathname);
  await expect(c.getByTestId("webinar-not-started")).toBeVisible();
  problems.push(...(await axe(c, "attendee not started")));
  await shot(c, "r114-attendee-not-started-1280-light");
  await ctxC.close();
});

test("replay: the host shares a finished recording and the attendee reads it", async ({ page, browser }) => {
  const headers = await signIn(page);
  expect((await page.request.put("/api/ai/key", { data: { provider: "openai", apiKey: ["sk", "e2e", "0123456789abcdefWXYZ"].join("-") /* a fake key; the local server fakes the AI (AI_FAKE) */ }, headers })).status()).toBe(200);
  const m = await meeting(page, headers, "Quarterly review webinar");
  const w = (await (await page.request.patch(`/api/webinars/${m.id}`, { data: { enabled: true }, headers })).json()).webinar;
  const slug = w.registrationUrl.split("/w/")[1];
  const reg = await (await page.request.post(`/api/public/webinars/r/${slug}/register`, { data: { name: "Rory Replay", email: "rory@example.com", openedAt: Date.now() - 5000 }, headers: { ...headers, "x-forwarded-for": ip() } })).json();
  const start = await page.request.post(`/api/meetings/${m.id}/recordings`, { data: {}, headers });
  expect(start.status()).toBe(201);
  const rid = (await start.json()).recording.id as string;
  const audio = Buffer.from(Array.from({ length: 256 }, (_, i) => i % 251)).toString("base64");
  expect((await page.request.put(`/api/meetings/${m.id}/recordings/${rid}/chunks/0`, { data: { audioBase64: audio, mime: "audio/webm;codecs=opus", offsetSec: 0, durationSec: 120 }, headers })).status()).toBe(200);
  const stop = await page.request.post(`/api/meetings/${m.id}/recordings/${rid}/stop`, { data: { durationSec: 120 }, headers });
  expect(stop.status()).toBe(200);
  expect((await stop.json()).recording.status).toBe("done");
  // before sharing, the attendee sees no replay
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const a = await ctx.newPage();
  const token = new URL(reg.joinUrl).pathname.split("/w/a/")[1];
  await a.goto(`/w/a/${token}/replay`);
  await expect(a.getByTestId("webinar-no-replay")).toBeVisible();
  // the host shares it
  await page.goto(`/app/meetings/${m.id}/webinar`);
  await page.getByTestId("webinar-tab-replay").click();
  const box = page.getByTestId("webinar-replay-settings");
  await box.getByLabel("Recording").selectOption({ index: 1 });
  await box.getByRole("button", { name: "Share replay" }).click();
  await expect(box).toContainText("Shared with everyone who registered.");
  await shot(page, "r114-host-replay-1280-light");
  problems.push(...(await axe(page, "host replay")));
  await a.reload();
  await expect(a.getByTestId("webinar-replay")).toBeVisible();
  await expect(a.getByTestId("webinar-replay")).toContainText("Quarterly review webinar");
  await shot(a, "r114-replay-1280-light");
  problems.push(...(await axe(a, "replay")));
  await a.setViewportSize({ width: 390, height: 844 });
  await a.emulateMedia({ colorScheme: "dark" });
  await shot(a, "r114-replay-390-dark");
  problems.push(...(await axe(a, "replay 390 dark")));
  await ctx.close();
});

test("a signed out visitor cannot read the report", async ({ page }) => {
  // permission rules (member, admin, guest, panelist) are covered in tests/webinar-r114.test.ts; here the API answer
  // for a signed out visitor on a host route is checked.
  const r = await page.request.get(`/api/webinars/${meetingId}/report`);
  expect([401, 403]).toContain(r.status());
});

test("no serious or critical axe findings", async () => {
  expect(problems).toEqual([]);
  void attendeeUrl;
});

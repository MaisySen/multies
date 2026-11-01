/**
 * R92 Booking plus: spam shield, resource rules and quotas, approval, QR check in and no show release, time polls
 * (public voting, edit, pick winner makes a meeting), events (capacity, waitlist, promotion, QR ticket, door check in,
 * CSV), member vs admin, flag off.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { leadingZeroBits, solveWork, checkWork, SHIELD_HONEYPOT_NAME } from "@/shared/spam-shield";
import { bestOption, csvCell, formatTicketCode, normaliseTicketCode, pollTotals, readScan, ruleProblem, rulesProblem } from "@/shared/booking-plus";
import { qrPng } from "@/server/services/booking/qr-png";

const ON = { SCHEDULING_ENABLED: "true", BOOKING_PLUS: "true", SHIELD_DIFFICULTY: "4", APP_URL: "http://localhost" };
let ipN = 1;

async function setup(env: Record<string, string> = ON) {
  const ctx = await makeTestApp(env);
  let clock = Date.parse("2026-11-02T00:00:00Z"); // Monday 11 am in Sydney
  ctx.deps.now = () => new Date(clock);
  const owner = new Client(ctx.app);
  await owner.signup("ada@acme.io", "Ada Lovelace", "Acme");
  return { ...ctx, owner, advance: (ms: number) => { clock += ms; }, now: () => clock };
}
type T = Awaited<ReturnType<typeof setup>>;

async function member(t: T, email = "mate@acme.io") {
  const invite = await t.owner.post("/api/team/invites", { email, role: "member" });
  const mate = new Client(t.app);
  await mate.signup(email, "Mate Member", "");
  expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return mate;
}

async function pub(t: T, method: string, path: string, body?: unknown) {
  const res = await t.app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { host: "localhost", "content-type": "application/json", "cf-connecting-ip": `10.0.${Math.floor(ipN / 200)}.${ipN++ % 200}` } });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

async function shield(t: T, form: string) {
  const c = (await pub(t, "GET", `/api/pub/booking/shield?form=${form}`)).body.challenge;
  const nonce = await solveWork(c.salt, c.difficulty);
  t.advance(2000);
  return { challenge: c, nonce, hp: "" };
}

describe("R92 spam shield (shared module)", () => {
  it("counts leading zero bits and solves work", async () => {
    expect(leadingZeroBits(new Uint8Array([0, 0x0f, 0xff]))).toBe(12);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    const n = await solveWork("salt", 8);
    expect(await checkWork("salt", n, 8)).toBe(true);
    expect(await checkWork("salt", -1, 0)).toBe(false);
    expect(SHIELD_HONEYPOT_NAME).toBe("website");
  });

  it("refuses missing, forged, wrong form, too fast, honeypot, bad work, reused and expired answers", async () => {
    const t = await setup();
    const { body } = await t.owner.post("/api/booking/events", { title: "Launch night", startsAt: "2026-11-20T08:00:00Z", endsAt: "2026-11-20T10:00:00Z", timezone: "Australia/Sydney", status: "published" });
    const slug = body.event.slug;
    const rsvp = (b: unknown) => pub(t, "POST", `/api/pub/booking/events/${slug}/rsvp`, b);
    const reason = (r: { body: { error: { details?: { reason: string } } } }) => r.body.error.details?.reason;
    expect((await rsvp({ name: "A", email: "a@x.io" })).status).toBe(422);
    const c = (await pub(t, "GET", "/api/pub/booking/shield?form=event")).body.challenge;
    const nonce = await solveWork(c.salt, c.difficulty);
    expect(reason(await rsvp({ name: "A", email: "a@x.io", shield: { challenge: c, nonce } }))).toBe("too_fast");
    t.advance(2000);
    expect(reason(await rsvp({ name: "A", email: "a@x.io", shield: { challenge: { ...c, difficulty: 0 }, nonce } }))).toBe("bad_signature");
    expect(reason(await rsvp({ name: "A", email: "a@x.io", shield: { challenge: c, nonce, hp: "http://spam" } }))).toBe("honeypot");
    let bad = 0;
    while (await checkWork(c.salt, bad, c.difficulty)) bad++;
    expect(reason(await rsvp({ name: "A", email: "a@x.io", shield: { challenge: c, nonce: bad } }))).toBe("bad_work");
    const poll = await shield(t, "poll");
    expect(reason(await rsvp({ name: "A", email: "a@x.io", shield: poll }))).toBe("wrong_form");
    expect((await rsvp({ name: "A", email: "a@x.io", shield: { challenge: c, nonce } })).status).toBe(201);
    expect(reason(await rsvp({ name: "B", email: "b@x.io", shield: { challenge: c, nonce } }))).toBe("reused");
    const late = await shield(t, "event");
    t.advance(31 * 60_000);
    expect(reason(await rsvp({ name: "C", email: "c@x.io", shield: late }))).toBe("expired");
  });

  it("guards the existing booking page once Booking plus is on, and not before", async () => {
    for (const on of [true, false]) {
      const t = await setup(on ? ON : { SCHEDULING_ENABLED: "true", APP_URL: "http://localhost" });
      await t.owner.put("/api/scheduling/page", { slug: on ? "ada-on" : "ada-off", timezone: "UTC", minNoticeMin: 0 });
      const slots = (await pub(t, "GET", `/api/book/${on ? "ada-on" : "ada-off"}`)).body.slots as string[];
      const r = await pub(t, "POST", `/api/book/${on ? "ada-on" : "ada-off"}`, { startsAt: slots[0], name: "Guest", email: "g@x.io" });
      expect(r.status).toBe(on ? 422 : 201);
      if (on) {
        const s = await shield(t, "book");
        expect((await pub(t, "POST", "/api/book/ada-on", { startsAt: slots[1], name: "Guest", email: "g@x.io", shield: s })).status).toBe(201);
      }
    }
  });
});

describe("R92 resource rules (shared)", () => {
  const r = { days: ["mon", "tue"] as ("mon" | "tue")[], openFrom: "08:00", openTo: "18:00", stepMin: 30, minMin: 30, maxMin: 120 };
  it("checks day, hours, steps and lengths", () => {
    expect(ruleProblem(r, "mon", 9 * 60, 10 * 60)).toBeNull();
    expect(ruleProblem(r, "sun", 9 * 60, 10 * 60)).toMatch(/closed/);
    expect(ruleProblem(r, "mon", 7 * 60, 8 * 60)).toMatch(/between/);
    expect(ruleProblem(r, "mon", 9 * 60 + 10, 10 * 60)).toMatch(/steps/);
    expect(ruleProblem(r, "mon", 9 * 60, 12 * 60)).toMatch(/longest/);
    expect(ruleProblem(r, "mon", 10 * 60, 9 * 60)).toMatch(/after/);
    expect(rulesProblem({ ...r, days: [] })).toMatch(/day/);
    expect(rulesProblem({ ...r, openTo: "07:00" })).toMatch(/after/);
    expect(rulesProblem({ ...r, maxMin: 15 })).toBeTruthy();
    expect(rulesProblem(r)).toBeNull();
  });
  it("totals poll answers and picks the best time", () => {
    const totals = pollTotals(["a", "b", "c"], [{ answers: { a: "yes", b: "maybe", c: "no" } }, { answers: { a: "no", b: "yes", c: "no" } }, { answers: { b: "maybe", a: "yes" } }]);
    expect(totals.map((x) => x.score)).toEqual([4, 4, 0]);
    expect(bestOption(totals)).toBe("b"); // same score, fewer No answers
    expect(bestOption(pollTotals(["a"], []))).toBeNull();
  });
  it("formats, reads and guards ticket codes and CSV cells", () => {
    expect(formatTicketCode("abcd2345")).toBe("ABCD 2345");
    expect(normaliseTicketCode("ab-cd 0o2I")).toBe("ABCD0021");
    expect(readScan("https://multies.si/book/ticket/tkt_abc123xyz00?c=ABCD2345")).toEqual({ ticketId: "tkt_abc123xyz00", code: "ABCD2345" });
    expect(readScan("abcd 2345")).toEqual({ ticketId: null, code: "ABCD2345" });
    expect(readScan("hello")).toBeNull();
    expect(csvCell("=SUM(A1)")).toBe(`"'=SUM(A1)"`);
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
  it("writes a real PNG for mail", async () => {
    const png = await qrPng("https://multies.si/book/ticket/tkt_1?c=ABCD2345");
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.length).toBeGreaterThan(200);
  });
});

describe("R92 resources", () => {
  const sydney = { timezone: "Australia/Sydney", days: ["mon", "tue", "wed", "thu", "fri"], openFrom: "08:00", openTo: "18:00", stepMin: 30, minMin: 30, maxMin: 120 };
  // Monday 2 Nov 2026 in Sydney (UTC+11): 13:00 local is 02:00Z.
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 2, h - 11, m)).toISOString();

  it("admins add resources; members cannot; the grid shows the day", async () => {
    const t = await setup();
    const mate = await member(t);
    expect((await mate.post("/api/booking/resources", { name: "Room A", ...sydney })).status).toBe(403);
    const r = await t.owner.post("/api/booking/resources", { name: "Room A", kind: "room", capacity: 6, ...sydney });
    expect(r.status).toBe(201);
    expect(r.body.resource.checkinUrl).toContain("checkin=");
    expect((await t.owner.post("/api/booking/resources", { name: "Bad", ...sydney, openTo: "07:00" })).status).toBe(422);
    const list = await mate.get("/api/booking/resources");
    expect(list.body.resources[0].checkinUrl).toBeNull();
    const grid = await mate.get("/api/booking/grid?date=2026-11-02");
    expect(grid.body.resources[0].open.from).toBe(at(8));
    const sat = await mate.get("/api/booking/grid?date=2026-11-07");
    expect(sat.body.resources[0].open).toBeNull();
  });

  it("refuses overlaps, broken rules and quota overruns; cancel frees the slot", async () => {
    const t = await setup();
    const mate = await member(t);
    const res = (await t.owner.post("/api/booking/resources", { name: "Desk 1", kind: "desk", ...sydney, quotaMinWeek: 120 })).body.resource;
    const book = (c: Client, s: string, e: string) => c.post("/api/booking/resource-bookings", { resourceId: res.id, startsAt: s, endsAt: e });
    const a = await book(mate, at(13), at(14));
    expect(a.status).toBe(201);
    expect(a.body.booking.status).toBe("confirmed");
    expect((await book(t.owner, at(13, 30), at(14, 30))).body.error.code).toBe("slot_taken");
    expect((await book(mate, at(19), at(20))).body.error.code).toBe("rule_broken");
    expect((await book(mate, at(14, 10), at(15))).body.error.code).toBe("rule_broken");
    expect((await book(mate, at(15), at(16))).status).toBe(201);
    expect((await book(mate, at(16), at(16, 30))).body.error.code).toBe("quota_reached");
    expect((await t.owner.post(`/api/booking/resource-bookings/${a.body.booking.id}/cancel`)).status).toBe(200);
    expect((await book(t.owner, at(13), at(14))).status).toBe(201);
    const inbox = await mate.get("/api/booking/inbox");
    expect(inbox.body.mine).toHaveLength(1);
  });

  it("approval: members wait, admins decide and the member hears", async () => {
    const t = await setup();
    const mate = await member(t);
    const res = (await t.owner.post("/api/booking/resources", { name: "Van", kind: "vehicle", ...sydney, needsApproval: true })).body.resource;
    const b = (await mate.post("/api/booking/resource-bookings", { resourceId: res.id, startsAt: at(15), endsAt: at(16) })).body.booking;
    expect(b.status).toBe("pending");
    expect((await mate.post(`/api/booking/resource-bookings/${b.id}/decide`, { approve: true })).status).toBe(403);
    const inbox = await t.owner.get("/api/booking/inbox");
    expect(inbox.body.pending.map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect((await t.owner.post(`/api/booking/resource-bookings/${b.id}/decide`, { approve: true })).body.booking.status).toBe("confirmed");
    expect((await t.owner.post(`/api/booking/resource-bookings/${b.id}/decide`, { approve: false })).status).toBe(409);
  });

  it("checks in from the QR and releases no shows", async () => {
    const t = await setup();
    const mate = await member(t);
    const res = (await t.owner.post("/api/booking/resources", { name: "Room B", ...sydney, checkinRequired: true, releaseAfterMin: 15 })).body.resource;
    const key = new URL(res.checkinUrl).searchParams.get("k");
    const a = (await mate.post("/api/booking/resource-bookings", { resourceId: res.id, startsAt: at(11, 30), endsAt: at(12, 30) })).body.booking;
    const b = (await t.owner.post("/api/booking/resource-bookings", { resourceId: res.id, startsAt: at(13), endsAt: at(14) })).body.booking;
    expect((await mate.post(`/api/booking/resources/${res.id}/check-in`, { key: "wrong" })).status).toBe(403);
    t.advance(25 * 60_000); // 11:25, 5 minutes before the booking
    const ok = await mate.post(`/api/booking/resources/${res.id}/check-in`, { key });
    expect(ok.body.checkedIn).toBe(true);
    expect(ok.body.booking.id).toBe(a.id);
    t.advance(2 * 3600_000); // 13:25, owner never came
    const grid = await t.owner.get("/api/booking/grid?date=2026-11-02");
    const ids = grid.body.bookings.map((x: { id: string }) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect((await mate.post(`/api/booking/resources/${res.id}/check-in`, { key })).body.checkedIn).toBe(false);
  });
});

describe("R92 time polls", () => {
  it("guests vote without an account, edit their answer, and the host picks a winner that makes a meeting", async () => {
    const t = await setup();
    const opts = ["2026-11-05T01:00:00Z", "2026-11-05T03:00:00Z", "2026-11-06T01:00:00Z"];
    expect((await t.owner.post("/api/booking/polls", { title: "Sync", options: ["2020-01-01T00:00:00Z"] })).status).toBe(422);
    const created = await t.owner.post("/api/booking/polls", { title: "Quarterly sync", options: opts, timezone: "Australia/Sydney", durationMin: 45 });
    expect(created.status).toBe(201);
    const token = created.body.poll.url.split("/book/poll/")[1];
    const pubPoll = await pub(t, "GET", `/api/pub/booking/polls/${token}`);
    expect(pubPoll.body.poll.options).toHaveLength(3);
    expect(pubPoll.body.poll.url).toBeUndefined();
    const [o1, o2] = pubPoll.body.poll.options.map((o: { id: string }) => o.id);
    expect((await pub(t, "POST", `/api/pub/booking/polls/${token}/votes`, { name: "Bea", answers: { [o1]: "yes" } })).status).toBe(422);
    const v1 = await pub(t, "POST", `/api/pub/booking/polls/${token}/votes`, { name: "Bea", email: "bea@x.io", answers: { [o1]: "yes", [o2]: "no" }, shield: await shield(t, "poll") });
    expect(v1.status).toBe(201);
    const v2 = await pub(t, "POST", `/api/pub/booking/polls/${token}/votes`, { name: "Cal", email: "cal@x.io", answers: { [o1]: "maybe", [o2]: "yes" }, shield: await shield(t, "poll") });
    expect(v2.body.poll.votes[0].email).toBeUndefined();
    expect((await pub(t, "PUT", `/api/pub/booking/polls/${token}/votes/${v1.body.voteId}`, { editToken: "nope", name: "Bea", answers: { [o1]: "yes" } })).status).toBe(404);
    const edited = await pub(t, "PUT", `/api/pub/booking/polls/${token}/votes/${v1.body.voteId}`, { editToken: v1.body.editToken, name: "Bea", answers: { [o1]: "yes", [o2]: "yes" } });
    expect(edited.body.poll.best).toBe(o2);
    const detail = await t.owner.get(`/api/booking/polls/${created.body.poll.id}`);
    expect(detail.body.poll.votes[0].email).toBe("bea@x.io");
    const mate = await member(t);
    expect((await mate.post(`/api/booking/polls/${created.body.poll.id}/pick`, { optionId: o2 })).status).toBe(403);
    const picked = await t.owner.post(`/api/booking/polls/${created.body.poll.id}/pick`, { optionId: o2 });
    expect(picked.status).toBe(200);
    expect(picked.body.meetingId).toMatch(/^mtg_/);
    expect(picked.body.poll.status).toBe("closed");
    expect((await t.owner.post(`/api/booking/polls/${created.body.poll.id}/pick`, { optionId: o1 })).status).toBe(409);
    expect((await pub(t, "POST", `/api/pub/booking/polls/${token}/votes`, { name: "Late", answers: { [o1]: "yes" }, shield: await shield(t, "poll") })).status).toBe(409);
    const meeting = await t.owner.get(`/api/meetings/${picked.body.meetingId}`);
    if (meeting.status === 200) expect(JSON.stringify(meeting.body)).toContain("Quarterly sync");
  });
});

describe("R92 events", () => {
  async function event(t: T, extra: Record<string, unknown> = {}) {
    const r = await t.owner.post("/api/booking/events", { title: "Founders breakfast", startsAt: "2026-11-20T21:00:00Z", endsAt: "2026-11-20T23:00:00Z", timezone: "Australia/Sydney", capacity: 2, status: "published", location: "Level 3", ...extra });
    expect(r.status).toBe(201);
    return r.body.event;
  }
  const rsvp = async (t: T, slug: string, name: string, email: string) => pub(t, "POST", `/api/pub/booking/events/${slug}/rsvp`, { name, email, shield: await shield(t, "event") });

  it("drafts are hidden; capacity fills, the waitlist takes the rest and moves up on cancel", async () => {
    const t = await setup();
    const draft = await event(t, { status: "draft", title: "Draft thing" });
    expect((await pub(t, "GET", `/api/pub/booking/events/${draft.slug}`)).status).toBe(404);
    const e = await event(t);
    const a = await rsvp(t, e.slug, "Ann", "ann@x.io");
    expect(a.body.status).toBe("going");
    expect(a.body.url).toContain("/book/ticket/");
    await rsvp(t, e.slug, "Bo", "bo@x.io");
    const c = await rsvp(t, e.slug, "Cy", "cy@x.io");
    expect(c.body.status).toBe("waitlist");
    const view = await pub(t, "GET", `/api/pub/booking/events/${e.slug}`);
    expect(view.body.event).toMatchObject({ full: true, spotsLeft: 0, waitlistOpen: true });
    expect(view.body.event.id).toBeUndefined();
    const again = await rsvp(t, e.slug, "Ann", "ANN@x.io");
    expect(again.body).toEqual({ status: "resent" });
    expect((await pub(t, "GET", `/api/pub/booking/tickets/${a.body.ticketId}?c=${a.body.code}`)).status).toBe(200); // same code, mailed again
    expect((await pub(t, "GET", `/api/pub/booking/tickets/${a.body.ticketId}?c=ZZZZ2222`)).status).toBe(404);
    const bo = (await t.owner.get(`/api/booking/events/${e.id}`)).body.tickets.find((x: { email: string }) => x.email === "bo@x.io");
    expect(bo.status).toBe("going");
    const cTicket = await pub(t, "GET", `/api/pub/booking/tickets/${c.body.ticketId}?c=${c.body.code}`);
    expect(cTicket.body.ticket.status).toBe("waitlist");
    const d = await rsvp(t, e.slug, "Di", "di@x.io");
    expect(d.body.status).toBe("waitlist");
    await t.owner.patch(`/api/booking/events/${e.id}`, { capacity: 3 });
    const after = (await t.owner.get(`/api/booking/events/${e.id}`)).body;
    expect(after.event.going).toBe(3);
    expect(after.tickets.find((x: { email: string }) => x.email === "cy@x.io").status).toBe("going");
    expect((await t.owner.patch(`/api/booking/events/${e.id}`, { capacity: 1 })).status).toBe(422);
    const cancelled = await pub(t, "POST", `/api/pub/booking/tickets/${c.body.ticketId}/cancel`, { c: c.body.code });
    expect(cancelled.body.ticket.status).toBe("cancelled");
    const last = (await t.owner.get(`/api/booking/events/${e.id}`)).body;
    expect(last.tickets.find((x: { email: string }) => x.email === "di@x.io").status).toBe("going");
    expect(last.event).toMatchObject({ going: 3, waiting: 0 });
  });

  it("door check in by QR link or typed code, once, with undo; CSV export; members cannot change others' events", async () => {
    const t = await setup();
    const e = await event(t, { capacity: null });
    const a = await rsvp(t, e.slug, "Ann", "ann@x.io");
    const scan = readScan(a.body.url)!;
    const ci = (b: unknown) => t.owner.post(`/api/booking/events/${e.id}/check-in`, b);
    expect((await ci({ code: "ZZZZ2222" })).body.result).toBe("unknown");
    expect((await ci({ code: scan.code, ticketId: "tkt_other123456" })).body.result).toBe("unknown");
    expect((await ci({ code: scan.code, ticketId: scan.ticketId })).body.result).toBe("ok");
    expect((await ci({ code: formatTicketCode(scan.code) })).body.result).toBe("already");
    expect((await ci({ code: scan.code, undo: true })).body.result).toBe("undone");
    expect((await ci({ code: scan.code })).body.result).toBe("ok");
    expect((await t.owner.get(`/api/booking/events/${e.id}`)).body.event.checkedIn).toBe(1);
    const csv = await t.app.request(`/api/booking/events/${e.id}/attendees.csv`, { headers: { host: "localhost", cookie: t.owner.cookie } });
    const text = await csv.text();
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(text).toContain('"Ann","ann@x.io","Going"');
    const png = await t.app.request(`/api/pub/booking/tickets/${scan.ticketId}/qr.png?c=${scan.code}`, { headers: { host: "localhost" } });
    expect(png.headers.get("content-type")).toBe("image/png");
    const mate = await member(t);
    expect((await mate.patch(`/api/booking/events/${e.id}`, { title: "Mine now" })).status).toBe(403);
    expect((await mate.get("/api/booking/events")).body.events[0].mine).toBe(false);
    expect((await t.owner.del(`/api/booking/events/${e.id}`)).status).toBe(409);
    expect((await t.owner.post(`/api/booking/events/${e.id}/cancel`)).body.event.status).toBe("cancelled");
    expect((await rsvp(t, e.slug, "Late", "late@x.io")).status).toBe(409);
  });
});

describe("R92 flag off", () => {
  it("hides every Booking plus route while BOOKING_PLUS is off", async () => {
    const t = await setup({ SCHEDULING_ENABLED: "true", APP_URL: "http://localhost" });
    expect((await t.owner.get("/api/booking/resources")).status).toBe(404);
    expect((await pub(t, "GET", "/api/pub/booking/events/anything")).status).toBe(404);
    const cfg = await t.owner.get("/api/config");
    expect(cfg.body.bookingPlus).toBe(false);
  });
});

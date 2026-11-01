import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { chatPollItems, chatPollVotes, webinarRegistrations } from "@/server/db/schema";
import { clearCallCache, type CallParticipant } from "@/server/services/suite/calls";
import { clearLobbyLimits } from "@/server/services/suite/meeting-lobby-r32";
import { capText, clearWebinarLimits, csvCell, mailWhen, phaseOf, registrationAllowed, REG_IP_LIMIT, ROOM_PEOPLE_LIMIT, webinarCap } from "@/server/services/suite/webinar-r114";

/** R114: webinar mode for meetings. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40), WEBINAR_R114: "on" };
const START = new Date("2026-11-02T01:00:00.000Z").getTime();

async function setup(env: Record<string, string> = LK) {
  ctx = await makeTestApp(env);
  clock = START - 3600_000;
  ctx.deps.now = () => new Date((clock += 1000));
  clearCallCache(); clearLobbyLimits(); clearWebinarLimits();
  ctx.deps.callRooms = { list: async () => [] as CallParticipant[] };
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
}
beforeEach(async () => { await setup(); });

async function teammate(email: string, name: string, role: "member" | "admin" = "member") {
  const invite = await c.post("/api/team/invites", { email, role });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const me = (await m.get("/api/account/me")).body;
  return { client: m, id: me.user.id as string };
}
async function webinar(durationMin = 60, cl: Client = c) {
  const m = (await cl.post("/api/meetings", { title: "Product launch", startsAt: new Date(START).toISOString(), durationMin })).body.meeting;
  const r = await cl.patch(`/api/webinars/${m.id}`, { enabled: true });
  expect(r.status).toBe(200);
  const slug = (r.body.webinar.registrationUrl as string).split("/w/")[1];
  return { m, slug, w: r.body.webinar };
}
async function reg(slug: string, name: string, email: string, ip = "10.0.0.1") {
  const p = new Client(ctx.app);
  return p.call("POST", `/api/public/webinars/r/${slug}/register`, { name, email, website: "", openedAt: ctx.deps.now().getTime() - 5000 }, { "cf-connecting-ip": ip });
}
const tokenOf = (r: { body: { joinUrl: string } }) => r.body.joinUrl.split("/w/a/")[1];
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
const goLive = () => { clock = START + 60_000; };

describe("pure helpers", () => {
  it("works the cap out from the room limit and the free minutes", () => {
    expect(webinarCap({ minutesCap: 1000, minutesUsed: 0, durationMin: 60, stage: 1 })).toEqual({ cap: 15, by: "minutes", minutesLeft: 1000 });
    expect(webinarCap({ minutesCap: null, minutesUsed: 0, durationMin: 60, stage: 3 }).cap).toBe(ROOM_PEOPLE_LIMIT - 3);
    expect(webinarCap({ minutesCap: 1000, minutesUsed: 990, durationMin: 60, stage: 1 }).cap).toBe(0);
    expect(webinarCap({ minutesCap: 100000, minutesUsed: 0, durationMin: 30, stage: 1 })).toMatchObject({ cap: 99, by: "room" });
    expect(capText({ cap: 15, by: "minutes", minutesLeft: 1000 }, 60)).toBe("Up to 15 attendees on your plan. Each attendee uses call minutes, and your plan has 1000 left this month, enough for 15 people for 60 minutes.");
    expect(capText({ cap: 99, by: "room", minutesLeft: null }, 60)).toMatch(/^Up to 99 attendees on your plan\. Video rooms hold 100 people/);
  });
  it("knows the phase", () => {
    const m = { status: "scheduled", startsAt: new Date(START), durationMin: 60 };
    expect(phaseOf(m, new Date(START - 20 * 60_000))).toBe("upcoming");
    expect(phaseOf(m, new Date(START - 10 * 60_000))).toBe("open");
    expect(phaseOf(m, new Date(START + 95 * 60_000))).toBe("ended");
    expect(phaseOf({ ...m, status: "cancelled" }, new Date(START))).toBe("cancelled");
  });
  it("writes the start in the workspace time zone for the mail", () => {
    const at = new Date("2026-11-01T05:55:40Z");
    expect(mailWhen(at, "Australia/Sydney")).toBe("Sun 1 Nov 2026, 4:55 pm AEDT");
    expect(mailWhen(at, "UTC")).toBe("Sun 1 Nov 2026, 5:55 am UTC");
    expect(mailWhen(at, "Not/AZone")).toBe("Sun, 01 Nov 2026 05:55:40 GMT");
  });

  it("keeps spreadsheet cells plain", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe("");
  });
  it("limits registrations per address", () => {
    for (let i = 0; i < REG_IP_LIMIT; i++) expect(registrationAllowed("1.2.3.4", 1000)).toBe(true);
    expect(registrationAllowed("1.2.3.4", 2000)).toBe(false);
    expect(registrationAllowed("5.6.7.8", 2000)).toBe(true);
  });
});

describe("flag", () => {
  it("is off unless set", async () => {
    await setup({ ...LK, WEBINAR_R114: "" });
    const m = (await c.post("/api/meetings", { title: "x" })).body.meeting;
    expect((await c.get(`/api/webinars/${m.id}`)).status).toBe(404);
    expect((await new Client(ctx.app).get("/api/public/webinars/r/abc")).status).toBe(404);
    expect((await c.get("/api/config")).body.webinar ?? false).toBe(false);
  });
});

describe("settings and roles", () => {
  it("host turns it on with a registration link, the real cap and a Q&A", async () => {
    const { w } = await webinar(60);
    expect(w.enabled).toBe(true);
    expect(w.canManage).toBe(true);
    expect(w.registrationUrl).toMatch(/\/w\/[A-Za-z0-9]+$/);
    expect(w.cap.cap).toBe(15);
    expect(w.cap.text).toMatch(/^Up to 15 attendees on your plan\./);
    expect(w.registered).toBe(0);
  });
  it("only the host and admins change settings or read the report", async () => {
    const { m } = await webinar();
    const mem = await teammate("mem@acme.io", "Mo Member");
    const adm = await teammate("adm@acme.io", "Ada Admin", "admin");
    expect((await mem.client.patch(`/api/webinars/${m.id}`, { chatMode: "off" })).status).toBe(403);
    expect((await mem.client.get(`/api/webinars/${m.id}/report`)).status).toBe(403);
    expect((await mem.client.get(`/api/webinars/${m.id}/report.csv`)).status).toBe(403);
    expect((await mem.client.get(`/api/webinars/${m.id}/live`)).status).toBe(403);
    const seen = (await mem.client.get(`/api/webinars/${m.id}`)).body.webinar;
    expect(seen.canManage).toBe(false);
    expect(seen.registered).toBeNull();
    expect((await adm.client.patch(`/api/webinars/${m.id}`, { chatMode: "hosts" })).body.webinar.chatMode).toBe("hosts");
    expect((await adm.client.get(`/api/webinars/${m.id}/report`)).status).toBe(200);
  });
  it("hosts and panelists speak, other members and guests watch", async () => {
    const { m } = await webinar();
    goLive();
    const mem = await teammate("mem@acme.io", "Mo Member");
    const host = (await c.post(`/api/meetings/${m.id}/join`, {})).body;
    expect(host.webinarRole).toBe("host");
    expect(claims(host.token).video.canPublish).toBe(true);
    let j = (await mem.client.post(`/api/meetings/${m.id}/join`, {})).body;
    expect(j.webinarRole).toBe("attendee");
    expect(claims(j.token).video.canPublish).toBe(false);
    expect(claims(j.token).video.canPublishData).toBe(false);
    expect((await c.post(`/api/webinars/${m.id}/panelists`, { kind: "member", id: mem.id, on: true })).status).toBe(200);
    j = (await mem.client.post(`/api/meetings/${m.id}/join`, {})).body;
    expect(j.webinarRole).toBe("panelist");
    expect(claims(j.token).video.canPublish).toBe(true);
    expect((await mem.client.post(`/api/webinars/${m.id}/panelists`, { kind: "member", id: mem.id, on: false })).status).toBe(403);
    await c.post(`/api/webinars/${m.id}/panelists`, { kind: "member", id: mem.id, on: false });
    expect(claims((await mem.client.post(`/api/meetings/${m.id}/join`, {})).body.token).video.canPublish).toBe(false);
  });
  it("a plain meeting keeps everyone speaking", async () => {
    const m = (await c.post("/api/meetings", { title: "Stand up" })).body.meeting;
    const mem = await teammate("mem@acme.io", "Mo Member");
    const j = (await mem.client.post(`/api/meetings/${m.id}/join`, {})).body;
    expect(j.webinarRole).toBeNull();
    expect(claims(j.token).video.canPublish).toBe(true);
  });
});

describe("registration", () => {
  it("registers, mails a personal link and shows the page", async () => {
    const { slug } = await webinar();
    const info = (await new Client(ctx.app).get(`/api/public/webinars/r/${slug}`)).body;
    expect(info).toMatchObject({ title: "Product launch", phase: "upcoming", registrationOpen: true, full: false, capText: "Up to 15 attendees." });
    expect(JSON.stringify(info)).not.toMatch(/@/);
    const r = await reg(slug, "Rita Reader", "rita@example.com");
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("registered");
    const row = (await ctx.deps.db.select().from(webinarRegistrations).all())[0];
    expect(row.tokenHash).not.toBe(tokenOf(r));
    expect(row.tokenHash).toHaveLength(64);
  });
  it("a second registration with the same email shows no link and mails it again", async () => {
    const { slug } = await webinar();
    const first = await reg(slug, "Rita", "rita@example.com");
    const again = await reg(slug, "Someone else", "RITA@example.com", "10.0.0.2");
    expect(again.status).toBe(201);
    expect(again.body.status).toBe("already");
    expect(again.body.joinUrl).toBeUndefined();
    // The old link stops working: a new one went to the inbox.
    expect((await new Client(ctx.app).get(`/api/public/webinars/a/${tokenOf(first)}`)).status).toBe(404);
    expect(await ctx.deps.db.select().from(webinarRegistrations).all()).toHaveLength(1);
  });
  it("refuses bots, closed and ended webinars, bad emails and too many from one address", async () => {
    const { m, slug } = await webinar();
    const p = new Client(ctx.app);
    const now = () => ctx.deps.now().getTime();
    expect((await p.post(`/api/public/webinars/r/${slug}/register`, { name: "B", email: "b@example.com", website: "spam", openedAt: now() - 5000 })).body.error.code).toBe("bot_check");
    expect((await p.post(`/api/public/webinars/r/${slug}/register`, { name: "B", email: "b@example.com", openedAt: now() })).body.error.code).toBe("bot_check");
    expect((await reg(slug, "B", "not an email")).status).toBe(422);
    expect((await reg(slug, "", "b@example.com")).status).toBe(422);
    clearWebinarLimits();
    for (let i = 0; i < REG_IP_LIMIT; i++) expect((await reg(slug, `P${i}`, `p${i}@example.com`, "9.9.9.9")).status).toBe(201);
    expect((await reg(slug, "Q", "q@example.com", "9.9.9.9")).status).toBe(429);
    await c.patch(`/api/webinars/${m.id}`, { registrationOpen: false });
    expect((await reg(slug, "Z", "z@example.com", "8.8.8.8")).body.error.code).toBe("registration_closed");
    await c.patch(`/api/webinars/${m.id}`, { registrationOpen: true });
    await c.patch(`/api/meetings/${m.id}`, { status: "ended" });
    expect((await reg(slug, "Z", "z@example.com", "8.8.8.7")).body.error.code).toBe("webinar_ended");
  });
  it("says full when the cap is reached", async () => {
    const { slug } = await webinar(480);
    expect((await new Client(ctx.app).get(`/api/public/webinars/r/${slug}`)).body.capText).toBe("Up to 1 attendees.");
    expect((await reg(slug, "One", "one@example.com")).status).toBe(201);
    const full = await reg(slug, "Two", "two@example.com", "10.0.0.9");
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("webinar_full");
    expect((await new Client(ctx.app).get(`/api/public/webinars/r/${slug}`)).body.full).toBe(true);
  });
  it("a turned off webinar has no public page", async () => {
    const { m, slug } = await webinar();
    await c.patch(`/api/webinars/${m.id}`, { enabled: false });
    expect((await new Client(ctx.app).get(`/api/public/webinars/r/${slug}`)).status).toBe(404);
  });
});

describe("attendee", () => {
  it("watches only, asks, upvotes, votes and chats; never sees emails", async () => {
    const { m, slug } = await webinar();
    const a = tokenOf(await reg(slug, "Rita Reader", "rita@example.com"));
    const b = tokenOf(await reg(slug, "Ben Buyer", "ben@example.com", "10.0.0.3"));
    const A = new Client(ctx.app), B = new Client(ctx.app);
    expect((await A.post(`/api/public/webinars/a/${a}/join`)).body.error.code).toBe("not_started");
    expect((await A.post(`/api/public/webinars/a/${a}/questions`, { body: "Early?" })).status).toBe(409);
    goLive();
    const j = (await A.post(`/api/public/webinars/a/${a}/join`)).body;
    expect(j.role).toBe("attendee");
    expect(claims(j.token).video.canPublish).toBe(false);
    expect(claims(j.token).sub).toMatch(/^reg-/);
    let s = (await A.post(`/api/public/webinars/a/${a}/questions`, { body: "  Will there be a replay?  " })).body;
    expect(s.questions[0]).toMatchObject({ body: "Will there be a replay?", mine: true, authorName: "Rita Reader" });
    expect((await A.post(`/api/public/webinars/a/${a}/questions`, { body: "Again" })).status).toBe(429);
    const qid = s.questions[0].id;
    expect((await A.post(`/api/public/webinars/a/${a}/questions/${qid}/upvote`)).status).toBe(422);
    s = (await B.post(`/api/public/webinars/a/${b}/questions/${qid}/upvote`)).body;
    expect(s.questions[0]).toMatchObject({ votes: 1, upvoted: true, mine: false });
    // the question lands in the R96 Q&A tables
    const item = (await ctx.deps.db.select().from(chatPollItems).where(eq(chatPollItems.id, qid)).get())!;
    expect(item.authorId).toMatch(/^reg:/);
    // host runs a poll; results show after voting
    const poll = (await c.post(`/api/webinars/${m.id}/polls`, { question: "Which plan?", options: ["Free", "Pro"] })).body.poll;
    s = (await A.get(`/api/public/webinars/a/${a}`)).body;
    expect(s.polls[0]).toMatchObject({ id: poll.id, open: true, voted: false, results: null });
    expect((await A.post(`/api/public/webinars/a/${a}/polls/${poll.id}/vote`, { choices: ["5"] })).status).toBe(422);
    s = (await A.post(`/api/public/webinars/a/${a}/polls/${poll.id}/vote`, { choices: ["1"] })).body;
    expect(s.polls[0].results).toEqual([{ label: "Free", count: 0 }, { label: "Pro", count: 1 }]);
    expect((await ctx.deps.db.select().from(chatPollVotes).where(eq(chatPollVotes.pollId, poll.id)).all()).map((v) => v.voter)[0]).toMatch(/^reg:/);
    s = (await B.post(`/api/public/webinars/a/${b}/chat`, { body: "Hello from Ben" })).body;
    expect(s.chat.at(-1)).toMatchObject({ authorName: "Ben Buyer", body: "Hello from Ben", host: false });
    expect(JSON.stringify(s)).not.toMatch(/example\.com/);
    await c.post(`/api/webinars/${m.id}/polls/${poll.id}/close`);
    clock += 4000;
    expect((await B.post(`/api/public/webinars/a/${b}/polls/${poll.id}/vote`, { choices: ["0"] })).body.error.code).toBe("poll_closed");
    expect((await B.get(`/api/public/webinars/a/${b}`)).body.polls[0].results[1].count).toBe(1);
  });
  it("host hides, answers and moderates chat", async () => {
    const { m, slug } = await webinar();
    goLive();
    const a = tokenOf(await reg(slug, "Rita", "rita@example.com"));
    const b = tokenOf(await reg(slug, "Ben", "ben@example.com", "10.0.0.3"));
    const A = new Client(ctx.app), B = new Client(ctx.app);
    const q1 = (await A.post(`/api/public/webinars/a/${a}/questions`, { body: "Rude question" })).body.questions[0].id;
    clock += 11_000;
    const q2 = (await A.post(`/api/public/webinars/a/${a}/questions`, { body: "Pricing?" })).body.questions.find((q: { body: string }) => q.body === "Pricing?").id;
    const mem = await teammate("mem@acme.io", "Mo Member");
    expect((await mem.client.post(`/api/webinars/${m.id}/questions/${q1}`, { hidden: true })).status).toBe(403);
    await c.post(`/api/webinars/${m.id}/questions/${q1}`, { hidden: true });
    await c.post(`/api/webinars/${m.id}/questions/${q2}`, { answer: "Free for 3 people" });
    clock += 4000;
    let sb = (await B.get(`/api/public/webinars/a/${b}`)).body;
    expect(sb.questions.map((q: { body: string }) => q.body)).toEqual(["Pricing?"]);
    expect(sb.questions[0]).toMatchObject({ answered: true, answer: "Free for 3 people" });
    const sa = (await A.get(`/api/public/webinars/a/${a}`)).body;
    expect(sa.questions.find((q: { id: string }) => q.id === q1)).toMatchObject({ hidden: true, mine: true });
    const live = (await c.get(`/api/webinars/${m.id}/live`)).body;
    expect(live.questions.find((q: { id: string }) => q.id === q1).hidden).toBe(true);
    // chat: hide a message, hosts only, off
    await B.post(`/api/public/webinars/a/${b}/chat`, { body: "spam spam" });
    const msg = (await c.get(`/api/webinars/${m.id}/live`)).body.chat.at(-1);
    await c.post(`/api/webinars/${m.id}/chat/${msg.id}/hide`, { hidden: true });
    clock += 4000;
    sb = (await B.get(`/api/public/webinars/a/${b}`)).body;
    expect(sb.chat.find((x: { body: string }) => x.body === "spam spam")).toBeUndefined();
    await c.patch(`/api/webinars/${m.id}`, { chatMode: "hosts" });
    clock += 4000;
    expect((await B.post(`/api/public/webinars/a/${b}/chat`, { body: "hi" })).body.error.code).toBe("chat_hosts_only");
    expect((await c.post(`/api/webinars/${m.id}/chat`, { body: "Welcome all" })).status).toBe(201);
    await c.patch(`/api/webinars/${m.id}`, { chatMode: "off" });
    clock += 4000;
    expect((await B.post(`/api/public/webinars/a/${b}/chat`, { body: "hi" })).body.error.code).toBe("chat_off");
    expect((await B.get(`/api/public/webinars/a/${b}`)).body.chat).toEqual([]);
  });
  it("a promoted registrant gets a speaking token", async () => {
    const { m, slug } = await webinar();
    goLive();
    const a = tokenOf(await reg(slug, "Rita", "rita@example.com"));
    const regId = (await ctx.deps.db.select().from(webinarRegistrations).all())[0].id;
    await c.post(`/api/webinars/${m.id}/panelists`, { kind: "registrant", id: regId, on: true });
    const j = (await new Client(ctx.app).post(`/api/public/webinars/a/${a}/join`)).body;
    expect(j.role).toBe("panelist");
    expect(claims(j.token).video.canPublish).toBe(true);
  });
  it("guests from the meeting link watch only in a webinar", async () => {
    const { m } = await webinar();
    goLive();
    await c.patch(`/api/meeting-lobby/${m.id}/guests-wait`, { guestsWait: false });
    const token = m.guestUrl.split("/m/")[1];
    const g = await new Client(ctx.app).post(`/api/public/meetings/${token}/join`, { name: "Gail Guest" });
    if (g.status === 200) expect(claims(g.body.token).video.canPublish).toBe(false);
  });
});

describe("report and replay", () => {
  it("counts registered, attended, minutes and questions, with a CSV", async () => {
    const { m, slug } = await webinar();
    goLive();
    const a = tokenOf(await reg(slug, "=Rita", "rita@example.com"));
    await reg(slug, "Ben", "ben@example.com", "10.0.0.3");
    const A = new Client(ctx.app);
    await A.post(`/api/public/webinars/a/${a}/join`);
    clock += 61_000;
    expect((await A.post(`/api/public/webinars/a/${a}/heartbeat`)).body.counted).toBe(true);
    expect((await A.post(`/api/public/webinars/a/${a}/heartbeat`)).body.counted).toBe(false);
    clock += 61_000;
    await A.post(`/api/public/webinars/a/${a}/heartbeat`);
    await A.post(`/api/public/webinars/a/${a}/questions`, { body: "How much?" });
    const poll = (await c.post(`/api/webinars/${m.id}/polls`, { question: "Useful?", options: ["Yes", "No"] })).body.poll;
    await A.post(`/api/public/webinars/a/${a}/polls/${poll.id}/vote`, { choices: ["0"] });
    const r = (await c.get(`/api/webinars/${m.id}/report`)).body;
    expect(r.totals).toMatchObject({ registered: 2, attended: 1, averageMinutes: 2, questions: 1, answered: 0 });
    expect(r.people[0]).toMatchObject({ name: "=Rita", email: "rita@example.com", attended: true, minutesWatched: 2, questions: 1 });
    expect(r.polls[0].results).toEqual([{ label: "Yes", count: 1 }, { label: "No", count: 0 }]);
    const csv = await c.get(`/api/webinars/${m.id}/report.csv`);
    expect(csv.status).toBe(200);
    const text = String(csv.body);
    expect(text).toContain("Name,Email,Registered at,Attended,First joined,Minutes watched,Questions asked");
    expect(text).toContain("'=Rita,rita@example.com");
    expect(text).toContain("Useful?,Yes,1");
  });
  it("shares a finished recording as the replay", async () => {
    const { m, slug } = await webinar();
    const a = tokenOf(await reg(slug, "Rita", "rita@example.com"));
    const A = new Client(ctx.app);
    expect((await A.get(`/api/public/webinars/a/${a}/replay`)).status).toBe(404);
    expect((await c.put(`/api/webinars/${m.id}/replay`, { recordingId: "nope", shared: true })).status).toBe(404);
    expect((await c.put(`/api/webinars/${m.id}/replay`, { recordingId: null, shared: true })).status).toBe(422);
    const { meetingRecordings } = await import("@/server/db/schema");
    const t = ctx.deps.now();
    await ctx.deps.db.insert(meetingRecordings).values({ orgId: (await ctx.deps.db.select().from((await import("@/server/db/schema")).meetings).all())[0].orgId, meetingId: m.id, id: "rec1", startedBy: "u", status: "done", startedAt: t, endedAt: t, durationSec: 1800, transcript: "[00:00] Hello all", summary: JSON.stringify({ summary: "We launched.", decisions: ["Ship Friday"], actionItems: [] }) });
    expect((await c.put(`/api/webinars/${m.id}/replay`, { recordingId: "rec1", shared: true })).status).toBe(200);
    const r = (await A.get(`/api/public/webinars/a/${a}/replay`)).body;
    expect(r).toMatchObject({ title: "Product launch", summary: "We launched.", decisions: ["Ship Friday"], transcript: "[00:00] Hello all" });
    expect((await A.get(`/api/public/webinars/a/${a}`)).body.replay).toBe(true);
  });
});

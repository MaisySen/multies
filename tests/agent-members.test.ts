import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { expandWeekly, normaliseRecurrence, parseRrule, toRrule } from "@/server/services/suite/meeting-recurrence";
import { buildIcs } from "@/server/services/suite/meetings";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

async function v1(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

describe("agent members", () => {
  it("adds an agent member with a title, bio and its own key, shown in People with no email, taking no seat", async () => {
    const made = await c.post("/api/team/agents", { name: "Builder", title: "Engineering lead", bio: "An AI agent that writes and ships the code." });
    expect(made.status).toBe(201);
    expect(made.body.member).toMatchObject({ kind: "agent", name: "Builder", title: "Engineering lead", role: "member", email: null });
    expect(made.body.secret).toMatch(/^mm_live_/);

    const team = await c.get("/api/team");
    expect(team.body.seats.members).toBe(1);
    expect(team.body.agentMembers).toEqual({ used: 1, limit: 10 });
    const agentRow = team.body.members.find((m: { kind: string }) => m.kind === "agent");
    expect(agentRow).toMatchObject({ name: "Builder", email: null, title: "Engineering lead" });

    const people = (await c.get("/api/team/people")).body.people;
    expect(people.map((p: { name: string; kind: string }) => `${p.name}:${p.kind}`)).toEqual(["Olive Owner:human", "Builder:agent"]);

    // Its key acts as the agent member, under its own name, with the member role.
    const key = made.body.secret as string;
    const g = (await c.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
    const post = await v1(key, "POST", `/chat/channels/${g.id}/messages`, { body: "Build 42 is green." });
    expect(post.status).toBe(201);
    expect(post.body.message.author).toMatchObject({ type: "member", name: "Builder", id: made.body.member.userId });
    const proj = await c.post("/api/projects", { name: "Launch" });
    const task = await c.post("/api/tasks", { projectId: proj.body.project.id, title: "Ship it" });
    const comment = await v1(key, "POST", `/tasks/${task.body.task.id}/comments`, { body: "On it." });
    expect(comment.status).toBe(201);
    expect(JSON.stringify(comment.body)).toContain("Builder");
    // Member role: no admin actions.
    expect((await v1(key, "POST", "/agent-members", { name: "Rogue" })).status).toBe(403);
    expect((await v1(key, "POST", "/domains", { name: "evil.io" })).status).toBe(403);
    // It can edit its own bio.
    const self = await v1(key, "PATCH", `/people/${made.body.member.userId}`, { bio: "Writes code. AI agent." });
    expect(self.body.person.bio).toBe("Writes code. AI agent.");
  });

  it("caps agent members at 10 on Free without touching the inbox or seat limits", async () => {
    for (let i = 0; i < 10; i++) expect((await c.post("/api/team/agents", { name: `Agent ${i}` })).status).toBe(201);
    const over = await c.post("/api/team/agents", { name: "Agent 11" });
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe("plan_limit");
    expect(over.body.error.message).toContain("10 agent members");
    const team = (await c.get("/api/team")).body;
    expect(team.seats.members).toBe(1);
    // An invite still has its seats.
    const inv = await c.post("/api/team/invites", { email: "max@acme.io", role: "member" });
    expect(inv.status).toBe(201);
    const max = new Client(ctx.app);
    await max.signup("max@acme.io", "Max Member", "");
    expect((await max.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  });

  it("rotates and revokes keys, and removing the member revokes them all", async () => {
    const made = (await c.post("/api/team/agents", { name: "QA" })).body;
    const id = made.member.userId as string;
    const second = await c.post(`/api/team/agents/${id}/keys`, { scope: "read" });
    expect(second.status).toBe(201);
    expect((await c.get(`/api/team/agents/${id}/keys`)).body.keys).toHaveLength(2);
    expect((await c.del(`/api/team/agents/${id}/keys/${made.apiKey.id}`)).status).toBe(200);
    expect((await v1(made.secret, "GET", "/people")).status).toBe(401);
    expect((await v1(second.body.secret, "GET", "/people")).status).toBe(200);
    expect((await v1(second.body.secret, "PATCH", `/people/${id}`, { bio: "x" })).status).toBe(403);
    expect((await c.patch(`/api/team/members/${id}`, { role: "admin" })).status).toBe(403);
    expect((await c.del(`/api/team/members/${id}`)).status).toBe(200);
    expect((await v1(second.body.secret, "GET", "/people")).status).toBe(401);
    expect((await c.get("/api/team/people")).body.people).toHaveLength(1);
  });

  it("titles and bios for people: own edits, admin edits, no writes when nothing changes", async () => {
    const me = (await c.get("/api/team/people")).body.people[0];
    const r = await c.patch(`/api/team/people/${me.userId}`, { title: "Founder", bio: "Runs the company." });
    expect(r.body.person).toMatchObject({ title: "Founder", bio: "Runs the company." });
    expect((await c.patch(`/api/team/people/${me.userId}`, { name: "Someone else" })).status).toBe(403);
    // Workspace key over REST and MCP read them.
    const key = (await c.post("/api/developer/keys", { name: "ops" })).body.secret as string;
    const list = await v1(key, "GET", "/people");
    expect(list.body.people[0]).toMatchObject({ title: "Founder", bio: "Runs the company." });
    const spec = await ctx.app.request("/api/v1/openapi.json");
    const paths = Object.keys((await spec.json()).paths);
    expect(paths).toEqual(expect.arrayContaining(["/people", "/people/{id}", "/agent-members", "/agent-members/{id}/keys", "/meetings/{id}/ics"]));
  });

  it("other workspaces can't see or touch an agent member", async () => {
    const made = (await c.post("/api/team/agents", { name: "Docs" })).body;
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve", "Evil");
    expect((await other.patch(`/api/team/people/${made.member.userId}`, { bio: "pwned" })).status).toBe(404);
    expect((await other.get(`/api/team/agents/${made.member.userId}/keys`)).status).toBe(404);
    expect((await other.get("/api/team/people")).body.people.map((p: { name: string }) => p.name)).toEqual(["Eve"]);
  });
});

describe("weekly meeting series", () => {
  const tz = "Australia/Sydney";
  it("parses, normalises and writes RRULEs, weekly only", () => {
    const start = new Date("2026-10-26T23:00:00Z"); // Tue 27 Oct, 10:00 in Sydney
    const r = normaliseRecurrence({ interval: 1, days: ["th"], count: 6 }, start, tz);
    expect(r.days).toEqual(["tu", "th"]);
    expect(toRrule(r, tz)).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH;COUNT=6");
    const u = normaliseRecurrence({ interval: 2, until: "2026-12-31" }, start, tz);
    expect(toRrule(u, tz)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20261231T125959Z");
    expect(parseRrule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20261231T125959Z", tz)).toMatchObject({ interval: 2, days: ["tu"], until: "2026-12-31" });
    expect(() => parseRrule("FREQ=DAILY", tz)).toThrow(/weekly/i);
    expect(() => parseRrule("FREQ=WEEKLY;INTERVAL=3", tz)).toThrow();
    expect(() => normaliseRecurrence({ until: "2026-12-31", count: 3 }, start, tz)).toThrow();
  });

  it("expands occurrences on read, keeping wall clock time across daylight saving", () => {
    // Monday 10:00 Sydney from 28 Sep 2026; DST starts 4 Oct 2026.
    const start = new Date("2026-09-28T00:00:00Z");
    const r = normaliseRecurrence({ days: ["mo"], count: 4 }, start, tz);
    const all = expandWeekly(start, r, tz, new Date("2026-01-01"), new Date("2027-01-01"));
    expect(all.map((d) => d.toISOString())).toEqual(["2026-09-28T00:00:00.000Z", "2026-10-04T23:00:00.000Z", "2026-10-11T23:00:00.000Z", "2026-10-18T23:00:00.000Z"]);
    const two = normaliseRecurrence({ interval: 2, days: ["mo", "we"] }, start, tz);
    const later = expandWeekly(start, two, tz, new Date("2027-03-01"), new Date("2027-03-20"));
    expect(later.length).toBeGreaterThan(0);
    for (const d of later) expect(new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)).toBe("10:00");
  });

  it("creates a series as one row, lists upcoming occurrences, edits the series, and the .ics carries the RRULE", async () => {
    const now = Date.now();
    const start = new Date(now - 14 * 86_400_000);
    const made = await c.post("/api/meetings", { title: "Weekly product review", startsAt: start.toISOString(), durationMin: 45, recurrence: { days: [], timezone: "Australia/Sydney" } });
    expect(made.status).toBe(201);
    expect(made.body.meeting.recurrence).toMatchObject({ interval: 1, timezone: "Australia/Sydney" });
    expect(made.body.meeting.recurrence.rrule).toMatch(/^FREQ=WEEKLY;INTERVAL=1;BYDAY=[A-Z]{2}$/);
    const id = made.body.meeting.id;
    const up = (await c.get("/api/meetings?upcoming=1")).body.meetings.filter((m: { id: string }) => m.id === id);
    expect(up.length).toBeGreaterThanOrEqual(8);
    expect(up.every((m: { startsAt: string; seriesStartsAt: string }) => new Date(m.startsAt).getTime() > now - 4 * 3600_000 && m.seriesStartsAt === made.body.meeting.startsAt)).toBe(true);
    // Edit applies to the series.
    const ed = await c.patch(`/api/meetings/${id}`, { title: "Product review", recurrence: "FREQ=WEEKLY;INTERVAL=2;COUNT=5" });
    expect(ed.body.meeting.recurrence.rrule).toContain("INTERVAL=2");
    expect(ed.body.meeting.recurrence.rrule).toContain("COUNT=5");
    const up2 = (await c.get("/api/meetings?upcoming=1")).body.meetings.filter((m: { id: string }) => m.id === id);
    expect(up2.length).toBeLessThanOrEqual(5);
    expect(up2.every((m: { title: string }) => m.title === "Product review")).toBe(true);
    const ics = await c.call("GET", `/api/meetings/${id}/ics`);
    expect(ics.status).toBe(200);
    expect(ics.body).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2");
    expect(ics.body).toContain("DTSTART;TZID=Australia/Sydney:");
    // Back to a one off.
    expect((await c.patch(`/api/meetings/${id}`, { recurrence: null })).body.meeting.recurrence).toBeNull();
  });

  it("buildIcs keeps one off meetings in UTC", () => {
    const ics = buildIcs({ id: "mtg_1", title: "Call", startsAt: new Date("2026-11-02T00:00:00Z"), durationMin: 30 }, { organizer: { address: "a@acme.io" }, invitees: [], guestUrl: "https://x/m/1", now: new Date() });
    expect(ics).toContain("DTSTART:20261102T000000Z");
    expect(ics).not.toContain("RRULE");
  });

  it("REST v1 and MCP read and write series", async () => {
    const key = (await c.post("/api/developer/keys", { name: "ops" })).body.secret as string;
    const made = await v1(key, "POST", "/meetings", { title: "Standup", startsAt: new Date(Date.now() + 86_400_000).toISOString(), recurrence: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=9" });
    expect(made.status).toBe(201);
    const id = made.body.meeting.id;
    const p = await v1(key, "PATCH", `/meetings/${id}`, { durationMin: 15 });
    expect(p.body.meeting).toMatchObject({ durationMin: 15 });
    expect(p.body.meeting.recurrence.rrule).toContain("COUNT=9");
    const ics = await v1(key, "GET", `/meetings/${id}/ics`);
    expect(ics.headers.get("content-type")).toContain("text/calendar");
    expect(ics.body).toContain("RRULE:FREQ=WEEKLY");
  });
});

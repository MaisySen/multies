import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

async function v1(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
import { buildIcs } from "@/server/services/suite/meetings";
import { transitionsInYear, vtimezone, zoneOffsetMin } from "@/server/services/suite/vtimezone";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

describe("VTIMEZONE in the .ics", () => {
  it("writes yearly STANDARD and DAYLIGHT rules for a zone with daylight saving", () => {
    expect(zoneOffsetMin(new Date("2026-01-10T00:00:00Z"), "Australia/Sydney")).toBe(660);
    expect(transitionsInYear(2025, "Australia/Sydney").map((t) => [t.at.toISOString(), t.from, t.to])).toEqual([["2025-04-05T16:00:00.000Z", 660, 600], ["2025-10-04T16:00:00.000Z", 600, 660]]);
    const lines = vtimezone("Australia/Sydney", new Date("2026-10-26T00:00:00Z"));
    expect(lines).toEqual(["BEGIN:VTIMEZONE", "TZID:Australia/Sydney",
      "BEGIN:STANDARD", "DTSTART:20250406T030000", "TZOFFSETFROM:+1100", "TZOFFSETTO:+1000", "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:20251005T020000", "TZOFFSETFROM:+1000", "TZOFFSETTO:+1100", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU", "END:DAYLIGHT", "END:VTIMEZONE"]);
    expect(vtimezone("Europe/London", new Date("2026-06-01T00:00:00Z"))).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU");
    expect(vtimezone("America/New_York", new Date("2026-06-01T00:00:00Z"))).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU");
  });

  it("writes one STANDARD part for a zone without daylight saving, and nothing for an unknown zone", () => {
    expect(vtimezone("Asia/Kathmandu", new Date("2026-06-01T00:00:00Z"))).toEqual(["BEGIN:VTIMEZONE", "TZID:Asia/Kathmandu", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0545", "TZOFFSETTO:+0545", "END:STANDARD", "END:VTIMEZONE"]);
    expect(vtimezone("Mars/Base", new Date())).toEqual([]);
  });

  it("puts the VTIMEZONE before the event in a series .ics, and leaves one-off meetings in UTC", async () => {
    const now = new Date("2026-10-24T00:00:00Z");
    const base = { id: "mtg_1", title: "Review", startsAt: new Date("2026-10-25T23:00:00Z"), durationMin: 30 };
    const opts = { organizer: { address: "a@acme.io" }, invitees: [], guestUrl: "https://x.test/m/t", now };
    const series = buildIcs({ ...base, recurrence: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", recurrenceTz: "Australia/Sydney" }, opts);
    expect(series.indexOf("BEGIN:VTIMEZONE")).toBeGreaterThan(0);
    expect(series.indexOf("BEGIN:VTIMEZONE")).toBeLessThan(series.indexOf("BEGIN:VEVENT"));
    expect(series).toContain("TZID:Australia/Sydney\r\n");
    expect(series).toContain("DTSTART;TZID=Australia/Sydney:20261026T100000");
    expect(buildIcs(base, opts)).not.toContain("VTIMEZONE");

    const made = await c.post("/api/meetings", { title: "Weekly product review", startsAt: "2026-10-25T23:00:00.000Z", durationMin: 45, recurrence: { days: ["mo"], timezone: "Australia/Sydney" } });
    const res = await ctx.app.request(`/api/meetings/${made.body.meeting.id}/ics`, { headers: { host: "localhost", cookie: c.cookie } });
    const text = await res.text();
    expect(text).toContain("BEGIN:VTIMEZONE");
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU");
  });
});

describe("dashboard team count", () => {
  it("counts people and AI agent members apart, and an agent does not count as inviting the team", async () => {
    expect((await c.get("/api/dashboard")).body.team).toEqual({ members: 1, agents: 0 });
    expect((await c.post("/api/team/agents", { name: "Builder", title: "Engineering lead", bio: "An AI agent." })).status).toBe(201);
    expect((await c.post("/api/team/agents", { name: "QA", title: "Quality", bio: "An AI agent." })).status).toBe(201);
    const d = (await c.get("/api/dashboard")).body;
    expect(d.team).toEqual({ members: 1, agents: 2 });
    expect(d.onboarding.steps.teamInvited).toBe(false);
  });
});

describe("pinned chat messages", () => {
  it("pins and unpins top level messages, lists them, and refuses replies", async () => {
    const g = (await c.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
    const m = (await c.post(`/api/chat/channels/${g.id}/messages`, { body: "Welcome. Read the handbook first." })).body.message;
    const reply = (await c.post(`/api/chat/channels/${g.id}/messages`, { body: "Thanks", parentId: m.id })).body.message;
    const pinned = await c.post(`/api/chat/messages/${m.id}/pin`);
    expect(pinned.status).toBe(200);
    expect(pinned.body.message).toMatchObject({ pinnedBy: "Olive Owner" });
    expect(pinned.body.message.pinnedAt).toBeTruthy();
    expect((await c.post(`/api/chat/messages/${m.id}/pin`)).status).toBe(200);
    expect((await c.post(`/api/chat/messages/${reply.id}/pin`)).status).toBe(422);
    const pins = (await c.get(`/api/chat/channels/${g.id}/pins`)).body.pins;
    expect(pins.map((p: { id: string }) => p.id)).toEqual([m.id]);
    const list = (await c.get(`/api/chat/channels/${g.id}/messages`)).body.messages;
    expect(list.find((x: { id: string }) => x.id === m.id).pinnedAt).toBeTruthy();
    expect((await c.del(`/api/chat/messages/${m.id}/pin`)).body.message.pinnedAt).toBeNull();
    expect((await c.get(`/api/chat/channels/${g.id}/pins`)).body.pins).toEqual([]);
  });
});

describe("round 12 public API routes", () => {
  it("updates a channel, pins a message, creates templates from scratch and deletes a doc", async () => {
    const key = (await c.post("/api/developer/keys", { name: "Org setup script" })).body.secret as string;
    const ch = (await v1(key, "POST", "/chat/channels", { name: "releases" })).body.channel;
    const up = await v1(key, "PATCH", `/chat/channels/${ch.id}`, { topic: "Every release, with notes." });
    expect(up.status).toBe(200);
    expect(up.body.channel.topic).toBe("Every release, with notes.");
    const post = (await v1(key, "POST", `/chat/channels/${ch.id}/messages`, { body: "Welcome to releases." })).body.message;
    expect((await v1(key, "POST", `/chat/messages/${post.id}/pin`)).body.message.pinnedAt).toBeTruthy();
    expect((await v1(key, "GET", `/chat/channels/${ch.id}/pins`)).body.pins).toHaveLength(1);
    expect((await v1(key, "DELETE", `/chat/messages/${post.id}/pin`)).body.message.pinnedAt).toBeNull();

    const bug = await v1(key, "POST", "/templates", { kind: "task", name: "Bug report", data: { title: "Bug: ", notes: "Steps to reproduce:\nExpected:\nActual:", subtasks: ["Reproduce", "Fix", "Verify"] } });
    expect(bug.status).toBe(201);
    expect(bug.body.template).toMatchObject({ kind: "task", name: "Bug report", taskCount: 4 });
    const proj = await v1(key, "POST", "/templates", { kind: "project", data: { project: { name: "Launch" }, tasks: [{ title: "Landing page", dueInDays: 3 }, { title: "Press note" }] } });
    expect(proj.body.template).toMatchObject({ kind: "project", name: "Launch", taskCount: 2 });
    expect((await v1(key, "POST", "/templates", { kind: "project", data: { tasks: [] } })).status).toBe(422);
    expect((await v1(key, "POST", "/templates", { kind: "task" })).status).toBe(422);

    const note = await v1(key, "POST", "/templates", { kind: "doc", name: "Release note", data: { title: "Release note", text: "# What changed\n- \n# Fixes\n- " } });
    expect(note.body.template).toMatchObject({ kind: "doc", name: "Release note", taskCount: 0 });
    const made = await v1(key, "POST", `/templates/${note.body.template.id}/use`, { name: "Release 1.8.0" });
    expect(made.status).toBe(201);
    expect(made.body.kind).toBe("doc");
    expect(made.body.doc.title).toBe("Release 1.8.0");
    expect(made.body.doc.text).toContain("What changed");

    const list = (await v1(key, "GET", "/templates")).body.templates as { id: string; kind: string }[];
    expect(list.filter((x) => x.kind === "doc").map((x) => x.id)).toEqual(expect.arrayContaining(["starter-meeting-notes", "starter-project-brief", note.body.template.id]));
    const starter = await v1(key, "POST", "/templates/starter-meeting-notes/use", {});
    expect(starter.body.doc.title).toBe("Meeting notes");

    const del = await v1(key, "DELETE", `/docs/${made.body.doc.id}`);
    expect(del.status).toBe(200);
    expect((await v1(key, "GET", `/docs/${made.body.doc.id}`)).status).toBe(404);
    expect((await v1(key, "DELETE", `/docs/${made.body.doc.id}`)).status).toBe(404);
  });

  it("saves a doc as a template from the app", async () => {
    const doc = (await c.post("/api/docs", { title: "Onboarding checklist", text: "# Day one\n- Laptop\n- Accounts" })).body.doc;
    const t = await c.post("/api/templates", { kind: "doc", fromDocId: doc.id });
    expect(t.status).toBe(201);
    expect(t.body.template).toMatchObject({ kind: "doc", name: "Onboarding checklist" });
    const used = await c.post(`/api/templates/${t.body.template.id}/use`, {});
    expect(used.body.doc.text).toContain("Laptop");
    expect((await c.get("/api/templates?kind=doc")).body.templates.every((x: { kind: string }) => x.kind === "doc")).toBe(true);
  });
});

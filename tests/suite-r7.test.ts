import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { buildIcs } from "@/server/services/suite/meetings";
import { wouldLoop } from "@/server/services/suite/tasks";
import { entrySeconds, MAX_TIMER_SECONDS } from "@/server/services/suite/time";
import { normaliseFields, validateAnswers } from "@/server/services/suite/forms";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let mailboxId: string;
let clock = new Date("2026-10-20T00:00:00.000Z").getTime();

async function setup(env: Record<string, string> = {}) {
  ctx = await makeTestApp(env);
  ctx.deps.now = () => new Date(clock);
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
  mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Acme" })).body.mailbox.id;
}

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const task = async (title: string, extra: Record<string, unknown> = {}) => (await c.post("/api/tasks", { title, ...extra })).body.task as { id: string; ref: string; projectId: string };

describe("helpers", () => {
  it("caps a forgotten timer and spots dependency loops", () => {
    const start = new Date(0);
    expect(entrySeconds({ startedAt: start, endedAt: null, seconds: 0 }, new Date(90_000))).toBe(90);
    expect(entrySeconds({ startedAt: start, endedAt: null, seconds: 0 }, new Date(3 * 86_400_000))).toBe(MAX_TIMER_SECONDS);
    expect(wouldLoop([{ from: "a", to: "b" }, { from: "b", to: "c" }], "c", "a")).toBe(true);
    expect(wouldLoop([{ from: "a", to: "b" }], "a", "c")).toBe(false);
    expect(wouldLoop([], "a", "a")).toBe(true);
  });

  it("normalises form fields and checks answers", () => {
    const fields = normaliseFields([{ label: "Your name", type: "text", required: true }, { label: "Email", type: "email", required: true }, { label: "Plan", type: "select", options: ["Free", "Pro"] }]);
    expect(fields.map((f) => f.id)).toEqual(["field_1", "field_2", "field_3"]);
    expect(() => validateAnswers(fields, { field_1: "Grace", field_2: "not-an-email" })).toThrow(/email/);
    expect(() => validateAnswers(fields, { field_1: "Grace", field_2: "g@x.io", field_3: "Gold" })).toThrow(/options/);
    expect(validateAnswers(fields, { field_1: " Grace ", field_2: "g@x.io" })).toEqual({ field_1: "Grace", field_2: "g@x.io" });
  });

  it("builds a calendar invite with folded lines and escaped text", () => {
    const ics = buildIcs({ id: "mtg_1", title: "Cutover, round two; final", startsAt: new Date("2026-10-24T23:00:00Z"), durationMin: 45 },
      { organizer: { address: "hello@acme.io", name: "Acme" }, invitees: ["maria@blueharbor.co"], guestUrl: "https://mymail.example/m/abc", now: new Date("2026-10-20T00:00:00Z") });
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("DTSTART:20261024T230000Z");
    expect(ics).toContain("DTEND:20261024T234500Z");
    expect(ics).toContain("SUMMARY:Cutover\\, round two\\; final");
    expect(ics.replace(/\r\n /g, "")).toContain("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:maria@blueharbor.co");
    expect(ics.split("\r\n").every((l) => l.length <= 75)).toBe(true);
  });
});

describe("time tracking", () => {
  beforeEach(() => setup());

  it("runs one timer at a time, logs manual time and builds a timesheet", async () => {
    const a = await task("Export mailboxes"), b = await task("Point MX records");
    const started = await c.post("/api/time/start", { taskId: a.ref });
    expect(started.status).toBe(201);
    expect(started.body.entry.running).toBe(true);
    clock += 25 * 60_000;
    // Starting on another task stops the first.
    await c.post("/api/time/start", { taskId: b.id });
    clock += 10 * 60_000;
    expect((await c.get("/api/time/running")).body.entry.task.id).toBe(b.id);
    const stopped = await c.post("/api/time/stop", {});
    expect(stopped.body.entry.seconds).toBe(600);
    expect((await c.post("/api/time/stop", {})).body.entry).toBeNull();
    const manual = await c.post("/api/time", { taskId: a.id, minutes: 90, date: "2026-10-19", note: "Import" });
    expect(manual.status).toBe(201);
    expect(manual.body.entry.source).toBe("manual");
    const detail = (await c.get(`/api/tasks/${a.id}`)).body;
    expect(detail.time.totalSeconds).toBe(25 * 60 + 90 * 60);
    const sheet = (await c.get("/api/time/timesheet?from=2026-10-14&to=2026-10-20")).body;
    expect(sheet.total).toBe(25 * 60 + 10 * 60 + 90 * 60);
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0].person.name).toBe("Ada Lovelace");
    expect(sheet.days).toContain("2026-10-19");
    expect(sheet.rows[0].days["2026-10-19"]).toBe(90 * 60 + 0);
    const edited = await c.patch(`/api/time/${manual.body.entry.id}`, { minutes: 60 });
    expect(edited.body.entry.seconds).toBe(3600);
    expect((await c.del(`/api/time/${manual.body.entry.id}`)).body.ok).toBe(true);
    expect((await c.get("/api/time?from=2026-10-01&to=2026-10-31")).body.entries).toHaveLength(2);
  });

  it("lets an agent key log time under its own name, and keeps a workspace key's timer under its maker", async () => {
    const t = await task("Draft SPF record");
    const { apiKey } = (await c.post("/api/agents", { name: "Ops bot", localPart: "ops" })).body;
    const wsKey = (await c.post("/api/developer/keys", { name: "Suite" })).body.secret;
    const r = await api(apiKey.secret, "POST", "/time/start", { taskId: t.ref });
    expect(r.status).toBe(201);
    expect(r.body.entry.person).toMatchObject({ type: "agent", name: "Ops bot" });
    // A workspace key acts as the person who made it.
    expect((await api(wsKey, "POST", "/time/start", { taskId: t.ref })).body.entry.person).toMatchObject({ type: "member", name: "Ada Lovelace" });
    const mcp = await mcpFor(apiKey.secret);
    clock += 5 * 60_000;
    const stopped = data(await mcp.callTool({ name: "stop_timer", arguments: {} }));
    expect(stopped.entry.seconds).toBe(300);
    const sheet = data(await mcp.callTool({ name: "get_timesheet", arguments: { from: "2026-10-14", to: "2026-10-21" } }));
    expect(sheet.rows.find((r: { person: string }) => r.person === "Ops bot")).toMatchObject({ total: 300 });
  });
});

describe("task dependencies", () => {
  beforeEach(() => setup());

  it("records blocked by and blocking, refuses loops and feeds the timeline", async () => {
    const dns = await task("Check DNS"), mx = await task("Point MX"), train = await task("Train the team");
    const r = await c.post(`/api/tasks/${mx.id}/dependencies`, { blockedBy: dns.ref });
    expect(r.status).toBe(201);
    expect(r.body.blocked).toBe(true);
    expect(r.body.blockedBy.map((t: { id: string }) => t.id)).toEqual([dns.id]);
    await c.post(`/api/tasks/${train.id}/dependencies`, { blockedBy: mx.id });
    expect((await c.post(`/api/tasks/${dns.id}/dependencies`, { blockedBy: train.id })).body.error.code).toBe("dependency_loop");
    const detail = (await c.get(`/api/tasks/${mx.id}`)).body;
    expect(detail.blockedBy.map((t: { id: string }) => t.id)).toEqual([dns.id]);
    expect(detail.blocking.map((t: { id: string }) => t.id)).toEqual([train.id]);
    const links = (await c.get(`/api/tasks/dependencies?projectId=${mx.projectId}`)).body.links;
    expect(links).toHaveLength(2);
    await c.patch(`/api/tasks/${dns.id}`, { status: "done" });
    expect((await c.get(`/api/tasks/${mx.id}`)).body.blockedBy[0].status).toBe("done");
    const removed = await c.del(`/api/tasks/${mx.id}/dependencies/${dns.id}`);
    expect(removed.body.blockedBy).toHaveLength(0);
  });
});

describe("forms", () => {
  beforeEach(() => setup());

  it("creates a task from a public submission, and quietly drops bots", async () => {
    const made = await c.post("/api/forms", { name: "Website enquiry" });
    expect(made.status).toBe(201);
    const form = made.body.form;
    expect(form.url).toMatch(/\/f\/[a-z0-9]+$/);
    const pub = new Client(ctx.app);
    const shown = await pub.get(`/api/public/forms/${form.slug}`);
    expect(shown.body.form).toMatchObject({ name: "Website enquiry", workspace: "Acme", turnstileSiteKey: null });
    expect(shown.body.form.fields.map((f: { id: string }) => f.id)).toEqual(["name", "email", "subject", "details"]);
    const answers = { name: "Grace Lee", email: "grace@harbourcoffee.com.au", subject: "Quote for 6 mailboxes", details: "We move in November." };
    const sent = await pub.post(`/api/public/forms/${form.slug}`, { answers, elapsedMs: 8000 });
    expect(sent.status).toBe(200);
    expect(sent.body.created.type).toBe("task");
    const t = (await c.get(`/api/tasks/${sent.body.created.id}`)).body;
    expect(t.task.title).toBe("Quote for 6 mailboxes");
    expect(t.task.labels).toEqual(["form"]);
    expect(t.task.notes).toContain("Email: grace@harbourcoffee.com.au");
    // A bot filling the honeypot gets the same thank-you and creates nothing.
    const bot = await pub.post(`/api/public/forms/${form.slug}`, { answers, website: "http://spam.example", elapsedMs: 8000 });
    expect(bot.body).toEqual({ ok: true, message: form.successMessage });
    const fast = await pub.post(`/api/public/forms/${form.slug}`, { answers, elapsedMs: 200 });
    expect(fast.body.created).toBeUndefined();
    expect((await pub.post(`/api/public/forms/${form.slug}`, { answers: { name: "x" }, elapsedMs: 5000 })).status).toBe(400); // R31: per-field errors answer 400
    for (let i = 0; i < 4; i++) await pub.post(`/api/public/forms/${form.slug}`, { answers, elapsedMs: 5000 });
    expect((await pub.post(`/api/public/forms/${form.slug}`, { answers, elapsedMs: 5000 })).status).toBe(429);
    const detail = (await c.get(`/api/forms/${form.id}`)).body;
    expect(detail.form.submitCount).toBe(5);
    await c.patch(`/api/forms/${form.id}`, { enabled: false });
    expect((await pub.get(`/api/public/forms/${form.slug}`)).status).toBe(404);
  });

  it("makes contacts, and needs Turnstile when it is set up", async () => {
    await setup({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" });
    ctx.deps.fetch = (async (_u: string, init?: RequestInit) => new Response(JSON.stringify({ success: String(init?.body).includes("response=good") }))) as typeof fetch;
    const form = (await c.post("/api/forms", { name: "Newsletter", target: "contact", fields: [{ label: "Name", type: "text", required: true }, { label: "Email", type: "email", required: true }] })).body.form;
    const pub = new Client(ctx.app);
    expect((await pub.get(`/api/public/forms/${form.slug}`)).body.form.turnstileSiteKey).toBe("site");
    const answers = { field_1: "Priya Patel", field_2: "priya@seedround.vc" };
    expect((await pub.post(`/api/public/forms/${form.slug}`, { answers, elapsedMs: 5000, turnstileToken: "bad" })).body.error.code).toBe("captcha_failed");
    const ok = await pub.post(`/api/public/forms/${form.slug}`, { answers, elapsedMs: 5000, turnstileToken: "good" });
    expect(ok.body.created.type).toBe("contact");
    expect((await c.get(`/api/contacts/${ok.body.created.id}`)).body.contact).toMatchObject({ email: "priya@seedround.vc", name: "Priya Patel" });
    expect((await c.post("/api/forms", { name: "Bad", target: "contact", fields: [{ label: "Name", type: "text" }] })).status).toBe(422);
  });
});

describe("reports", () => {
  beforeEach(() => setup());

  it("counts tasks by status and assignee, overdue work, time per project and the pipeline in AUD", async () => {
    const a = await task("Late task", { due: "2026-10-10" });
    await task("Open task");
    const done = await task("Finished");
    await c.patch(`/api/tasks/${done.id}`, { status: "done" });
    await c.post("/api/time", { taskId: a.id, minutes: 45, date: "2026-10-19" });
    await c.post("/api/deals", { title: "Blue Harbor", stage: "proposal", value: 2520 });
    await c.post("/api/deals", { title: "Lumen", stage: "won", value: 6000 });
    const r = (await c.get("/api/reports/dashboard?days=30")).body;
    expect(r.tasks).toMatchObject({ total: 3, open: 2, done: 1, overdue: 1 });
    expect(r.tasks.overdueList[0].title).toBe("Late task");
    expect(r.tasks.byStatus.find((s: { category: string }) => s.category === "done").count).toBe(1);
    expect(r.tasks.byAssignee[0]).toMatchObject({ name: "Unassigned", open: 2, overdue: 1 });
    expect(r.time.totalSeconds).toBe(2700);
    expect(r.time.byProject[0].name).toBe("Tasks");
    expect(r.deals).toMatchObject({ currency: "AUD", openValue: 2520, wonValue: 6000 });
    expect(r.tasks.completedByDay.at(-1)).toEqual({ day: "2026-10-20", count: 1 });
  });
});

describe("meetings", () => {
  it("schedules from a task with video off, and says so when joining", async () => {
    await setup();
    const t = await task("Kick-off with Grace");
    const r = await c.post("/api/meetings", { source: { type: "task", id: t.ref }, invitees: ["grace@harbourcoffee.com.au"], startsAt: "2026-10-21T23:00:00Z" });
    expect(r.status).toBe(201);
    const m = r.body.meeting;
    expect(m).toMatchObject({ title: "Kick-off with Grace", videoEnabled: false, durationMin: 30, invitees: ["grace@harbourcoffee.com.au"] });
    expect(m.guestUrl).toMatch(/\/m\/[A-Za-z0-9]+$/);
    expect((await c.post(`/api/meetings/${m.id}/join`)).body.error.code).toBe("meetings_off");
    const token = m.guestUrl.split("/m/")[1];
    const guest = new Client(ctx.app);
    expect((await guest.get(`/api/public/meetings/${token}`)).body.meeting).toMatchObject({ title: "Kick-off with Grace", host: "Acme", videoEnabled: false });
    expect((await guest.post(`/api/public/meetings/${token}/join`, { name: "Grace" })).status).toBe(503);
    expect((await c.get("/api/config")).body.meetings).toBe(false);
  });

  it("hands out LiveKit tokens when configured and emails the invite with an .ics file", async () => {
    await setup({ LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) });
    const r = await c.post("/api/meetings", { title: "Planning", invitees: ["maria@blueharbor.co"], sendInvites: true, mailboxId });
    expect(r.body.invites.status).toBe("sent");
    const sent = (await c.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=sent`)).body.messages;
    expect(sent[0].subject).toBe("Invitation: Planning");
    const join = (await c.post(`/api/meetings/${r.body.meeting.id}/join`)).body;
    expect(join.url).toBe("wss://example.livekit.cloud");
    const claims = JSON.parse(Buffer.from(join.token.split(".")[1], "base64url").toString());
    expect(claims.video).toMatchObject({ room: r.body.meeting.room, roomJoin: true, roomAdmin: true });
    expect(claims.name).toBe("Ada Lovelace");
    const token = r.body.meeting.guestUrl.split("/m/")[1];
    const guest = await new Client(ctx.app).post(`/api/public/meetings/${token}/join`, { name: "Maria" });
    const g = JSON.parse(Buffer.from(guest.body.token.split(".")[1], "base64url").toString());
    expect(g.name).toBe("Maria");
    expect(g.video.roomAdmin).toBeFalsy();
    await c.patch(`/api/meetings/${r.body.meeting.id}`, { status: "cancelled" });
    expect((await new Client(ctx.app).post(`/api/public/meetings/${token}/join`, { name: "Maria" })).body.error.code).toBe("meeting_cancelled");
  });

  it("sends an agent's invite through the approval queue", async () => {
    await setup();
    const { apiKey } = (await c.post("/api/agents", { name: "Scheduler", localPart: "scheduler" })).body;
    const mcp = await mcpFor(apiKey.secret);
    const res = data(await mcp.callTool({ name: "schedule_meeting", arguments: { title: "Intro call", invitees: ["jordan@lumen.dev"], sendInvites: true } }));
    expect(res.invites.status).toBe("pending_approval");
    const approvals = (await c.get("/api/approvals?status=pending")).body.approvals;
    expect(approvals[0]).toMatchObject({ subject: "Invitation: Intro call", to: ["jordan@lumen.dev"] });
    const wsKey = (await c.post("/api/developer/keys", { name: "Suite" })).body.secret;
    expect((await api(wsKey, "POST", "/meetings", { title: "No agent", invitees: ["x@y.io"], sendInvites: true })).body.error.code).toBe("agent_required");
    const listed = await api(wsKey, "GET", "/meetings");
    expect(listed.body.meetings).toHaveLength(1);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client, d1Violations } from "./helpers";
import { signWebhook, HISTORY_LIMIT, QUEUED_RUNS_PER_AGENT } from "../src/server/services/suite/agent-triggers";
import { historyLine, sourceLabel, type TriggerHistoryEntry } from "../src/web/pages/app/agent-trigger-history";
import { formStateFrom, triggerFormBody, type AgentTriggerView } from "../src/web/pages/app/agent-triggers";

/** R29: an agent trigger's History (fires and refusals from the audit log) and the Edit form's PATCH. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let projectId: string;
let taskId: string;
let taskRef: string;
let wsKey: string;
let readKey: string;
let builder: { id: string; key: string };
let clock = Date.parse("2026-10-26T02:00:00.000Z");
const tick = (ms: number) => { clock += ms; };

async function v1(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
async function hook(id: string, body: string, opts: { secret?: string; ts?: number } = {}) {
  const ts = opts.ts ?? Math.floor(clock / 1000);
  const sig = opts.secret ? await signWebhook(opts.secret, ts, body) : "";
  const res = await ctx.app.request(`/api/hooks/agent-runs/${id}`, {
    method: "POST", body,
    headers: { host: "localhost", "content-type": "application/json", ...(sig ? { "x-multies-signature": sig, "x-multies-timestamp": String(ts) } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const client = () => (ctx.db as unknown as { $client: { prepare: (q: string) => { all: (...a: unknown[]) => unknown[] } } }).$client;
const raw = (q: string, ...a: unknown[]) => client().prepare(q).all(...a);
const count = () => (raw("select count(*) n from audit_logs") as { n: number }[])[0].n;
const agent = async (name: string) => {
  const made = (await c.post("/api/team/agents", { name })).body;
  return { id: made.member.userId as string, key: made.secret as string };
};
const webhookTrigger = async (extra: Record<string, unknown> = {}) => {
  const r = await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "webhook", name: "Deploy failed", projectId, ...extra });
  return { id: r.body.trigger.id as string, secret: r.body.secret as string };
};
const history = async (id: string, q = "") => (await c.get(`/api/agent-triggers/${id}/history${q}`));

beforeEach(async () => {
  clock = Date.parse("2026-10-26T02:00:00.000Z");
  ctx = await makeTestApp();
  ctx.deps.now = () => new Date(clock);
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  projectId = (await c.post("/api/projects", { name: "Build", key: "MB" })).body.project.id;
  builder = await agent("Builder");
  const t = (await c.post("/api/tasks", { title: "Nightly triage", projectId, assignee: `member:${builder.id}` })).body.task;
  taskId = t.id; taskRef = t.ref;
  wsKey = (await c.post("/api/developer/keys", { name: "ops" })).body.secret;
  readKey = (await c.post("/api/developer/keys", { name: "reader", scope: "read" })).body.secret;
});

describe("trigger history", () => {
  it("lists fires and refusals newest first, with source, reason and the run", async () => {
    const t = await webhookTrigger();
    expect((await history(t.id)).body).toEqual({ triggerId: t.id, entries: [], limit: HISTORY_LIMIT });
    expect((await hook(t.id, "{}", { secret: t.secret })).status).toBe(202);
    tick(61_000);
    expect((await c.post(`/api/agent-triggers/${t.id}/run`, {})).status).toBe(201);
    tick(61_000);
    await c.patch(`/api/team/agents/${builder.id}`, { disabled: true });
    expect((await hook(t.id, "{}", { secret: t.secret })).body.error.code).toBe("agent_paused");
    // Lifecycle entries (created, updated) are not part of the history.
    await c.patch(`/api/agent-triggers/${t.id}`, { name: "Deploy failed!" });
    const h = (await history(t.id)).body;
    expect(h.entries.map((e: TriggerHistoryEntry) => [e.outcome, e.source, e.reason])).toEqual([
      ["refused", "webhook", "agent_paused"], ["fired", "manual", null], ["fired", "webhook", null],
    ]);
    const [refused, manual, fired] = h.entries as TriggerHistoryEntry[];
    expect(refused).toMatchObject({ run: null, sampled: false, at: new Date(clock).toISOString() });
    expect(refused.message).toContain("paused");
    expect(manual.actor).toMatchObject({ email: "owner@acme.io" });
    expect(fired.actor).toBeNull();
    const run = (raw("select id, task_id from agent_runs order by created_at limit 1") as { id: string; task_id: string }[])[0];
    expect(fired.run).toMatchObject({ id: run.id, taskId: run.task_id });
    expect(fired.run!.taskRef).toMatch(/^MB-\d+$/);
    expect(Date.parse(h.entries[0].at)).toBeGreaterThan(Date.parse(h.entries[2].at));
  });

  it("returns at most 50, honours a smaller limit, and keeps triggers apart", async () => {
    const a = await webhookTrigger();
    const b = await webhookTrigger({ name: "Other" });
    // Fill the agent's queue so every later fire is a refusal (an audited row each).
    for (let i = 0; i < QUEUED_RUNS_PER_AGENT; i++) { expect((await hook(a.id, `{"i":${i}}`, { secret: a.secret })).status).toBe(202); tick(61_000); }
    for (let i = 0; i < 55; i++) { expect((await hook(a.id, `{"r":${i}}`, { secret: a.secret })).body.error.code).toBe("agent_queue_full"); tick(1_000); }
    expect((await hook(b.id, "{}", { secret: b.secret })).body.error.code).toBe("agent_queue_full");
    const h = (await history(a.id)).body.entries as TriggerHistoryEntry[];
    expect(h).toHaveLength(50);
    expect(h.every((e) => e.reason === "agent_queue_full")).toBe(true);
    for (let i = 1; i < h.length; i++) expect(Date.parse(h[i - 1].at)).toBeGreaterThanOrEqual(Date.parse(h[i].at));
    expect((await history(a.id, "?limit=5")).body.entries).toHaveLength(5);
    expect((await history(a.id, "?limit=500")).body.entries).toHaveLength(50);
    expect((await history(b.id)).body.entries).toHaveLength(1);
    expect(d1Violations).toEqual([]);
  });

  it("samples webhook refusals before a fire: at most one per trigger every 10 minutes", async () => {
    const t = await webhookTrigger();
    const before = count();
    expect((await hook(t.id, "{}", { secret: "mtw_wrong" })).body.error.code).toBe("bad_signature");
    expect((await hook(t.id, "{}")).status).toBe(401);
    expect(count()).toBe(before + 1);
    tick(10 * 60_000 + 1_000);
    expect((await hook(t.id, "{}", { secret: t.secret, ts: Math.floor(clock / 1000) - 900 })).body.error.code).toBe("stale_signature");
    expect(count()).toBe(before + 2);
    // Over its rate and replays are sampled the same way.
    tick(10 * 60_000 + 1_000);
    const ts = Math.floor(clock / 1000);
    expect((await hook(t.id, "{}", { secret: t.secret, ts })).status).toBe(202);
    tick(1_000);
    expect((await hook(t.id, "{}", { secret: t.secret, ts: ts + 1 })).body.error.code).toBe("trigger_rate_limited");
    expect((await hook(t.id, "{}", { secret: t.secret, ts })).body.error.code).toBe("replayed");
    const h = (await history(t.id)).body.entries as TriggerHistoryEntry[];
    expect(h.map((e) => [e.outcome, e.reason, e.sampled])).toEqual([
      ["refused", "trigger_rate_limited", true], ["fired", null, false], ["refused", "stale_signature", true], ["refused", "bad_signature", true],
    ]);
    // A real refusal (not sampled) is always written, even inside the sample window.
    tick(61_000);
    await c.patch(`/api/team/agents/${builder.id}`, { disabled: true });
    expect((await hook(t.id, "{}", { secret: t.secret })).body.error.code).toBe("agent_paused");
    expect(((await history(t.id)).body.entries as TriggerHistoryEntry[])[0]).toMatchObject({ reason: "agent_paused", sampled: false });
  });

  it("is scoped to the workspace and to admins and full keys", async () => {
    const t = await webhookTrigger();
    await hook(t.id, "{}", { secret: t.secret });
    // REST v1 with a full workspace key.
    const viaV1 = await v1(wsKey, "GET", `/agent-triggers/${t.id}/history`);
    expect(viaV1.status).toBe(200);
    expect(viaV1.body.entries).toHaveLength(1);
    expect((await v1(readKey, "GET", `/agent-triggers/${t.id}/history`)).status).toBe(403);
    expect((await v1(builder.key, "GET", `/agent-triggers/${t.id}/history`)).status).toBe(403);
    const spec = (await v1(wsKey, "GET", "/openapi.json")).body;
    if (spec && spec.paths) expect(Object.keys(spec.paths)).toContain("/agent-triggers/{id}/history");
    // Another workspace sees a 404, not the history.
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve", "Evil");
    expect((await other.get(`/api/agent-triggers/${t.id}/history`)).status).toBe(404);
    const evilKey = (await other.post("/api/developer/keys", { name: "x" })).body.secret;
    expect((await v1(evilKey, "GET", `/agent-triggers/${t.id}/history`)).status).toBe(404);
    expect((await c.get("/api/agent-triggers/trg_nope0000000/history")).status).toBe(404);
    // Signed out.
    expect((await new Client(ctx.app).get(`/api/agent-triggers/${t.id}/history`)).status).toBe(401);
  });

  it("reads through the audit target index, not a scan", () => {
    const plan = raw("explain query plan select * from audit_logs where target_id = ? and target_type = 'agent_trigger' and org_id = ? and action in ('agent_trigger.fired', 'agent_trigger.refused') order by created_at desc, id desc limit 50", "trg_x", "org_x") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("audit_target_idx");
    // The sample check (webhook refusals) uses it too.
    const sample = raw("explain query plan select id from audit_logs where target_id = ? and target_type = 'agent_trigger' and created_at > ? and action = 'agent_trigger.refused' and json_extract(metadata, '$.sampled') = 1 limit 1", "trg_x", 0) as { detail: string }[];
    expect(sample.map((p) => p.detail).join(" ")).toContain("audit_target_idx");
  });
});

describe("editing a trigger", () => {
  it("updates a schedule trigger's name, days, zone, target and instructions, with an audit entry", async () => {
    const made = (await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "Morning", projectId, dailyAt: "09:00", days: ["mon", "tue", "wed", "thu", "fri"], timezone: "UTC" })).body.trigger;
    const r = await c.patch(`/api/agent-triggers/${made.id}`, { name: "Weekend check", dailyAt: "10:30", days: ["sat", "sun"], timezone: "Australia/Sydney", taskId: taskRef, projectId: null, instructions: "Look at the weekend queue." });
    expect(r.status).toBe(200);
    expect(r.body.trigger).toMatchObject({ name: "Weekend check", schedule: { dailyAt: "10:30", days: ["sun", "sat"], timezone: "Australia/Sydney" }, task: { id: taskId, ref: taskRef }, project: null, instructions: "Look at the weekend queue." });
    // Next run is recomputed: Saturday 31 October 2026 10:30 in Sydney (AEDT, UTC+11).
    expect(r.body.trigger.nextRunAt).toBe("2026-10-30T23:30:00.000Z");
    const row = (raw("select metadata, actor_email from audit_logs where action = 'agent_trigger.updated'") as { metadata: string; actor_email: string }[]);
    expect(row).toHaveLength(1);
    expect(row[0].actor_email).toBe("owner@acme.io");
    expect(JSON.parse(row[0].metadata).changed).toEqual(expect.arrayContaining(["name", "dailyAt", "days", "timezone", "taskId", "projectId", "instructions"]));
    // Switch to every 4 hours, then back to a project.
    const every = await c.patch(`/api/agent-triggers/${made.id}`, { everyHours: 4, taskId: null, projectId });
    expect(every.body.trigger).toMatchObject({ schedule: { everyHours: 4 }, task: null, project: { id: projectId } });
  });

  it("validates like create and an unchanged save writes nothing", async () => {
    const made = (await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "Morning", projectId, everyHours: 6 })).body.trigger;
    const before = count();
    expect((await c.patch(`/api/agent-triggers/${made.id}`, { name: "   " })).status).toBe(422);
    expect((await c.patch(`/api/agent-triggers/${made.id}`, { everyHours: 0 })).status).toBe(422);
    expect((await c.patch(`/api/agent-triggers/${made.id}`, { dailyAt: "25:00" })).status).toBe(422);
    expect((await c.patch(`/api/agent-triggers/${made.id}`, { everyHours: 2, dailyAt: "09:00" })).status).toBe(422);
    expect((await c.patch(`/api/agent-triggers/${made.id}`, { timezone: "Mars/Olympus" })).status).toBe(422);
    expect((await c.patch(`/api/agent-triggers/${made.id}`, { taskId: null, projectId: null })).status).toBe(422);
    expect((await c.patch(`/api/agent-triggers/${made.id}`, { taskId: "MB-999" })).status).toBe(404);
    // kind is not an edit field: it is ignored, and the trigger stays a schedule.
    expect((await c.patch(`/api/agent-triggers/${made.id}`, { kind: "webhook" })).body.trigger.kind).toBe("schedule");
    expect(count()).toBe(before);
    expect((await c.patch(`/api/agent-triggers/${made.id}`, { name: "Morning", everyHours: 6 })).status).toBe(200);
    expect(count()).toBe(before);
  });

  it("is admins and full keys only, and scoped to the workspace", async () => {
    const t = await webhookTrigger();
    expect((await v1(wsKey, "PATCH", `/agent-triggers/${t.id}`, { name: "Via key" })).body.trigger.name).toBe("Via key");
    expect((await v1(readKey, "PATCH", `/agent-triggers/${t.id}`, { name: "No" })).status).toBe(403);
    expect((await v1(builder.key, "PATCH", `/agent-triggers/${t.id}`, { name: "No" })).status).toBe(403);
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve", "Evil");
    expect((await other.patch(`/api/agent-triggers/${t.id}`, { name: "Mine" })).status).toBe(404);
    expect((await c.get(`/api/agent-triggers/${t.id}`)).body.trigger.name).toBe("Via key");
    // Editing a webhook keeps its URL and secret.
    expect((await hook(t.id, "{}", { secret: t.secret })).status).toBe(202);
  });
});

describe("History and Edit in the web dialog", () => {
  const entry = (x: Partial<TriggerHistoryEntry>): TriggerHistoryEntry => ({ id: "aud_1", at: "2026-10-26T02:00:00.000Z", outcome: "fired", source: "webhook", reason: null, message: null, run: null, actor: null, sampled: false, ...x });
  it("words each history line", () => {
    expect(historyLine(entry({ run: { id: "run_1", taskId: "t", taskRef: "MB-3" } }))).toBe("Fired, queued a run on MB-3");
    expect(historyLine(entry({}))).toBe("Fired, queued a run");
    expect(historyLine(entry({ outcome: "refused", reason: "agent_paused" }))).toBe("Refused: the agent is paused");
    expect(historyLine(entry({ outcome: "refused", reason: "bad_signature" }))).toBe("Refused: the signature did not match");
    expect(historyLine(entry({ outcome: "refused", reason: "something_new" }))).toBe("Refused: something new");
    expect(sourceLabel(entry({ source: "manual" }))).toBe("Run now");
    expect(sourceLabel(entry({ source: "schedule" }))).toBe("Schedule");
    expect(sourceLabel(entry({ source: null }))).toBe("Unknown");
  });

  it("fills the Edit form from a trigger and sends a PATCH body without kind or agent", () => {
    const t = {
      id: "trg_1", name: "Morning", kind: "schedule", enabled: true, agent: { userId: "u", name: "B", active: true },
      task: { id: "tsk_1", ref: "MB-1", title: "x" }, project: null, titleTemplate: null, instructions: "Do it",
      schedule: { dailyAt: "07:15", days: ["sat"], timezone: "Australia/Sydney" }, webhook: null,
      nextRunAt: null, lastFiredAt: null, fireCount: 0, createdAt: "", updatedAt: "",
    } as unknown as AgentTriggerView;
    const f = formStateFrom(t);
    expect(f).toMatchObject({ name: "Morning", kind: "schedule", mode: "daily", dailyAt: "07:15", days: ["sat"], timezone: "Australia/Sydney", target: "task", taskId: "MB-1", instructions: "Do it" });
    expect(triggerFormBody(f, { agentUserId: "u", editing: true, projectId: "p" })).toEqual({ name: "Morning", taskId: "MB-1", projectId: null, instructions: "Do it", dailyAt: "07:15", days: ["sat"], timezone: "Australia/Sydney" });
    const blank = formStateFrom(null);
    expect(blank).toMatchObject({ kind: "schedule", days: ["mon", "tue", "wed", "thu", "fri"], timezone: "", target: "project" });
    expect(triggerFormBody({ ...blank, name: " New " }, { agentUserId: "u", editing: false, projectId: "p" })).toEqual({ agentUserId: "u", kind: "schedule", name: "New", projectId: "p", titleTemplate: "{trigger} {date}", instructions: null, dailyAt: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] });
    expect(triggerFormBody({ ...blank, name: "W", kind: "webhook" }, { agentUserId: "u", editing: true, projectId: "p" })).toEqual({ name: "W", projectId: "p", titleTemplate: "{trigger} {date}", taskId: null, instructions: null });
  });
});

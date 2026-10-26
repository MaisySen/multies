import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client, d1Violations } from "./helpers";
import { describeAudit } from "../src/web/components/app-bits";
import {
  listTriggers, nextRunAfter, renderTitle, runDueTriggers, signWebhook, verifyWebhookSignature, QUEUED_RUNS_PER_AGENT, TRIGGERS_PER_WORKSPACE, WEBHOOK_BODY_MAX,
} from "../src/server/services/suite/agent-triggers";
import { runMaintenance } from "../src/server/services/maintenance";

/** R28 (DF-3 slice 3): triggers queue agent runs on a schedule or from a signed webhook, with limits and audit. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let projectId: string;
let taskId: string;
let taskRef: string;
let wsKey: string;
let readKey: string;
let builder: { id: string; key: string };
let clock = Date.parse("2026-10-26T02:00:00.000Z");

async function v1(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
async function hook(id: string, body: string, opts: { secret?: string; ts?: number; sig?: string; headers?: Record<string, string> } = {}) {
  const ts = opts.ts ?? Math.floor(clock / 1000);
  const sig = opts.sig ?? (opts.secret ? await signWebhook(opts.secret, ts, body) : "");
  const res = await ctx.app.request(`/api/hooks/agent-runs/${id}`, {
    method: "POST", body,
    headers: { host: "localhost", "content-type": "application/json", ...(sig ? { "x-multies-signature": sig, "x-multies-timestamp": String(ts) } : {}), ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const client = () => (ctx.db as unknown as { $client: { prepare: (q: string) => { all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown } } }).$client;
const raw = (q: string, ...a: unknown[]) => client().prepare(q).all(...a);
const audits = (prefix = "agent_trigger.") => raw("select action, target_id, metadata from audit_logs where action like ? order by rowid", `${prefix}%`) as { action: string; target_id: string; metadata: string }[];
const agent = async (name: string) => {
  const made = (await c.post("/api/team/agents", { name })).body;
  return { id: made.member.userId as string, key: made.secret as string };
};
const tick = (ms: number) => { clock += ms; };

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

describe("signature verification", () => {
  const secret = "mtw_test_secret";
  const now = new Date("2026-10-26T02:00:00Z");
  const ts = Math.floor(now.getTime() / 1000);
  it("accepts a good signature, with or without the sha256= prefix", async () => {
    const sig = await signWebhook(secret, ts, "{\"a\":1}");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifyWebhookSignature(secret, { timestamp: String(ts), signature: sig }, "{\"a\":1}", now)).toEqual({ ok: true, timestamp: ts });
    expect((await verifyWebhookSignature(secret, { timestamp: String(ts), signature: sig.slice(7) }, "{\"a\":1}", now)).ok).toBe(true);
  });
  it("refuses a bad signature, a changed body, another secret, a missing header and a malformed timestamp", async () => {
    const sig = await signWebhook(secret, ts, "{\"a\":1}");
    expect(await verifyWebhookSignature(secret, { timestamp: String(ts), signature: sig }, "{\"a\":2}", now)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(await verifyWebhookSignature("other", { timestamp: String(ts), signature: sig }, "{\"a\":1}", now)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(await verifyWebhookSignature(secret, { timestamp: String(ts), signature: "sha256=00" }, "{\"a\":1}", now)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(await verifyWebhookSignature(secret, { timestamp: String(ts + 1), signature: sig }, "{\"a\":1}", now)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(await verifyWebhookSignature(secret, { timestamp: null, signature: sig }, "{\"a\":1}", now)).toMatchObject({ ok: false, code: "missing_signature" });
    expect(await verifyWebhookSignature(secret, { timestamp: "soon", signature: sig }, "{\"a\":1}", now)).toMatchObject({ ok: false, code: "bad_timestamp" });
  });
  it("refuses a stale timestamp outside the 5 minute window, in either direction", async () => {
    for (const off of [301, -301]) {
      const t = ts - off;
      const sig = await signWebhook(secret, t, "x");
      expect(await verifyWebhookSignature(secret, { timestamp: String(t), signature: sig }, "x", now)).toMatchObject({ ok: false, code: "stale_signature" });
    }
    const t = ts - 299;
    expect((await verifyWebhookSignature(secret, { timestamp: String(t), signature: await signWebhook(secret, t, "x") }, "x", now)).ok).toBe(true);
  });
});

describe("schedule maths", () => {
  it("every N hours counts from the last run", () => {
    expect(nextRunAfter({ everyHours: 6, timezone: "UTC" }, new Date("2026-10-26T02:00:00Z"))?.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });
  it("daily at HH:MM is the wall clock time in the zone, across a DST change", () => {
    // Sydney moves to daylight time (UTC+11) on Sunday 4 October 2026 at 02:00.
    const spec = { dailyAt: "09:00", timezone: "Australia/Sydney" };
    expect(nextRunAfter(spec, new Date("2026-10-02T12:00:00Z"))?.toISOString()).toBe("2026-10-02T23:00:00.000Z"); // Sat 09:00 AEST
    expect(nextRunAfter(spec, new Date("2026-10-03T23:30:00Z"))?.toISOString()).toBe("2026-10-04T22:00:00.000Z"); // Mon 09:00 AEDT
    expect(nextRunAfter(spec, new Date("2026-10-26T21:59:00Z"))?.toISOString()).toBe("2026-10-26T22:00:00.000Z"); // later today
    expect(nextRunAfter({ dailyAt: "09:00", timezone: "UTC" }, new Date("2026-10-26T09:00:00Z"))?.toISOString()).toBe("2026-10-27T09:00:00.000Z"); // strictly after
  });
  it("honours weekdays", () => {
    // Friday 30 October 2026 after 09:00 in Sydney: the next weekday run is Monday 2 November.
    const next = nextRunAfter({ dailyAt: "09:00", days: ["mon", "tue", "wed", "thu", "fri"], timezone: "Australia/Sydney" }, new Date("2026-10-29T23:30:00Z"));
    expect(next?.toISOString()).toBe("2026-11-01T22:00:00.000Z");
  });
  it("renders title templates in the zone", () => {
    expect(renderTitle("Triage {date}", { trigger: "Nightly", at: new Date("2026-10-26T14:30:00Z"), timezone: "Australia/Sydney" })).toBe("Triage 2026-10-27");
    expect(renderTitle("{trigger} at {datetime}", { trigger: "Nightly", at: new Date("2026-10-26T14:30:00Z"), timezone: "UTC" })).toBe("Nightly at 2026-10-26 14:30");
  });
});

describe("managing triggers", () => {
  it("creates a webhook trigger with its secret once, edits, rotates and deletes it, all audited", async () => {
    const made = await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "webhook", name: "Sentry alert", projectId, titleTemplate: "Alert {datetime}", instructions: "Look at the alert and reply." });
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^mtw_/);
    const tr = made.body.trigger;
    expect(tr).toMatchObject({ kind: "webhook", enabled: true, agent: { userId: builder.id, name: "Builder", active: true }, project: { id: projectId }, nextRunAt: null, fireCount: 0 });
    expect(tr.webhook.url).toMatch(new RegExp(`/api/hooks/agent-runs/${tr.id}$`));
    expect(tr.webhook.secretHint).toBe(made.body.secret.slice(-4));
    // The secret is never shown again and isn't stored in plain text.
    const got = await c.get(`/api/agent-triggers/${tr.id}`);
    expect(JSON.stringify(got.body)).not.toContain(made.body.secret);
    expect(JSON.stringify(raw("select * from agent_triggers"))).not.toContain(made.body.secret);
    expect((await c.patch(`/api/agent-triggers/${tr.id}`, { name: "Sentry alerts", enabled: false })).body.trigger).toMatchObject({ name: "Sentry alerts", enabled: false });
    const rot = await c.post(`/api/agent-triggers/${tr.id}/rotate-secret`, {});
    expect(rot.status).toBe(200);
    expect(rot.body.secret).not.toBe(made.body.secret);
    expect((await c.del(`/api/agent-triggers/${tr.id}`)).body).toEqual({ deleted: true, id: tr.id });
    expect(audits().map((x) => x.action)).toEqual(["agent_trigger.created", "agent_trigger.updated", "agent_trigger.secret_rotated", "agent_trigger.deleted"]);
    expect(JSON.parse(audits()[1].metadata)).toMatchObject({ triggerName: "Sentry alerts", changed: ["name", "enabled"] });
    const page = (await c.get("/api/org/audit")).body.entries as { action: string }[];
    expect(page.filter((e) => e.action.startsWith("agent_trigger.")).length).toBe(4);
  });

  it("creates a schedule trigger with its next run in the workspace zone and validates the schedule", async () => {
    const made = await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "Morning", taskId: taskRef, dailyAt: "09:00", days: ["fri", "mon"] });
    expect(made.status).toBe(201);
    expect(made.body.secret).toBeUndefined();
    expect(made.body.trigger).toMatchObject({ task: { id: taskId, ref: taskRef }, schedule: { dailyAt: "09:00", days: ["mon", "fri"] }, webhook: null });
    expect(made.body.trigger.schedule.timezone).toBeTruthy();
    expect(made.body.trigger.nextRunAt).toBeTruthy();
    // Minimum one hour; one schedule only; a target is required; kind can't change.
    expect((await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "Too often", taskId, everyHours: 0 })).status).toBe(422);
    expect((await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "Both", taskId, everyHours: 2, dailyAt: "09:00" })).status).toBe(422);
    expect((await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "None", taskId })).status).toBe(422);
    expect((await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "webhook", name: "Nowhere" })).status).toBe(422);
    expect((await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "Zone", taskId, everyHours: 2, timezone: "Mars/Base" })).status).toBe(422);
    expect((await c.patch(`/api/agent-triggers/${made.body.trigger.id}`, { kind: "webhook" })).status).toBe(200); // kind isn't a patch field; ignored
    // Turning it off clears the next run; on again computes it.
    expect((await c.patch(`/api/agent-triggers/${made.body.trigger.id}`, { enabled: false })).body.trigger.nextRunAt).toBeNull();
    expect((await c.patch(`/api/agent-triggers/${made.body.trigger.id}`, { enabled: true, everyHours: 3 })).body.trigger).toMatchObject({ schedule: { everyHours: 3 }, nextRunAt: "2026-10-26T05:00:00.000Z" });
  });

  it("refuses a 21st trigger in the workspace", async () => {
    for (let i = 0; i < TRIGGERS_PER_WORKSPACE; i++) {
      expect((await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: `T${i}`, taskId, everyHours: 24 })).status).toBe(201);
    }
    const r = await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "One too many", taskId, everyHours: 24 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("trigger_limit");
    expect((await c.get("/api/agent-triggers")).body.triggers).toHaveLength(TRIGGERS_PER_WORKSPACE);
  });

  it("is for admins and full workspace keys only", async () => {
    const r = await v1(builder.key, "GET", "/agent-triggers");
    expect(r.status).toBe(403);
    expect((await v1(builder.key, "POST", "/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "Mine", taskId, everyHours: 1 })).status).toBe(403);
    expect((await v1(readKey, "POST", "/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "R", taskId, everyHours: 1 })).status).toBe(403);
    const org = (raw("select org_id from agent_runs union select organization_id from members limit 1") as { org_id: string }[])[0].org_id;
    await expect(listTriggers(ctx.deps, { orgId: org, userId: "u_member", email: "m@acme.io", name: "Max", role: "member" })).rejects.toMatchObject({ status: 403 });
    const ok = await v1(wsKey, "POST", "/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "By key", taskId, everyHours: 4 });
    expect(ok.status).toBe(201);
    expect((await v1(wsKey, "GET", "/agent-triggers")).body.triggers).toHaveLength(1);
    expect((await v1(wsKey, "PATCH", `/agent-triggers/${ok.body.trigger.id}`, { name: "By key 2" })).body.trigger.name).toBe("By key 2");
    expect((await v1(wsKey, "DELETE", `/agent-triggers/${ok.body.trigger.id}`)).status).toBe(200);
    // Not an agent member: refused.
    expect((await c.post("/api/agent-triggers", { agentUserId: "usr_nope", kind: "schedule", name: "X", taskId, everyHours: 1 })).status).toBe(422);
  });
});

describe("the webhook", () => {
  async function webhookTrigger(extra: Record<string, unknown> = {}) {
    const r = await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "webhook", name: "Deploy failed", projectId, titleTemplate: "Deploy failed {date}", instructions: "Read the log and fix it.", ...extra });
    return { id: r.body.trigger.id as string, secret: r.body.secret as string };
  }

  it("a signed POST queues a run on a new task; the agent picks it up and completes it", async () => {
    const t = await webhookTrigger();
    const body = JSON.stringify({ service: "api", sha: "abc123" });
    const r = await hook(t.id, body, { secret: t.secret });
    expect(r.status).toBe(202);
    expect(r.body.run).toMatchObject({ status: "queued", agentUserId: builder.id });
    expect(r.body.run.taskRef).toMatch(/^MB-/);
    const task = (await c.get(`/api/tasks/${r.body.run.taskId}`)).body.task;
    expect(task).toMatchObject({ title: "Deploy failed 2026-10-26", notes: "Read the log and fix it.", assignee: { id: builder.id } });
    // The agent's own key sees its queued work with the trigger's input.
    const mine = await v1(builder.key, "GET", "/agents/me/runs?status=queued");
    expect(mine.status).toBe(200);
    expect(mine.body.runs).toHaveLength(1);
    const run = mine.body.runs[0];
    expect(run).toMatchObject({ id: r.body.run.runId, status: "queued", triggerId: t.id, input: { source: "webhook", triggerName: "Deploy failed", instructions: "Read the log and fix it.", payload: { service: "api", sha: "abc123" } } });
    // Workspace keys can't use /agents/me/runs.
    expect((await v1(wsKey, "GET", "/agents/me/runs")).status).toBe(403);
    // Claim, log, finish: the slice 2 flow moves it from queued to running to succeeded.
    const claimed = await v1(builder.key, "POST", `/tasks/${run.taskId}/runs`, { note: "Picked up" });
    expect(claimed.status).toBe(201);
    expect(claimed.body.run).toMatchObject({ id: run.id, status: "running" });
    expect((await v1(builder.key, "POST", `/runs/${run.id}/finish`, { status: "succeeded", result: "Rolled back.", moveTo: "done" })).body.run.status).toBe("succeeded");
    expect((await v1(builder.key, "GET", "/agents/me/runs?status=queued")).body.runs).toHaveLength(0);
    const fired = audits().find((x) => x.action === "agent_trigger.fired")!;
    expect(JSON.parse(fired.metadata)).toMatchObject({ source: "webhook", runId: run.id, taskRef: r.body.run.taskRef, agentName: "Builder", triggerName: "Deploy failed" });
    expect((await c.get(`/api/agent-triggers/${t.id}`)).body.trigger).toMatchObject({ fireCount: 1, lastFiredAt: new Date(clock).toISOString() });
  });

  it("refuses unsigned, badly signed and stale requests, and replays, without writing", async () => {
    const t = await webhookTrigger();
    const before = (raw("select count(*) n from audit_logs") as { n: number }[])[0].n;
    expect((await hook(t.id, "{}")).status).toBe(401);
    expect((await hook(t.id, "{}", { secret: "mtw_wrong" })).body.error.code).toBe("bad_signature");
    expect((await hook(t.id, "{}", { secret: t.secret, ts: Math.floor(clock / 1000) - 600 })).body.error.code).toBe("stale_signature");
    expect((raw("select count(*) n from audit_logs") as { n: number }[])[0].n).toBe(before);
    expect((raw("select count(*) n from agent_runs") as { n: number }[])[0].n).toBe(0);
    // A replay of an accepted request is refused, even after the rate limit has passed.
    const ts = Math.floor(clock / 1000);
    expect((await hook(t.id, "{\"n\":1}", { secret: t.secret, ts })).status).toBe(202);
    expect((await hook(t.id, "{\"n\":1}", { secret: t.secret, ts })).body.error.code).toBe("replayed");
    tick(120_000);
    expect((await hook(t.id, "{\"n\":1}", { secret: t.secret, ts })).body.error.code).toBe("replayed");
    // An old secret stops at once after a rotation.
    const rot = (await c.post(`/api/agent-triggers/${t.id}/rotate-secret`, {})).body.secret as string;
    tick(120_000);
    expect((await hook(t.id, "{}", { secret: t.secret })).status).toBe(401);
    expect((await hook(t.id, "{}", { secret: rot })).status).toBe(202);
  });

  it("fires at most once a minute (429)", async () => {
    const t = await webhookTrigger();
    expect((await hook(t.id, "{}", { secret: t.secret })).status).toBe(202);
    tick(30_000);
    const r = await hook(t.id, "{}", { secret: t.secret });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("trigger_rate_limited");
    tick(31_000);
    expect((await hook(t.id, "{}", { secret: t.secret })).status).toBe(202);
  });

  it("refuses a body over 32 KB (413), a disabled or unknown trigger (404) and a schedule trigger's id (404)", async () => {
    const t = await webhookTrigger();
    const big = JSON.stringify({ x: "a".repeat(WEBHOOK_BODY_MAX) });
    expect((await hook(t.id, big, { secret: t.secret })).status).toBe(413);
    await c.patch(`/api/agent-triggers/${t.id}`, { enabled: false });
    expect((await hook(t.id, "{}", { secret: t.secret })).status).toBe(404);
    expect((await hook("trg_doesnotexist000", "{}", { secret: t.secret })).status).toBe(404);
    expect((await hook("nope", "{}", { secret: t.secret })).status).toBe(404);
    const s = await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "S", taskId, everyHours: 1 });
    expect((await hook(s.body.trigger.id, "{}", { secret: t.secret })).status).toBe(404);
  });

  it("refuses a 4th queued run for the agent (429) with an audit entry", async () => {
    const t = await webhookTrigger();
    for (let i = 0; i < QUEUED_RUNS_PER_AGENT; i++) {
      expect((await hook(t.id, `{"i":${i}}`, { secret: t.secret })).status).toBe(202);
      tick(61_000);
    }
    const r = await hook(t.id, "{\"i\":3}", { secret: t.secret });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("agent_queue_full");
    const refused = audits().filter((x) => x.action === "agent_trigger.refused");
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0].metadata)).toMatchObject({ reason: "agent_queue_full", source: "webhook" });
    // Once the agent picks one up, there is room again.
    const queued = (await v1(builder.key, "GET", "/agents/me/runs?status=queued")).body.runs;
    expect(queued).toHaveLength(3);
    await v1(builder.key, "POST", `/runs/${queued[0].id}/steps`, { text: "On it" });
    tick(61_000);
    expect((await hook(t.id, "{\"i\":4}", { secret: t.secret })).status).toBe(202);
  });

  it("refuses a paused or removed agent (409) with an audit entry", async () => {
    const t = await webhookTrigger();
    await c.patch(`/api/team/agents/${builder.id}`, { disabled: true });
    const r = await hook(t.id, "{}", { secret: t.secret });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("agent_paused");
    expect((await c.get(`/api/agent-triggers/${t.id}`)).body.trigger.agent.active).toBe(false);
    await c.del(`/api/team/members/${builder.id}`);
    tick(61_000);
    expect((await hook(t.id, "{}", { secret: t.secret })).body.error.code).toBe("agent_not_member");
    expect(audits().filter((x) => x.action === "agent_trigger.refused").map((x) => JSON.parse(x.metadata).reason)).toEqual(["agent_paused", "agent_not_member"]);
  });

  it("on a named task, refuses while the agent already has an active run there", async () => {
    const t = await webhookTrigger({ projectId: null, taskId });
    expect((await hook(t.id, "{}", { secret: t.secret })).status).toBe(202);
    tick(61_000);
    const r = await hook(t.id, "{}", { secret: t.secret });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("run_in_progress");
  });
});

describe("schedule firing from the cron pass", () => {
  it("queues a run when due, moves the next run on, and writes nothing when idle", async () => {
    const made = (await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "Hourly digest", projectId, titleTemplate: "{trigger} {datetime}", everyHours: 1, timezone: "UTC" })).body.trigger;
    expect(made.nextRunAt).toBe("2026-10-26T03:00:00.000Z");
    expect(await runDueTriggers(ctx.deps)).toEqual({ due: 0, fired: 0, refused: 0 });
    tick(61 * 60_000);
    const pass = await runMaintenance(ctx.deps);
    expect(pass.agentTriggers).toEqual({ due: 1, fired: 1, refused: 0 });
    const runs = raw("select status, trigger_id, input, task_id from agent_runs") as { status: string; trigger_id: string; input: string; task_id: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", trigger_id: made.id });
    expect(JSON.parse(runs[0].input)).toMatchObject({ source: "schedule", triggerName: "Hourly digest" });
    expect((await c.get(`/api/tasks/${runs[0].task_id}`)).body.task.title).toBe("Hourly digest 2026-10-26 03:01");
    const after = (await c.get(`/api/agent-triggers/${made.id}`)).body.trigger;
    expect(after).toMatchObject({ fireCount: 1, nextRunAt: "2026-10-26T04:01:00.000Z" });
    // Same moment again: nothing is due.
    expect(await runDueTriggers(ctx.deps)).toEqual({ due: 0, fired: 0, refused: 0 });
    // A disabled trigger is not read by the pass.
    await c.patch(`/api/agent-triggers/${made.id}`, { enabled: false });
    tick(5 * 3_600_000);
    expect(await runDueTriggers(ctx.deps)).toEqual({ due: 0, fired: 0, refused: 0 });
  });

  it("a refused schedule fire still moves the next run on (no retry every pass)", async () => {
    const made = (await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "On task", taskId, everyHours: 2 })).body.trigger;
    await c.patch(`/api/team/agents/${builder.id}`, { disabled: true });
    tick(2 * 3_600_000 + 60_000);
    expect(await runDueTriggers(ctx.deps)).toEqual({ due: 1, fired: 0, refused: 1 });
    expect((await c.get(`/api/agent-triggers/${made.id}`)).body.trigger.nextRunAt).toBe(new Date(clock + 2 * 3_600_000).toISOString());
    expect(await runDueTriggers(ctx.deps)).toEqual({ due: 0, fired: 0, refused: 0 });
    expect(audits().filter((x) => x.action === "agent_trigger.refused")).toHaveLength(1);
  });

  it("Run now fires through the same limits", async () => {
    const made = (await c.post("/api/agent-triggers", { agentUserId: builder.id, kind: "schedule", name: "Manual", taskId, everyHours: 24 })).body.trigger;
    const r = await c.post(`/api/agent-triggers/${made.id}/run`, {});
    expect(r.status).toBe(201);
    expect(r.body.fired).toMatchObject({ status: "queued", taskId });
    expect((await c.post(`/api/agent-triggers/${made.id}/run`, {})).body.error.code).toBe("run_in_progress");
    expect(JSON.parse(audits().find((x) => x.action === "agent_trigger.fired")!.metadata)).toMatchObject({ source: "manual", via: "app" });
  });
});

describe("MCP, audit wording and D1", () => {
  it("lists, creates and deletes triggers over MCP", async () => {
    const mcp = await mcpFor(wsKey);
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["list_agent_triggers", "create_agent_trigger", "delete_agent_trigger"]));
    const made = data(await mcp.callTool({ name: "create_agent_trigger", arguments: { agentUserId: builder.id, kind: "webhook", name: "From MCP", projectId } }));
    expect(made.secret).toMatch(/^mtw_/);
    expect(data(await mcp.callTool({ name: "list_agent_triggers", arguments: {} })).triggers).toHaveLength(1);
    expect(data(await mcp.callTool({ name: "delete_agent_trigger", arguments: { triggerId: made.trigger.id } }))).toMatchObject({ deleted: true });
    // An agent member's key is refused.
    const agentMcp = await mcpFor(builder.key);
    const refused = await agentMcp.callTool({ name: "list_agent_triggers", arguments: {} });
    expect(refused.isError).toBe(true);
  });

  it("describes trigger audit entries in plain words", () => {
    const e = (action: string, metadata: Record<string, unknown>) => describeAudit({ action, metadata } as never);
    expect(e("agent_trigger.created", { triggerName: "Nightly" })).toMatchObject({ object: "Nightly" });
    expect(e("agent_trigger.fired", { triggerName: "Nightly", taskRef: "MB-3", agentName: "Builder" }).verb).toMatch(/fired/);
    expect(e("agent_trigger.refused", { triggerName: "Nightly", reason: "agent_queue_full" }).object).toContain("queue");
  });

  it("stays inside D1's variable limit", () => {
    expect(d1Violations).toEqual([]);
  });
});

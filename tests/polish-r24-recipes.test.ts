import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { createAutomation } from "@/server/services/suite/automations";
import { resetLoopGuard } from "@/server/services/suite/automations-r24";
import { enableRecipe } from "@/server/services/suite/automation-recipes";
import { BULK_RULE_RUNS } from "@/server/services/suite/automations-r24-events";
import { bulkUpdateTasks } from "@/server/services/suite/bulk";
import { createTask, getTask } from "@/server/services/suite/tasks";
import { clearCallCache, type CallParticipant } from "@/server/services/suite/calls";
import { resetWriteBudgetCache } from "@/server/services/write-budget";
import type { SuiteActor } from "@/server/services/suite/common";

/** R24 polish: meeting_ended from the call service, and assignee_changed for bulk edits (capped). */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let actor: SuiteActor;
let pid: string;
let mateId: string;
const rooms = new Map<string, CallParticipant[]>();

function analytics(rows: number) {
  return (async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: rows }, dimensions: { databaseId: "prod" } }] }] } }, errors: null }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

async function setup(env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  resetLoopGuard();
  resetWriteBudgetCache();
  ctx = await makeTestApp(env, fetchImpl ? { fetch: fetchImpl } : {});
  rooms.clear(); clearCallCache();
  ctx.deps.callRooms = { list: async (room) => rooms.get(room) ?? [] };
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const body = (await c.get("/api/account/me")).body;
  actor = { orgId: body.organization.id, userId: body.user.id, email: body.user.email, name: body.user.name, role: "owner" };
  const invite = await c.post("/api/team/invites", { email: "max@acme.io", role: "member" });
  const m = new Client(ctx.app);
  await m.signup("max@acme.io", "Max Member", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  mateId = (await m.get("/api/account/me")).body.user.id;
  pid = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
}
const followUps = async () => ((await c.get(`/api/tasks?projectId=${pid}`)).body.tasks as { title: string }[]).filter((t) => t.title.startsWith("Send notes and next steps"));
const many = async (n: number) => { const ids: string[] = []; for (let i = 0; i < n; i++) ids.push((await createTask(ctx.deps, actor, { title: `Task ${i}`, projectId: pid })).id); return ids; };

describe("meeting_ended from the call service", () => {
  beforeEach(() => setup());

  it("a call that empties fires meeting_ended once; later reads and leaves fire nothing more", async () => {
    await enableRecipe(ctx.deps, actor, "meeting_ended_task", { projectId: pid });
    const general = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const call = (await c.post(`/api/chat/channels/${general.id}/call`, {})).body;
    expect(await followUps()).toHaveLength(0);
    const left = await c.post(`/api/chat/calls/${call.meeting.id}/left`, {});
    expect(left.body.state).toBe("ended");
    expect(await followUps()).toHaveLength(1);
    await c.post(`/api/chat/calls/${call.meeting.id}/left`, {});
    await c.get(`/api/chat/channels/${general.id}/call`);
    expect(await followUps()).toHaveLength(1);
  });

  it("no rule: the call still ends and nothing else is written", async () => {
    const general = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const call = (await c.post(`/api/chat/channels/${general.id}/call`, {})).body;
    expect((await c.post(`/api/chat/calls/${call.meeting.id}/left`, {})).body.state).toBe("ended");
    expect(await followUps()).toHaveLength(0);
  });
});

describe("assignee_changed for bulk edits", () => {
  beforeEach(() => setup());

  it("runs the rules for each reassigned task, up to the cap, and counts the rest as skipped", async () => {
    await createAutomation(ctx.deps, actor, { name: "Tag", trigger: "assignee_changed", conditions: {}, action: "add_label", actionConfig: { label: "owned" } });
    const ids = await many(BULK_RULE_RUNS + 20);
    const r = await bulkUpdateTasks(ctx.deps, actor, ids, { assignee: { type: "member", id: mateId } });
    expect(r.updated).toBe(ids.length);
    expect(r.automationRuns).toEqual({ runs: BULK_RULE_RUNS, skipped: 20 });
    const labelled = (await Promise.all(ids.map((id) => getTask(ctx.deps, actor, id)))).filter((t) => t.labels.includes("owned"));
    expect(labelled).toHaveLength(BULK_RULE_RUNS);
    // Unassigning fires nothing (the single task path only fires with an assignee too).
    const off = await bulkUpdateTasks(ctx.deps, actor, ids.slice(0, 3), { assignee: null });
    expect(off.automationRuns).toBeUndefined();
  });

  it("no matching rule: nothing runs and the result carries no count", async () => {
    await createAutomation(ctx.deps, actor, { name: "Other project", trigger: "assignee_changed", conditions: { projectId: (await c.post("/api/projects", { name: "Other", key: "OTH" })).body.project.id }, action: "add_label", actionConfig: { label: "owned" } });
    const ids = await many(3);
    const r = await bulkUpdateTasks(ctx.deps, actor, ids, { assignee: { type: "member", id: mateId } });
    expect(r.automationRuns).toBeUndefined();
    expect((await getTask(ctx.deps, actor, ids[0])).labels).toEqual([]);
  });

  it("another workspace's rules never run on these tasks, and its task ids are not touched", async () => {
    const x = new Client(ctx.app);
    await x.signup("eve@evil.io", "Eve Other");
    const xb = (await x.get("/api/account/me")).body;
    const eve: SuiteActor = { orgId: xb.organization.id, userId: xb.user.id, email: xb.user.email, name: xb.user.name, role: "owner" };
    await createAutomation(ctx.deps, eve, { name: "Theirs", trigger: "assignee_changed", conditions: {}, action: "add_label", actionConfig: { label: "eve" } });
    const ids = await many(2);
    const r = await bulkUpdateTasks(ctx.deps, actor, ids, { assignee: { type: "member", id: mateId } });
    expect(r.automationRuns).toBeUndefined();
    expect((await getTask(ctx.deps, actor, ids[0])).labels).toEqual([]);
    // Eve's bulk edit can't reach Olive's tasks.
    const tried = await bulkUpdateTasks(ctx.deps, eve, ids, { assignee: { type: "member", id: eve.userId } }).catch((e: { status?: number }) => e);
    if ("updated" in (tried as object)) expect((tried as { updated: number }).updated).toBe(0);
    else expect((tried as { status?: number }).status).toBeGreaterThanOrEqual(400);
    expect((await getTask(ctx.deps, actor, ids[0])).assignee?.id).toBe(mateId);
  });
});

describe("write budget", () => {
  it("bulk assignee rules pause at warn; the bulk edit itself still goes through", async () => {
    await setup({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acc" }, analytics(65_000));
    await createAutomation(ctx.deps, actor, { name: "Tag", trigger: "assignee_changed", conditions: {}, action: "add_label", actionConfig: { label: "owned" } });
    const ids = await many(3);
    const r = await bulkUpdateTasks(ctx.deps, actor, ids, { assignee: { type: "member", id: mateId } });
    expect(r.updated).toBe(3);
    expect(r.automationRuns).toEqual({ runs: 0, skipped: 3 });
    expect((await getTask(ctx.deps, actor, ids[0])).labels).toEqual([]);
  });

  it("a call that empties at warn ends without running meeting_ended rules", async () => {
    await setup({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acc" }, analytics(65_000));
    await enableRecipe(ctx.deps, actor, "meeting_ended_task", { projectId: pid });
    const general = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const call = (await c.post(`/api/chat/channels/${general.id}/call`, {})).body;
    expect((await c.post(`/api/chat/calls/${call.meeting.id}/left`, {})).body.state).toBe("ended");
    expect(await followUps()).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { createTask, getTask, updateTask } from "@/server/services/suite/tasks";
import { createAutomation, listAutomations, updateAutomation } from "@/server/services/suite/automations";
import { MAX_EXTRA_ACTIONS, isR24Rule, resetLoopGuard } from "@/server/services/suite/automations-r24";
import { resetWriteBudgetCache } from "@/server/services/write-budget";
import { automations } from "@/server/db/schema";
import type { SuiteActor } from "@/server/services/suite/common";

/**
 * R55 (MB-140): several actions per rule. actionConfig.then carries up to MAX_EXTRA_ACTIONS more actions, each
 * checked like a first action and run in order after it, each seeing the task as the one before left it.
 */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let actor: SuiteActor;
let me: string;
let mate: string;
let pid: string;
let chan: string;

beforeEach(async () => {
  resetLoopGuard();
  resetWriteBudgetCache();
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const body = (await c.get("/api/account/me")).body;
  actor = { orgId: body.organization.id, userId: body.user.id, email: body.user.email, name: body.user.name, role: "owner" };
  me = body.user.id;
  const invite = await c.post("/api/team/invites", { email: "max@acme.io", role: "member" });
  const m = new Client(ctx.app);
  await m.signup("max@acme.io", "Max Member", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  mate = (await m.get("/api/account/me")).body.user.id;
  pid = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  chan = (await c.post("/api/chat/channels", { name: "bugs" })).body.channel.id;
});

const rule = (input: Parameters<typeof createAutomation>[2]) => createAutomation(ctx.deps, actor, input);
const messagesIn = async (channelId: string) => ((await c.get(`/api/chat/channels/${channelId}/messages`)).body.messages as { body: string }[]).map((x) => x.body);

describe("several actions per rule (R55, MB-140)", () => {
  it("runs the action and each extra action in order on one task, with one run counted", async () => {
    await rule({
      name: "Triage bugs", trigger: "task_created", conditions: { type: "bug" }, action: "set_priority", actionConfig: {
        priority: "high",
        then: [
          { action: "add_label", actionConfig: { label: "triage" } },
          { action: "add_label", actionConfig: { label: "customer" } },
          { action: "assign_task", actionConfig: { mode: "member", memberId: mate } },
          { action: "post_to_channel", actionConfig: { channelId: chan, message: "New bug {task.ref}" } },
        ],
      },
    });
    const bug = await createTask(ctx.deps, actor, { title: "Login fails", projectId: pid, type: "bug" });
    const now = await getTask(ctx.deps, actor, bug.id);
    expect(now.priority).toBe("high");
    expect(now.labels).toEqual(["triage", "customer"]); // the second label sees the first
    expect(now.assignee?.id).toBe(mate);
    expect((await messagesIn(chan)).some((x) => x === `New bug ${bug.ref}`)).toBe(true);
    const [r] = await listAutomations(ctx.deps, actor.orgId);
    expect(r.runCount).toBe(1);
    expect(r.lastError ?? null).toBeNull();
    // A plain task matches nothing.
    const plain = await createTask(ctx.deps, actor, { title: "Plain", projectId: pid });
    expect((await getTask(ctx.deps, actor, plain.id)).labels).toEqual([]);
  });

  it("an old engine rule with extra actions runs in the newer engine (status_changed notify, then a label)", async () => {
    const cfg = { to: "assignee", then: [{ action: "add_label", actionConfig: { label: "shipped" } }] };
    expect(isR24Rule({ trigger: "status_changed", action: "notify", conditions: { toCategory: "done" }, actionConfig: cfg })).toBe(true);
    expect(isR24Rule({ trigger: "status_changed", action: "notify", conditions: { toCategory: "done" }, actionConfig: { to: "assignee" } })).toBe(false);
    await rule({ name: "Done", trigger: "status_changed", conditions: { toCategory: "done" }, action: "notify", actionConfig: cfg });
    const t = await createTask(ctx.deps, actor, { title: "Ship it", projectId: pid, assignee: { type: "member", id: me } });
    const done = (await c.get(`/api/projects/${pid}`)).body.project.statuses.find((s: { category: string }) => s.category === "done");
    await updateTask(ctx.deps, actor, t.id, { statusId: done.id });
    expect((await getTask(ctx.deps, actor, t.id)).labels).toEqual(["shipped"]);
  });

  it("round robin as an extra action keeps its turn in the rule", async () => {
    await rule({ name: "Share", trigger: "task_created", conditions: {}, action: "add_label", actionConfig: { label: "new", then: [{ action: "assign_task", actionConfig: { mode: "round_robin", memberIds: [me, mate] } }] } });
    const got: string[] = [];
    for (const n of [1, 2, 3]) got.push((await getTask(ctx.deps, actor, (await createTask(ctx.deps, actor, { title: `RR ${n}`, projectId: pid })).id)).assignee!.id);
    expect(got).toEqual([me, mate, me]);
    const row = await ctx.db.select().from(automations).where(eq(automations.orgId, actor.orgId)).get();
    const saved = JSON.parse(row!.actionConfig);
    expect(saved.label).toBe("new");
    expect(saved.then[0].actionConfig.next).toBe(1);
  });

  it("a failing extra action stops the rest and names its place", async () => {
    await rule({ name: "Lead", trigger: "task_created", conditions: {}, action: "add_label", actionConfig: { label: "a", then: [{ action: "assign_task", actionConfig: { mode: "lead" } }, { action: "add_label", actionConfig: { label: "b" } }] } });
    const t = await createTask(ctx.deps, actor, { title: "No lead", projectId: pid });
    expect((await getTask(ctx.deps, actor, t.id)).labels).toEqual(["a"]);
    const [r] = await listAutomations(ctx.deps, actor.orgId);
    expect(r.lastError).toMatch(/^Action 2: The project has no lead/);
  });

  it("checks each extra action like a first one: count, shape, trigger fit, ids and no nesting", async () => {
    const base = { name: "x", trigger: "task_created" as const, conditions: {}, action: "add_label" as const };
    const tooMany = Array.from({ length: MAX_EXTRA_ACTIONS + 1 }, (_, i) => ({ action: "add_label", actionConfig: { label: `l${i}` } }));
    await expect(rule({ ...base, actionConfig: { label: "a", then: tooMany } })).rejects.toMatchObject({ status: 422 });
    await expect(rule({ ...base, actionConfig: { label: "a", then: "nope" } })).rejects.toMatchObject({ status: 422 });
    await expect(rule({ ...base, actionConfig: { label: "a", then: [{ actionConfig: {} }] } })).rejects.toMatchObject({ status: 422 });
    await expect(rule({ ...base, actionConfig: { label: "a", then: [{ action: "set_priority", actionConfig: { priority: "huge" } }] } })).rejects.toMatchObject({ status: 422 });
    await expect(rule({ ...base, actionConfig: { label: "a", then: [{ action: "add_label", actionConfig: { label: "b", then: [] } }] } })).rejects.toMatchObject({ status: 422 });
    await expect(rule({ ...base, actionConfig: { label: "a", then: [{ action: "assign_thread", actionConfig: {} }] } })).rejects.toMatchObject({ status: 422 });
    // Chat rules take notify, create_task and post_to_channel only, in any place.
    await expect(rule({ name: "c", trigger: "chat_message_posted", conditions: { keyword: "bug" }, action: "notify", actionConfig: { to: "admins", then: [{ action: "set_priority", actionConfig: { priority: "high" } }] } })).rejects.toMatchObject({ status: 422 });
    // Another workspace's channel is refused in an extra action too.
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve");
    const theirs = (await other.post("/api/chat/channels", { name: "theirs" })).body.channel.id;
    expect((await c.post("/api/automations", { ...base, actionConfig: { label: "a", then: [{ action: "post_to_channel", actionConfig: { channelId: theirs } }] } })).status).toBe(422);
    expect((await listAutomations(ctx.deps, actor.orgId)).length).toBe(0);
    // The API takes a good one, and an empty list is dropped.
    const ok = await c.post("/api/automations", { ...base, actionConfig: { label: "a", then: [{ action: "set_priority", actionConfig: { priority: "low" } }] } });
    expect(ok.status).toBe(201);
    const id = (ok.body.automation ?? ok.body).id as string;
    const upd = await updateAutomation(ctx.deps, actor, id, { actionConfig: { label: "a", then: [] } });
    expect((upd.actionConfig as Record<string, unknown>).then).toBeUndefined();
  });
});

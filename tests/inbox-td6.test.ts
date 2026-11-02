/** TD6 One inbox: rule sorting, remembered moves, snooze wakeup, read state, permission filtering (other workspace and
 * mailbox scope 404), flag off, vv8k, bulk limits, AI off means no provider call, and nothing about an item in the logs. */
import { describe, it, expect, vi } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { eq, sql } from "drizzle-orm";
import { messages, notifications, tasks } from "@/server/db/schema";
import { clearRefCacheForTests } from "@/server/services/inbox-td6";
import { inboxKeyAction, isMentionType, mailRead, ruleKey, ruleLabel, sortItem, sourceOfNote, viewOf } from "@/shared/inbox-td6";

describe("TD6 pure rules", () => {
  it("sorts by remembered choice first, then by kind", () => {
    expect(sortItem({ kind: "note", type: "chat.mention" }).lane).toBe("important");
    expect(sortItem({ kind: "note", type: "record.mentioned" }).reason).toBe("Mentioned you");
    expect(sortItem({ kind: "note", type: "task.assigned" }).reason).toBe("Assigned to you");
    expect(sortItem({ kind: "note", type: "task.due_soon" }).lane).toBe("important");
    expect(sortItem({ kind: "note", type: "chat.dm" }).lane).toBe("important");
    expect(sortItem({ kind: "note", type: "task.watch_status" }).lane).toBe("noise");
    expect(sortItem({ kind: "note", type: "automation.email" }).reason).toBe("Automated");
    expect(sortItem({ kind: "note", type: "some.new_type" }).lane).toBe("noise");
    expect(sortItem({ kind: "mail", mailImportant: true }).lane).toBe("important");
    expect(sortItem({ kind: "mail", mailImportant: true, mailBulk: true }).lane).toBe("noise");
    expect(sortItem({ kind: "mail" }).lane).toBe("noise");
    expect(sortItem({ kind: "run", type: "succeeded" }).lane).toBe("important");
    expect(sortItem({ kind: "run", type: "succeeded", runAutomated: true }).lane).toBe("noise");
    expect(sortItem({ kind: "run", type: "failed", runAutomated: true }).lane).toBe("important");
    expect(sortItem({ kind: "mail", mailBulk: true }, "important")).toEqual({ lane: "important", reason: "You keep these in Important", remembered: true });
    expect(sortItem({ kind: "note", type: "chat.mention" }, "noise").lane).toBe("noise");
    expect(sortItem({ kind: "ref" })).toEqual({ lane: "important", reason: "Your task was mentioned", remembered: false });
    expect(ruleKey({ kind: "ref", entityType: "task", entityId: "t9" })).toBe("src:task:t9");
  });
  it("keys, labels, sources, views, read state and keys", () => {
    expect(ruleKey({ kind: "mail", sender: " Ann@X.io " })).toBe("sender:ann@x.io");
    expect(ruleKey({ kind: "mail", sender: "not an address" })).toBeNull();
    expect(ruleKey({ kind: "run", agentId: "u1" })).toBe("agent:u1");
    expect(ruleKey({ kind: "note", type: "chat.dm", entityType: "chat_message", entityId: "m1", channelId: "c1" })).toBe("src:channel:c1");
    expect(ruleKey({ kind: "note", type: "task.assigned", entityType: "task", entityId: "t1" })).toBe("src:task:t1");
    expect(ruleLabel("src:task:t1")).toBe("A task");
    expect(ruleLabel("sender:ann@x.io")).toBe("ann@x.io");
    expect(isMentionType("doc.mentioned")).toBe(true);
    expect(sourceOfNote("chat.reply")).toBe("chat");
    expect(sourceOfNote("task.recurred")).toBe("task");
    expect(sourceOfNote("goal.updated")).toBe("other");
    const now = new Date("2026-11-02T10:00:00Z");
    expect(viewOf({ snoozedUntil: new Date("2026-11-03T00:00:00Z") }, now)).toBe("later");
    expect(viewOf({ snoozedUntil: new Date("2026-11-02T09:00:00Z") }, now)).toBe("inbox");
    expect(viewOf({ doneAt: now }, now)).toBe("done");
    expect(mailRead(null, true)).toBe(true);
    expect(mailRead(false, true)).toBe(false);
    expect(inboxKeyAction({ key: "j" })).toBe("next");
    expect(inboxKeyAction({ key: "e" })).toBe("done");
    expect(inboxKeyAction({ key: "s" })).toBe("snooze");
    expect(inboxKeyAction({ key: "e", metaKey: true })).toBeNull();
  });
});

async function verifiedDomain(ctx: Awaited<ReturnType<typeof makeTestApp>>, c: Client, name: string) {
  const domainId = (await c.post("/api/domains", { name })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
  return domainId;
}

async function setup(env: Record<string, string> = { INBOX_TD6: "on" }) {
  let calls = 0;
  const ctx = await makeTestApp(env, { fetch: (async () => { calls++; throw new Error("network disabled in tests"); }) as typeof fetch });
  const owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner", "Acme");
  const me = (await owner.get("/api/account/me")).body;
  const orgId: string = me.organization.id;
  const userId: string = me.user?.id ?? me.id;
  const domainId = await verifiedDomain(ctx, owner, "acme.io");
  const mailboxId: string = (await owner.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" })).body.mailbox.id;
  const now = Date.now();
  const mail = (id: string, folder: string, from: string, subject: string, extra: Record<string, unknown> = {}) => ctx.db.insert(messages).values({
    id, orgId, mailboxId, folder, threadId: `thr_${id}`, fromAddress: from, fromName: "", to: JSON.stringify([{ name: "", address: "team@acme.io" }]),
    subject, snippet: "", date: new Date(now - 60_000 * Number(id.replace(/\D/g, "") || 1)), ...extra,
  } as typeof messages.$inferInsert);
  await mail("m1", "sent", "team@acme.io", "Quote", { to: JSON.stringify([{ name: "", address: "alice@client.io" }]) });
  await mail("m2", "inbox", "alice@client.io", "Secret plan TD6");
  await mail("m3", "inbox", "stranger@other.io", "Hello there");
  await mail("m4", "inbox", "news@letters.io", "Weekly news", { isBulk: true });
  const note = (id: string, type: string, title: string) => ctx.db.insert(notifications).values({ id, orgId, userId, type, entityType: "task", entityId: `t_${id}`, title, createdAt: new Date(now - 1000) });
  await note("n1", "task.mentioned", "Olive was mentioned on Launch");
  await note("n2", "task.watch_status", "Status changed on Launch");
  return { ctx, owner, orgId, userId, mailboxId, calls: () => calls };
}

const ids = (b: { items: { kind: string; id: string }[] }) => b.items.map((i) => `${i.kind}:${i.id}`).sort();

describe("TD6 One inbox API", () => {
  it("is 404 with the flag off (today exactly) and 401 signed out", async () => {
    const { owner, ctx } = await setup({});
    expect((await owner.get("/api/one-inbox")).status).toBe(404);
    expect((await new Client(ctx.app).get("/api/one-inbox")).status).toBe(401);
    expect((await owner.get("/api/config")).body?.inboxTd6 ?? false).toBe(false);
  });

  it("sorts Important and Noise by rules, remembers a move per sender, and forgets it on remove", async () => {
    const { owner, calls } = await setup();
    const imp = await owner.get("/api/one-inbox?lane=important");
    expect(imp.status).toBe(200);
    expect(ids(imp.body)).toEqual(["mail:m2", "note:n1"]);
    const noise = await owner.get("/api/one-inbox?lane=noise");
    expect(ids(noise.body)).toEqual(["mail:m3", "mail:m4", "note:n2"]);
    expect(noise.body.items.find((i: { id: string }) => i.id === "m4").reason).toBe("Newsletter or automated");
    expect(imp.body.counts).toMatchObject({ important: 2, noise: 3, importantUnread: 2 });
    expect((await owner.get("/api/one-inbox?lane=noise&source=mail")).body.items).toHaveLength(2);
    const mv = await owner.post("/api/one-inbox/move", { kind: "mail", id: "m3", lane: "important" });
    expect(mv.status).toBe(200);
    expect(mv.body.key).toBe("sender:stranger@other.io");
    const after = await owner.get("/api/one-inbox?lane=important");
    expect(ids(after.body)).toContain("mail:m3");
    expect(after.body.items.find((i: { id: string }) => i.id === "m3")).toMatchObject({ remembered: true, reason: "You keep these in Important" });
    expect((await owner.get("/api/one-inbox/rules")).body.rules).toHaveLength(1);
    expect((await owner.call("DELETE", "/api/one-inbox/rules", { key: "sender:stranger@other.io" })).status).toBe(200);
    expect(ids((await owner.get("/api/one-inbox?lane=important")).body)).not.toContain("mail:m3");
    expect((await owner.call("DELETE", "/api/one-inbox/rules", { key: "sender:nobody@x.io" })).status).toBe(404);
    // A note moves by its source record.
    expect((await owner.post("/api/one-inbox/move", { kind: "note", id: "n2", lane: "important" })).body.key).toBe("src:task:t_n2");
    expect(calls()).toBe(0); // AI off and rules only: no provider call at all
  });

  it("done, undo, read, unread and snooze with wakeup, for mail and notes", async () => {
    const { owner, ctx } = await setup();
    expect((await owner.post("/api/one-inbox/act", { action: "done", items: [{ kind: "mail", id: "m2" }, { kind: "note", id: "n1" }] })).status).toBe(200);
    expect((await owner.get("/api/one-inbox?lane=important")).body.items).toHaveLength(0);
    expect(ids((await owner.get("/api/one-inbox?lane=important&view=done")).body)).toEqual(["mail:m2", "note:n1"]);
    await owner.post("/api/one-inbox/act", { action: "undone", items: [{ kind: "mail", id: "m2" }, { kind: "note", id: "n1" }] });
    await owner.post("/api/one-inbox/act", { action: "read", items: [{ kind: "mail", id: "m2" }] });
    let m2 = (await owner.get("/api/one-inbox?lane=important")).body.items.find((i: { id: string }) => i.id === "m2");
    expect(m2.read).toBe(true);
    await owner.post("/api/one-inbox/act", { action: "unread", items: [{ kind: "mail", id: "m2" }] });
    m2 = (await owner.get("/api/one-inbox?lane=important")).body.items.find((i: { id: string }) => i.id === "m2");
    expect(m2.read).toBe(false);
    const sz = await owner.post("/api/one-inbox/act", { action: "snooze", preset: "tomorrow", items: [{ kind: "mail", id: "m2" }, { kind: "note", id: "n1" }] });
    expect(sz.status).toBe(200);
    expect(ids((await owner.get("/api/one-inbox?lane=important&view=later")).body)).toEqual(["mail:m2", "note:n1"]);
    expect((await owner.get("/api/one-inbox/count")).body.unread).toBe(0);
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + 3 * 86_400_000);
    const back = await owner.get("/api/one-inbox?lane=important");
    expect(ids(back.body)).toEqual(["mail:m2", "note:n1"]);
    expect(back.body.items.every((i: { read: boolean }) => !i.read)).toBe(true);
    ctx.deps.now = real;
    expect((await owner.post("/api/one-inbox/act", { action: "snooze", until: "2020-01-01T00:00:00Z", items: [{ kind: "mail", id: "m2" }] })).status).toBe(422);
  });

  it("another workspace, a member without the mailbox and a made up id all answer 404; limits hold", async () => {
    const { owner, ctx } = await setup();
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve", "Evil");
    expect((await other.get("/api/one-inbox?lane=important")).body.items).toHaveLength(0);
    for (const it of [{ kind: "mail", id: "m2" }, { kind: "note", id: "n1" }, { kind: "run", id: "run_x" }]) {
      expect((await other.post("/api/one-inbox/act", { action: "done", items: [it] })).status).toBe(404);
      expect((await other.post("/api/one-inbox/move", { ...it, lane: "noise" })).status).toBe(404);
    }
    // A member of the same workspace with no access to the mailbox sees no mail and cannot act on it.
    const inv = await owner.post("/api/team/invites", { email: "mia@acme.io", role: "member" });
    const mia = new Client(ctx.app);
    await mia.signup("mia@acme.io", "Mia", "Mia Co");
    expect((await mia.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    const all = [...(await mia.get("/api/one-inbox?lane=important")).body.items, ...(await mia.get("/api/one-inbox?lane=noise")).body.items];
    expect(all.filter((i: { kind: string }) => i.kind === "mail")).toHaveLength(0);
    expect((await mia.post("/api/one-inbox/act", { action: "read", items: [{ kind: "mail", id: "m2" }] })).status).toBe(404);
    // All or nothing: one bad item stops the whole bulk change.
    expect((await owner.post("/api/one-inbox/act", { action: "done", items: [{ kind: "mail", id: "m2" }, { kind: "mail", id: "nope" }] })).status).toBe(404);
    expect((await owner.get("/api/one-inbox?lane=important")).body.items).toHaveLength(2);
    const many = Array.from({ length: 201 }, (_, i) => ({ kind: "mail", id: `x${i}` }));
    expect((await owner.post("/api/one-inbox/act", { action: "done", items: many })).status).toBe(422);
    expect((await owner.post("/api/one-inbox/act", { action: "explode", items: [{ kind: "mail", id: "m2" }] })).status).toBe(422);
    expect((await owner.get("/api/one-inbox?lane=elsewhere")).status).toBe(422);
  });

  it("keeps the vv8k workspace out and logs nothing about items", async () => {
    const { owner, ctx } = await setup();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k));
    await owner.get("/api/one-inbox?lane=important");
    await owner.post("/api/one-inbox/act", { action: "done", items: [{ kind: "mail", id: "m2" }] });
    await owner.post("/api/one-inbox/act", { action: "done", items: [{ kind: "mail", id: "missing" }] });
    const said = spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))).join("\n");
    expect(said).not.toContain("Secret plan TD6");
    expect(said).not.toContain("alice@client.io");
    spies.forEach((s) => s.mockRestore());
    const v = new Client(ctx.app);
    await v.signup("v@vv8k.io", "V", "vv8k");
    expect((await v.get("/api/one-inbox")).status).toBe(404);
  });
});

describe("TD6 mentions adapter (TD5 record_refs)", () => {
  async function setupRefs(env: Record<string, string> = { INBOX_TD6: "on", MENTIONS_TD5: "on" }) {
    const ctx = await makeTestApp(env);
    const admin = new Client(ctx.app);
    await admin.signup("ada@acme.io", "Ada Lovelace", "Acme");
    const inv = await admin.post("/api/team/invites", { email: "bo@acme.io", role: "member" });
    const member = new Client(ctx.app);
    await member.signup("bo@acme.io", "Bo Member", "Bo Co");
    expect((await member.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    const meB = (await member.get("/api/account/me")).body;
    const memberId: string = meB.user?.id ?? meB.id;
    const proj = (await admin.post("/api/projects", { name: "Launch" })).body.project;
    const task = (await admin.post("/api/tasks", { projectId: proj.id, title: "Ship the launch" })).body.task;
    await ctx.db.update(tasks).set({ assigneeType: "member", assigneeId: memberId }).where(eq(tasks.id, task.id));
    const general = (await admin.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
    return { ctx, admin, member, memberId, task, general };
  }
  const refItems = (b: { items: { kind: string; id: string; title: string; link: string }[] }) => b.items.filter((i) => i.kind === "ref");

  it("a teammate's mention of my task is Important, opens where it was written, and takes done and moves", async () => {
    clearRefCacheForTests();
    const t = await setupRefs();
    await t.admin.post(`/api/chat/channels/${t.general.id}/messages`, { body: `please look at <#task:${t.task.id}> today` });
    const list = (await t.member.get("/api/one-inbox?lane=important")).body;
    const refs = refItems(list);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ source: "mention", lane: "important", reason: "Your task was mentioned", who: "Ada Lovelace", read: false });
    expect(refs[0].title).toContain("Ship the launch");
    expect(refs[0].link).toMatch(/^\/app\//);
    expect((await t.member.get("/api/one-inbox/count")).body.unread).toBeGreaterThanOrEqual(1);
    const ref = { kind: "ref", id: refs[0].id };
    expect((await t.member.post("/api/one-inbox/act", { action: "done", items: [ref] })).status).toBe(200);
    expect(refItems((await t.member.get("/api/one-inbox?lane=important")).body)).toHaveLength(0);
    expect(refItems((await t.member.get("/api/one-inbox?lane=important&view=done")).body)).toHaveLength(1);
    const mv = await t.member.post("/api/one-inbox/move", { ...ref, lane: "noise" });
    expect(mv.status).toBe(200);
    expect(mv.body.key).toBe(`src:task:${t.task.id}`);
    // The author sees nothing for their own words, and nobody else can act on the item.
    expect(refItems((await t.admin.get("/api/one-inbox?lane=important")).body)).toHaveLength(0);
    expect((await t.admin.post("/api/one-inbox/act", { action: "read", items: [ref] })).status).toBe(404);
    expect((await t.member.post("/api/one-inbox/act", { action: "read", items: [{ kind: "ref", id: "chat~nope~" + t.task.id }] })).status).toBe(404);
    expect((await t.member.post("/api/one-inbox/act", { action: "read", items: [{ kind: "ref", id: "x".repeat(201) }] })).status).toBe(422);
  });

  it("a mention I cannot open (private channel) never shows; mentions off shows none", async () => {
    clearRefCacheForTests();
    const t = await setupRefs();
    const priv = (await t.admin.post("/api/chat/channels", { name: "secret", private: true })).body.channel;
    await t.admin.post(`/api/chat/channels/${priv.id}/messages`, { body: `secret plan for <#task:${t.task.id}>` });
    const [{ n }] = await t.ctx.db.all<{ n: number }>(sql`select count(*) as n from record_refs where target_type = 'task' and target_id = ${t.task.id}`);
    expect(Number(n)).toBe(1); // indexed by TD5, hidden by its References check
    expect(refItems((await t.member.get("/api/one-inbox?lane=important")).body)).toHaveLength(0);
    clearRefCacheForTests();
    const off = await setupRefs({ INBOX_TD6: "on" });
    await off.admin.post(`/api/chat/channels/${off.general.id}/messages`, { body: `look at <#task:${off.task.id}>` });
    expect(refItems((await off.member.get("/api/one-inbox?lane=important")).body)).toHaveLength(0);
  });
});

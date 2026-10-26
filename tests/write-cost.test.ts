import { it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { runMaintenance } from "@/server/services/maintenance";
import { deliverInbound } from "@/server/services/mail/delivery";
import { fakeIdpR25, R25_IDP, socialSignIn } from "./fake-idp-r25"; // R25 social sign in

/**
 * Write costs in D1 terms: D1 bills a written row once for the table and once for every index on it,
 * and the account has 100,000 a day shared by production and staging. These ceilings keep the
 * measured costs (24 October 2026) from creeping back up. docs/runbooks/d1-daily-limits.md has the table.
 */
function meter(db: unknown) {
  const c = (db as { $client: { prepare: (q: string) => Record<string, (...a: unknown[]) => unknown> } }).$client;
  const idx = new Map<string, number>();
  // R21: a partial index (CREATE INDEX ... WHERE) only holds the rows its WHERE matches, so a row outside it costs
  // nothing there. Full indexes count once per written row; a partial index counts the entries that came or went.
  for (const r of c.prepare("select tbl_name t, count(*) n from sqlite_master where type='index' and (sql is null or sql not like '% WHERE %') group by tbl_name").all() as { t: string; n: number }[]) idx.set(r.t, r.n);
  const partial = new Map<string, string[]>();
  for (const r of c.prepare("select tbl_name t, sql from sqlite_master where type='index' and sql like '% WHERE %'").all() as { t: string; sql: string }[]) partial.set(r.t, [...(partial.get(r.t) ?? []), r.sql.slice(r.sql.search(/ WHERE /i) + 7)]);
  const prepare = c.prepare.bind(c);
  const changes = () => (prepare("select total_changes() n").get() as { n: number }).n;
  const members = (table: string) => (partial.get(table) ?? []).map((w) => (prepare(`select count(*) n from "${table}" where ${w}`).get() as { n: number }).n);
  let total = 0;
  c.prepare = (q: string) => {
    const st = prepare(q);
    const table = /^\s*(?:insert(?: or \w+)? into|update|delete from)\s+["`]?(\w+)/i.exec(q)?.[1];
    if (!table) return st;
    for (const fn of ["run", "all", "get"]) {
      const orig = st[fn].bind(st);
      st[fn] = (...a: unknown[]) => {
        const before = changes(); const inBefore = members(table);
        const r = orig(...a);
        const inAfter = members(table);
        total += (changes() - before) * (1 + (idx.get(table) ?? 0)) + inAfter.reduce((n, v, i) => n + Math.abs(v - inBefore[i]), 0);
        return r;
      };
    }
    return st;
  };
  return () => { const n = total; total = 0; return n; };
}

it("keeps sign in, an idle cron pass and a demo inside their write ceilings", async () => {
  const ctx = await makeTestApp({ DEMO_MODE: "true" });
  const take = meter(ctx.db);
  const u = new Client(ctx.app);
  const email = await u.signup();
  take();
  // Measured 10: the session row (3 indexes) plus the local rate limit counter, which production keeps in a binding.
  expect((await new Client(ctx.app).login(email)).status).toBe(200);
  expect(take()).toBeLessThanOrEqual(12);
  await u.get("/api/account/me"); await u.get("/api/dashboard"); await u.get("/api/mail/messages?folder=inbox");
  expect(take()).toBe(0);
  await runMaintenance(ctx.deps);
  take();
  await runMaintenance(ctx.deps);
  // Measured 3: one uptime row. Nothing else writes when nothing changed.
  expect(take()).toBeLessThanOrEqual(5);
  await new Client(ctx.app).post("/api/account/demo");
  take();
  const d = new Client(ctx.app);
  await d.post("/api/account/demo");
  await d.post("/api/account/demo/seed");
  await d.get("/api/tasks");
  // Measured 967 for the workspace and both seed parts; the purge a day later deletes about as many.
  expect(take()).toBeLessThanOrEqual(1_100);
});

it("MCP OAuth (round 20): registration, sign in, token exchange and refresh stay small; MCP reads write nothing", async () => {
  const { pkceChallenge } = await import("@/server/services/developer/oauth");
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup();
  const take = meter(ctx.db);
  const h = { host: "localhost" };
  const reg = await (await ctx.app.request("/api/oauth/register", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] }) })).json() as { client_id: string };
  // Measured 5: 1 client row (no index) plus the local rate limit counter (4), which production keeps in a binding.
  const m1 = take(); expect(m1).toBeLessThanOrEqual(5);
  const verifier = "x".repeat(50);
  const request = { client_id: reg.client_id, redirect_uri: "https://claude.ai/cb", response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256" };
  const code = new URL((await u.post("/api/oauth/authorize", { decision: "allow", request })).body.redirectTo).searchParams.get("code")!;
  // Measured 10: the grant row and its one index (2), the audit row and its indexes, and the local app limiter.
  const m2 = take(); expect(m2).toBeLessThanOrEqual(10);
  const form = (o: Record<string, string>) => ({ method: "POST", headers: { ...h, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
  const t = await (await ctx.app.request("/api/oauth/token", form({ grant_type: "authorization_code", code, client_id: reg.client_id, code_verifier: verifier }))).json() as { access_token: string; refresh_token: string };
  const m3 = take(); expect(m3).toBeLessThanOrEqual(6); // grant update (2) + local limiter
  const call = () => ctx.app.request("/api/v1/mcp", { method: "POST", headers: { ...h, authorization: `Bearer ${t.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  for (let i = 0; i < 5; i++) expect((await call()).status).toBe(200);
  // Measured 15: only the local api limiter (3 a call, a binding in production). The grant's last used was written at the exchange and waits an hour.
  const mcpWrites = take(); console.log('W mcp', mcpWrites);
  expect(mcpWrites).toBeLessThanOrEqual(15);
  await ctx.app.request("/api/oauth/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token }));
  const m4 = take(); expect(m4).toBeLessThanOrEqual(6); // rotated refresh hash (2) + local limiter
});

it("chat polish (round 20): a reaction add or remove is 2 rows, polls and search write nothing, a call is one meeting and one message", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup();
  const g = ((await u.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
  const m = (await u.post(`/api/chat/channels/${g.id}/messages`, { body: "hello" })).body.message as { id: string };
  await u.post(`/api/chat/channels/${g.id}/read`, {});
  const take = meter(ctx.db);
  // The local app limiter writes on posts in tests (a binding in production); measure it to subtract.
  await u.post("/api/chat/channels/nope/read", {});
  const limiter = take();
  await u.post(`/api/chat/messages/${m.id}/reactions`, { emoji: "\u{1F44D}" });
  // Measured 2: the chat_reactions row and its primary key. No counter on chat_messages.
  expect(take() - limiter).toBe(2);
  await u.post(`/api/chat/messages/${m.id}/reactions`, { emoji: "\u{1F44D}" });
  expect(take() - limiter).toBe(2);
  // The poll that carries reactions to other people, search and first unread are reads.
  await u.get(`/api/chat/channels/${g.id}/messages?limit=100`);
  await u.get("/api/chat/search?q=hello");
  await u.get(`/api/chat/channels/${g.id}/first-unread`);
  expect(take()).toBe(0);
  await u.post(`/api/chat/channels/${g.id}/call`, {});
  const call = take() - limiter;
  // Measured 23: one meetings row (5 with its indexes) and one chat message (5), the channel's last
  // message time (4), the caller's read marker (3) and the meeting's activity and change rows.
  // Round 21 adds the channel's call claim (4), so two people pressing Call make one meeting.
  expect(call).toBeLessThanOrEqual(28);
  // A second press within a minute joins that call: the claim is refused and nothing is written.
  await u.post(`/api/chat/channels/${g.id}/call`, {});
  expect(take() - limiter).toBe(0);
});
it("search everything and My Work (round 20) write nothing, for a person and through the services an agent key uses", async () => {
  const ctx = await makeTestApp({ DEMO_MODE: "true" });
  const d = new Client(ctx.app);
  await d.post("/api/account/demo");
  await d.post("/api/account/demo/seed");
  await d.get("/api/tasks");
  await d.get("/api/chat/channels");
  const me = (await d.get("/api/account/me")).body;
  const take = meter(ctx.db);
  const times: number[] = [];
  for (const q of ["launch", "invoice", "the", "zz-nothing", "TSK-1"]) {
    const r = await d.get(`/api/search?q=${encodeURIComponent(q)}`);
    expect(r.status).toBe(200);
    times.push(r.body.tookMs);
  }
  const w = await d.get("/api/my-work");
  expect(w.status).toBe(200);
  console.log("search ms on the seeded demo", times.join(", "), "my work ms", w.body.tookMs);
  expect(take()).toBe(0);
  const { searchEverything, myWork } = await import("@/server/services/search");
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  await searchEverything(ctx.deps, { kind: "actor", actor: { ...actor, agentId: "agt_none", apiKeyId: "key_x", scope: "read" } }, "launch", { types: ["tasks", "docs", "chat", "contacts", "deals"] });
  await myWork(ctx.deps, { ...actor, apiKeyId: "key_x", scope: "read" });
  expect(take()).toBe(0);
});
it("work tool import (round 20): about 8 rows a task, 2 a comment, and a re-run of the same file writes nothing", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Owner Person");
  const project = (await u.post("/api/projects", { name: "Web" })).body.project as { id: string };
  const lines = ["Task ID,Name,Section/Column,Assignee Email,Due Date,Parent task"];
  for (let i = 0; i < 100; i++) lines.push(`${9000 + i},Task ${i},${["To do", "In progress", "Done"][i % 3]},owner@acme.io,2026-11-0${(i % 9) + 1},${i % 2 ? `Task ${i - 1}` : ""}`);
  const content = lines.join("\n");
  const take = meter(ctx.db);
  await u.post("/api/work-imports/preview", { content });
  expect(take()).toBeLessThanOrEqual(4); // reads only; the local rate limiter at most
  const r = await u.post("/api/work-imports/run", { content, projectId: project.id });
  expect(r.body.created).toBe(100);
  const tasksRun = take();
  // Measured 819: 8 a task (the row, its key and 6 indexes including the import key), plus 2 batches (number claim and day counter) and the summary activity and change rows.
  // Round 21: the meter bills the partial sprint index on tasks too (9 a task, measured 919), though D1 writes no entry for a task with no sprint.
  expect(tasksRun).toBeLessThanOrEqual(100 * 9 + 30);
  const again = await u.post("/api/work-imports/run", { content, projectId: project.id });
  expect(again.body).toMatchObject({ created: 0, alreadyThere: 100 });
  expect(take()).toBeLessThanOrEqual(4);
  const trello = readFileSync(join(__dirname, "fixtures/import/trello.json"), "utf8");
  await u.post("/api/work-imports/run", { content: trello, projectId: project.id });
  // Measured 66: 5 tasks, 2 comments, 2 new statuses for the board's lists, one batch and the summary.
  const withComments = take();
  expect(withComments).toBeLessThanOrEqual(5 * 8 + 2 * 2 + 30);
});

it("mail schedules (round 20): an idle pass writes 0 rows; snooze, send later and reminders cost 2 rows a step", async () => {
  const { runMailSchedules } = await import("@/server/services/mail/schedules");
  const { messages } = await import("@/server/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup();
  const domainId = (await u.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await u.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await u.post(`/api/domains/${domainId}/verify`);
  const a = (await u.post("/api/mailboxes", { domainId, localPart: "a", displayName: "A" })).body.mailbox;
  const b = (await u.post("/api/mailboxes", { domainId, localPart: "b", displayName: "B" })).body.mailbox;
  await u.post("/api/mail/send", { mailboxId: b.id, to: [a.address], subject: "Hi", text: "x" });
  const msg = (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, a.id), eq(messages.folder, "inbox"))).get())!;
  const take = meter(ctx.db);
  // Idle: nothing scheduled, and then nothing due yet. Reads only.
  await runMailSchedules(ctx.deps);
  expect(take()).toBe(0);
  const at = new Date(Date.now() + 3_600_000).toISOString();
  await u.post("/api/mail-schedules/snooze", { messageId: msg.id, at });
  await u.post("/api/mail-schedules/send", { message: { mailboxId: a.id, to: ["bob@example.com"], subject: "Later", text: "x" }, at });
  take();
  await runMailSchedules(ctx.deps);
  await runMaintenance(ctx.deps);
  take();
  await runMailSchedules(ctx.deps);
  // Measured 0: two items waiting, none due.
  expect(take()).toBe(0);
  // Due: the snooze comes back (2) and the send is claimed (2) before the normal send path writes its own rows.
  const due = new Date(Date.now() + 2 * 3_600_000);
  await runMailSchedules(ctx.deps, { now: due });
  const sendRows = take();
  // Measured 43: 4 for the two schedule rows (one returned, one claimed); the rest is the normal send
  // path the scheduled message goes through (the Sent copy, the delivery log, the audit row, contacts).
  expect(sendRows).toBeLessThanOrEqual(45);
});

it("task types and epics (round 21): a type change is a normal task update; adding N items to an epic is one batch", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup();
  const projectId = (await u.post("/api/projects", { name: "Epics" })).body.project.id;
  const epic = (await u.post("/api/tasks", { title: "Epic", projectId, type: "epic" })).body.task;
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await u.post("/api/tasks", { title: `Item ${i}`, projectId })).body.task.id);
  const take = meter(ctx.db);
  await u.patch(`/api/tasks/${ids[0]}`, { title: "Item renamed" });
  const titleWrites = take();
  await u.patch(`/api/tasks/${ids[0]}`, { type: "bug" });
  const typeWrites = take();
  // Setting a type costs what any other field change costs: the task row and its indexes, plus the activity and change entries.
  expect(typeWrites).toBe(titleWrites);
  await u.post(`/api/epics/${epic.id}/items`, { ids });
  const addWrites = take();
  // Measured 57 for 5 items: each task row with its indexes (8) and its change entry (2), one activity entry on the epic (4),
  // and the local rate limit counter (3), which production keeps in a binding. A type change measured 17 (8 + 2 + 4 + 3).
  expect(addWrites).toBeLessThanOrEqual(5 * 10 + 4 + 3);
  // Reading epics and their progress writes nothing.
  await u.get(`/api/epics?project=${projectId}`); await u.get(`/api/epics/${epic.id}`); await u.get(`/api/tasks?projectId=${projectId}&type=bug`);
  expect(take()).toBe(0);
  await u.call("DELETE", `/api/epics/${epic.id}/items`, { ids: ids.slice(0, 2) });
  expect(take()).toBeLessThanOrEqual(2 * 10 + 4 + 3);
});
it("sprints (round 21): a sprint row is 2, a task added is one tasks row, a bulk add is one batch, burndown reads write nothing", async () => {
  const { addToSprint, completeSprint, createSprint, getSprint, startSprint } = await import("@/server/services/suite/sprints");
  const { createTask, updateTask } = await import("@/server/services/suite/tasks");
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup();
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id as string, userId: me.user.id as string, email: me.user.email as string, name: "Ada", role: "owner" as const };
  const projectId = (await u.post("/api/projects", { name: "Sprints", key: "SPR" })).body.project.id as string;
  const ids: string[] = [];
  for (let i = 0; i < 50; i++) ids.push((await createTask(ctx.deps, actor, { title: `T${i}`, projectId, points: 1 })).id);
  const take = meter(ctx.db);
  const s = await createSprint(ctx.deps, actor, projectId, {});
  // Measured 2: the sprints row (WITHOUT ROWID) and its one index.
  expect(take()).toBe(2);
  // The meter bills every index on tasks (8) for an update; D1 bills only the index entries that
  // change, here the partial sprint index: 2 rows a task in production (3 moving between sprints).
  await addToSprint(ctx.deps, actor, s.id, [ids[0]]);
  const one = take();
  expect(one).toBeLessThanOrEqual(9);
  await addToSprint(ctx.deps, actor, s.id, ids.slice(1));
  // 49 tasks, no activity row while the sprint is planned.
  expect(take()).toBeLessThanOrEqual(49 * one);
  await startSprint(ctx.deps, actor, s.id);
  expect(take()).toBe(2);
  await updateTask(ctx.deps, actor, ids[0], { status: "done" });
  const doneCost = take();
  await updateTask(ctx.deps, actor, ids[1], { status: "done" });
  // Finishing a task in a sprint costs what it did before sprints: nothing extra for the chart.
  expect(take()).toBe(doneCost);
  await getSprint(ctx.deps, actor, s.id);
  await u.get(`/api/sprints?projectId=${projectId}`);
  await u.get(`/api/sprints/${s.id}`);
  expect(take()).toBe(0);
  await completeSprint(ctx.deps, actor, s.id, { carryOver: "backlog" });
  // Measured: the sprints row (2) plus the 48 carried tasks; nothing per task besides the row and index.
  expect(take()).toBeLessThanOrEqual(2 + 48 * one);
});
it("triage (round 21): accept costs the task update plus its one partial index entry; decline and merge stay small; reads write nothing", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup();
  const p = (await u.post("/api/projects", { name: "Support" })).body.project as { id: string };
  await u.patch(`/api/projects/${p.id}`, { triage: true });
  const plain = (await u.post("/api/tasks", { title: "Normal", projectId: p.id })).body.task as { id: string };
  const make = async (title: string) => (await u.post("/api/triage", { title, from: "sam@example.com" })).body.item.id as string;
  const a = await make("A"), b = await make("B"), d = await make("D");
  const take = meter(ctx.db);
  await u.post("/api/triage/nope/accept", {});
  const limiter = take();
  // A normal task update with the same change, for comparison.
  await u.patch(`/api/tasks/${plain.id}`, { priority: "high" });
  const update = take() - limiter;
  await u.post(`/api/triage/${a}/accept`, { priority: "high" });
  const accept = take() - limiter;
  // Exactly one more than the plain update: the triage_state flag leaves the partial index. No other row.
  expect(accept - update).toBe(1);
  await u.get("/api/triage"); await u.get("/api/triage/count"); await u.get("/api/tasks");
  expect(take()).toBe(0);
  await u.post(`/api/triage/${b}/decline`, { reason: "spam" });
  const decline = take() - limiter;
  // Measured 14: the task row and its indexes (8), the partial index entry leaving (1), and the activity and change rows (5).
  expect(decline).toBeLessThanOrEqual(14);
  await u.post(`/api/triage/${d}/merge`, { targetId: plain.id });
  const merge = take() - limiter;
  // Measured 30: one comment (3), the target's touch and thread (8), the item's delete (9) and two activity and change pairs (10).
  expect(merge).toBeLessThanOrEqual(30);
  const insert = take();
  await make("E");
  // Measured 17: a normal task insert (the row, its indexes, the project's next number, activity and change) plus one partial index entry.
  expect(take() - insert - limiter).toBeLessThanOrEqual(17);
});
it("bulk task changes (round 21): a 50 task update is one batch with no per task reads, about 3 to 6 D1 rows a task", async () => {
  const { bulkUpdateTasks } = await import("@/server/services/suite/bulk");
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Owner Person");
  const me = (await u.get("/api/account/me")).body;
  const web = (await u.post("/api/projects", { name: "Web" })).body.project as { id: string };
  const ops = (await u.post("/api/projects", { name: "Ops" })).body.project as { id: string };
  const ids: string[] = [];
  for (let i = 0; i < 50; i++) ids.push((await u.post("/api/tasks", { title: `Task ${i}`, projectId: web.id })).body.task.id);
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };

  // Count what the service sends: reads of tasks, batches, and writes outside a batch.
  const c = (ctx.db as unknown as { $client: { prepare: (q: string) => Record<string, (...a: unknown[]) => unknown> } }).$client;
  const prepare = c.prepare.bind(c);
  // D1 bills a written row for the table and one for each index whose columns the write touches.
  const idxCols = new Map<string, string[][]>();
  for (const t of ["tasks", "changes", "activity", "task_field_values", "projects"]) {
    idxCols.set(t, (prepare(`select name from pragma_index_list('${t}')`).all() as { name: string }[]).map((i) => (prepare(`select name from pragma_index_info('${i.name}')`).all() as { name: string }[]).map((x) => x.name)));
  }
  let reads = 0, d1Rows = 0, outside = 0, inBatch = false;
  const batches: number[] = [];
  c.prepare = (q: string) => {
    const st = prepare(q);
    if (/^\s*select/i.test(q) && /from\s+"tasks"/i.test(q)) reads++;
    const m = /^\s*(insert into|update|delete from)\s+["`]?(\w+)/i.exec(q);
    if (!m) return st;
    const table = m[2];
    const touched = /^update/i.test(m[1]) ? [...q.slice(0, q.search(/\swhere\s/i) > 0 ? q.search(/\swhere\s/i) : q.length).matchAll(/"(\w+)"\s*=/g)].map((x) => x[1]) : null;
    const perRow = 1 + (idxCols.get(table) ?? []).filter((cols) => !touched || cols.some((col) => touched.includes(col))).length;
    for (const fn of ["run", "all", "get"]) {
      const orig = st[fn].bind(st);
      st[fn] = (...a: unknown[]) => { const before = (prepare("select total_changes() n").get() as { n: number }).n; const r = orig(...a); const n = (prepare("select total_changes() n").get() as { n: number }).n - before; d1Rows += n * perRow; if (!inBatch && n) outside += n; return r; };
    }
    return st;
  };
  (ctx.db as unknown as { batch: (s: PromiseLike<unknown>[]) => Promise<void> }).batch = async (s) => { batches.push(s.length); inBatch = true; try { for (const x of s) await x; } finally { inBatch = false; } };
  const run = async (patch: Parameters<typeof bulkUpdateTasks>[3]) => {
    reads = 0; d1Rows = 0; outside = 0; batches.length = 0;
    const r = await bulkUpdateTasks(ctx.deps, actor, ids, patch);
    expect(r.updated).toBe(50);
    return { reads, d1Rows, outside, batches: [...batches] };
  };

  const assign = await run({ assignee: `member:${me.user.id}`, priority: "high", addLabels: ["launch"] });
  const status = await run({ status: "done" });
  const move = await run({ projectId: ops.id });
  console.log("bulk 50: assign", assign, "status", status, "move", move);
  for (const m of [assign, status]) {
    // One batch of writes and nothing written outside it.
    expect(m.batches).toHaveLength(1);
    expect(m.outside).toBe(0);
    // Reads do not grow with the task count: one chunked read of the 50, the statuses, one grouped bottom position, the presented answer.
    expect(m.reads).toBeLessThanOrEqual(8);
  }
  // A project move claims its numbers with one write before the batch (the projects row and its indexes).
  expect(move.batches).toHaveLength(1);
  expect(move.outside).toBe(1);
  expect(move.reads).toBeLessThanOrEqual(8);
  // Measured 154 for assign (3 a task: the tasks row, the changes row and its index, plus one summary activity row),
  // 204 for status (4 a task: the status and position index too), 255 for a move (5 a task: the project and number indexes).
  // The plain meter above counts every index on every write (10 a task here); D1 bills only the indexes a write touches.
  expect(assign.d1Rows).toBeLessThanOrEqual(50 * 3 + 10);
  expect(status.d1Rows).toBeLessThanOrEqual(50 * 4 + 10);
  expect(move.d1Rows).toBeLessThanOrEqual(50 * 6 + 10);
});

it("thread notes (round 22): a note is its row and one index entry, each mention adds one notification row (3 with its indexes); reads write nothing", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const domainId = (await u.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await u.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await u.post(`/api/domains/${domainId}/verify`);
  await u.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" });
  const inv = await u.post("/api/team/invites", { email: "admin@acme.io", role: "admin" });
  const a2 = new Client(ctx.app);
  await a2.signup("admin@acme.io", "Adam Admin");
  await a2.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
  const { deliverInbound } = await import("@/server/services/mail/delivery");
  await deliverInbound(ctx.deps, { envelopeFrom: "grace@example.com", rcptTo: "support@acme.io", sizeBytes: 300, via: "test",
    email: { messageId: "<wc1@example.com>", from: { address: "grace@example.com", name: "Grace" }, to: [{ address: "support@acme.io" }], cc: [], subject: "Hi", text: "Hello", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} } });
  const threadId = (await u.get("/api/agents/threads")).body.data[0].id as string;
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const { addComment, editComment, deleteComment, listComments } = await import("@/server/services/mail/thread-comments");
  const take = meter(ctx.db);
  const plain = await addComment(ctx.deps, actor, threadId, { body: "Just a note" });
  // The row and its one index.
  expect(take()).toBe(2);
  await addComment(ctx.deps, actor, threadId, { body: "@Adam Admin look @Olive Owner" });
  // Measured 5: the note (2) plus one notification row and its indexes (3) for Adam; the author is not notified.
  expect(take()).toBeLessThanOrEqual(5);
  await listComments(ctx.deps, actor, threadId);
  expect(take()).toBe(0);
  await editComment(ctx.deps, actor, threadId, plain.id, { body: "Edited note" });
  expect(take()).toBeLessThanOrEqual(2);
  await deleteComment(ctx.deps, actor, threadId, plain.id);
  expect(take()).toBe(2);
});

it("R22: thread assignment and status cost a row or two, and the views, My Work and reply times write nothing", async () => {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const me = (await c.get("/api/account/me")).body;
  const { messages, domains, mailboxes } = await import("@/server/db/schema");
  await ctx.db.insert(domains).values({ id: "dom_wc", orgId: me.organization.id, name: "acme.io", status: "verified", verificationToken: "x", dkimSelector: "s1", dkimPublicKey: "x", dkimPrivateKeyEnc: "x" });
  await ctx.db.insert(mailboxes).values({ id: "mbx_wc", orgId: me.organization.id, domainId: "dom_wc", localPart: "support", address: "support@acme.io", displayName: "Support", quotaMb: 100 });
  await ctx.db.insert(messages).values({ id: "msg_wc", orgId: me.organization.id, mailboxId: "mbx_wc", folder: "inbox", threadId: "thr_wc", fromAddress: "c@example.com", subject: "Help", date: new Date() });
  const { assignThread, setThreadStatus } = await import("@/server/services/mail/thread-state");
  // Services directly: a POST through the local app also bumps the rate limit counter, which production keeps in a binding.
  const actor = { orgId: me.organization.id, userId: me.user.id, email: "owner@acme.io", name: "Olive Owner", role: "owner" as const };
  const take = meter(ctx.db);
  // First assign (to myself, so no notification): the row (WITHOUT ROWID, no second index) plus its partial assignee index entry.
  await assignThread(ctx.deps, actor, "thr_wc", me.user.id);
  expect(take()).toBe(2);
  // The same assign again changes nothing and writes nothing.
  await assignThread(ctx.deps, actor, "thr_wc", me.user.id);
  expect(take()).toBe(0);
  // Unassign: the row, and the index entry goes.
  await assignThread(ctx.deps, actor, "thr_wc", null);
  expect(take()).toBe(2);
  // Status changes touch only the row: done, then reopen.
  await setThreadStatus(ctx.deps, actor, "thr_wc", "done");
  expect(take()).toBe(1);
  await setThreadStatus(ctx.deps, actor, "thr_wc", "open");
  expect(take()).toBe(1);
  // Reads: the views, the state, My Work and reply times.
  for (const v of ["open", "mine", "unassigned", "done", "all"]) await c.get(`/api/agents/threads?view=${v}`);
  await c.get("/api/threads/thr_wc/state"); await c.get("/api/my-work"); await c.get("/api/threads/stats/replies?groupBy=person");
  expect(take()).toBe(0);
  // Assigning someone else adds their notification: its row, its primary key index and its user index, 3 more than the state write.
  const { users, members } = await import("@/server/db/schema");
  await ctx.db.insert(users).values({ id: "usr_kiran", email: "kiran@acme.io", name: "Kiran" });
  await ctx.db.insert(members).values({ id: "mem_kiran", organizationId: me.organization.id, userId: "usr_kiran", role: "admin" });
  take();
  await assignThread(ctx.deps, actor, "thr_wc", "usr_kiran");
  expect(take()).toBe(2 + 3);
  // A reassign updates the row; the meter sees no change in the partial index's size, D1 may bill the moved entry, so 1 to 3.
  await assignThread(ctx.deps, actor, "thr_wc", me.user.id);
  expect(take()).toBeLessThanOrEqual(3);
});

it("thread presence and shared drafts (round 22): a heartbeat writes 0 rows; a take over is the one draft row plus one notification", async () => {
  const ctx = await makeTestApp();
  const owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  await owner.post("/api/org/plan", { plan: "pro" });
  const d = (await owner.post("/api/domains", { name: "acme.io" })).body.domain;
  for (const r of d.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await owner.post(`/api/domains/${d.id}/verify`);
  const mailboxId = (await owner.post("/api/mailboxes", { domainId: d.id, localPart: "sales", displayName: "Sales" })).body.mailbox.id as string;
  const inv = await owner.post("/api/team/invites", { email: "max@acme.io", role: "admin" });
  const max = new Client(ctx.app);
  await max.signup("max@acme.io", "Max Admin");
  await max.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
  await deliverInbound(ctx.deps, {
    envelopeFrom: "grace@example.com", rcptTo: "sales@acme.io", sizeBytes: 300, via: "test",
    email: { messageId: "<q1@example.com>", from: { address: "grace@example.com", name: "Grace" }, to: [{ address: "sales@acme.io" }], cc: [], subject: "Quote", text: "Price?", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
  const row = (await owner.get("/api/agents/threads")).body.data[0];
  const threadId = (row.threadId ?? row.id) as string;
  const msgId = (await owner.get(`/api/agents/threads/${threadId}`)).body.messages[0].id as string;
  const take = meter(ctx.db);
  // What any POST costs here (the local rate limit counter; a binding in production): a refused beat.
  expect((await max.post(`/api/threads/${threadId}/presence`, { clientId: "x", state: "viewing" })).status).toBe(422);
  const limiter = take();
  for (let i = 0; i < 4; i++) await max.post(`/api/threads/${threadId}/presence`, { clientId: "maxtab1", state: i ? "replying" : "viewing" });
  expect(take() - 4 * limiter).toBe(0);
  await max.get(`/api/threads/${threadId}/presence`); await max.get(`/api/threads/${threadId}/drafts`);
  expect(take()).toBe(0);
  await max.post("/api/mail/drafts", { mailboxId, to: ["grace@example.com"], subject: "Re: Quote", text: "A$420", inReplyToId: msgId });
  const save = take() - limiter;
  // Measured 11, the same as a draft save before round 22: the messages row with its indexes and the mailbox's usage.
  // The thread id and author ride on that same row; the ownership check before a save only reads.
  expect(save).toBeLessThanOrEqual(11);
  const draftId = (await owner.get(`/api/threads/${threadId}/drafts`)).body.drafts[0].id as string;
  take();
  await owner.post(`/api/threads/drafts/${draftId}/take-over`);
  const takeOver = take() - limiter;
  // The draft row (the meter counts every index on messages, though only sent_by_user_id changes, so D1 bills less)
  // plus one notification row and its index. No new index on messages, no migration.
  // Measured 10: the draft row as this meter counts it (7, though only sent_by_user_id changes and it has no index,
  // so D1 bills 1) plus one notification and its indexes (3).
  expect(takeOver).toBeLessThanOrEqual(10);
  await owner.post(`/api/threads/drafts/${draftId}/take-over`);
  // Taking over a draft you already own writes nothing.
  expect(take() - limiter).toBe(0);
});

it("R22.5: an assign rule costs the assignment plus its run bookkeeping (round robin pointer adds nothing); replies and reopen checks write nothing", async () => {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const me = (await c.get("/api/account/me")).body;
  const orgId = me.organization.id as string;
  const { messages, domains, mailboxes, users, members, automations } = await import("@/server/db/schema");
  await ctx.db.insert(domains).values({ id: "dom_rr", orgId, name: "acme.io", status: "verified", verificationToken: "x", dkimSelector: "s1", dkimPublicKey: "x", dkimPrivateKeyEnc: "x" });
  await ctx.db.insert(mailboxes).values({ id: "mbx_rr", orgId, domainId: "dom_rr", localPart: "support", address: "support@acme.io", displayName: "Support", quotaMb: 100 });
  await ctx.db.insert(users).values([{ id: "usr_a", email: "a@acme.io", name: "Ann" }, { id: "usr_b", email: "b@acme.io", name: "Ben" }]);
  await ctx.db.insert(members).values([{ id: "mem_a", organizationId: orgId, userId: "usr_a", role: "admin" }, { id: "mem_b", organizationId: orgId, userId: "usr_b", role: "admin" }]);
  const actor = { orgId, userId: me.user.id, email: "owner@acme.io", name: "Olive Owner", role: "owner" as const };
  const { eq } = await import("drizzle-orm");
  const { createAutomation, runEmailAutomations } = await import("@/server/services/suite/automations");
  const rule = await createAutomation(ctx.deps, actor, { name: "Rota", trigger: "email_received", conditions: { mailboxId: "mbx_rr" }, action: "assign_thread", actionConfig: { mode: "round_robin", userIds: ["usr_a", "usr_b"] } });
  const mail = async (id: string, thread: string) => {
    await ctx.db.insert(messages).values({ id, orgId, mailboxId: "mbx_rr", folder: "inbox", threadId: thread, fromAddress: "c@example.com", subject: "Help", date: new Date() });
    return { messageId: id, threadId: thread, mailboxId: "mbx_rr", from: "c@example.com", subject: "Help" };
  };
  const m1 = await mail("msg_rr1", "thr_rr1");
  const take = meter(ctx.db);
  await runEmailAutomations(ctx.deps, orgId, m1);
  // Measured 10: the run counter row (with its index), the thread state row and its partial index entry (2), Ann's
  // notification (3 with its indexes) and the rule's run update (with its index). The pointer rides on that update.
  const first = take();
  expect(first).toBeLessThanOrEqual(10);
  const m2 = await mail("msg_rr2", "thr_rr2");
  take();
  await runEmailAutomations(ctx.deps, orgId, m2);
  expect(take()).toBe(first);
  expect(JSON.parse((await ctx.db.select().from(automations).where(eq(automations.id, rule.id)).get())!.actionConfig).last).toBe("usr_b");
  // A reply on a thread the rule already handled: reads only.
  const reply = await mail("msg_rr3", "thr_rr1");
  take();
  await runEmailAutomations(ctx.deps, orgId, reply);
  expect(take()).toBe(0);
  // Reopen on inbound: nothing when open, one row when waiting goes back to open.
  const { reopenOnInbound } = await import("@/server/services/suite/thread-rules");
  const { setThreadStatus } = await import("@/server/services/mail/thread-state");
  await reopenOnInbound(ctx.deps, orgId, "thr_rr1");
  await reopenOnInbound(ctx.deps, orgId, "thr_none");
  expect(take()).toBe(0);
  await setThreadStatus(ctx.deps, actor, "thr_rr1", "waiting");
  expect(take()).toBe(1);
  await reopenOnInbound(ctx.deps, orgId, "thr_rr1");
  expect(take()).toBe(1);
  for (const v of ["waiting", "open"]) await c.get(`/api/agents/threads?view=${v}`);
  expect(take()).toBe(0);
});

it("saved replies (round 22): create, edit and delete are the row and its one index (2 each); list and render write nothing", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const { createSnippet, updateSnippet, deleteSnippet, listSnippets, renderSnippetFor } = await import("@/server/services/suite/snippets");
  const take = meter(ctx.db);
  const s = await createSnippet(ctx.deps, actor, { name: "Thanks", shortcut: "thanks", body: "Thanks {{first_name}}" });
  expect(take()).toBe(2);
  await listSnippets(ctx.deps, actor);
  await renderSnippetFor(ctx.deps, actor, s.id, { to: "Grace <grace@example.com>" });
  expect(take()).toBe(0);
  await updateSnippet(ctx.deps, actor, s.id, { name: "Thank you", body: "Many thanks" });
  expect(take()).toBeLessThanOrEqual(2);
  await deleteSnippet(ctx.deps, actor, s.id);
  expect(take()).toBe(2);
});

it("meeting notes (round 23): the notes doc is its row plus the meeting's doc_id (8 with indexes); an action item costs its task plus 4 (claim row, link back); reads and a second press write nothing", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const { ensureNotesDoc, meetingNotes, createActionItems } = await import("@/server/services/suite/meeting-notes");
  const { createTask } = await import("@/server/services/suite/tasks");
  const { appendActionItem } = await import("@/shared/action-items");
  const m = (await u.post("/api/meetings", { title: "Sync", startsAt: "2026-10-27T00:00:00Z" })).body.meeting;
  await createTask(ctx.deps, actor, { title: "warm up the default project" });
  const take = meter(ctx.db);
  await meetingNotes(ctx.deps, actor, m.id);
  expect(take()).toBe(0);
  // Measured 8: the doc row with its index (2) and the meetings row with its three indexes (4), plus 2 for the docs table's other index entries.
  const docId = await ensureNotesDoc(ctx.deps, actor, m.id);
  expect(take()).toBeLessThanOrEqual(8);
  await ensureNotesDoc(ctx.deps, actor, m.id);
  await meetingNotes(ctx.deps, actor, m.id);
  expect(take()).toBe(0);
  // The doc edits themselves are ordinary doc saves; measure from here.
  const d = (await u.get(`/api/docs/${docId}`)).body.doc;
  await u.patch(`/api/docs/${docId}`, { content: appendActionItem(appendActionItem(d.content, "One"), "Two"), version: d.version });
  take();
  await createTask(ctx.deps, actor, { title: "Baseline" });
  const taskCost = take(); // measured 16
  const r = await createActionItems(ctx.deps, actor, m.id, {});
  expect(r.created).toHaveLength(2);
  // Measured per item: the task (as createTask) + 4: the claim row (meeting_action_items, counted with its primary key entry) and the link back (entity_links row and index).
  expect(take()).toBeLessThanOrEqual(2 * (taskCost + 4));
  await createActionItems(ctx.deps, actor, m.id, {});
  await meetingNotes(ctx.deps, actor, m.id);
  expect(take()).toBe(0);
});

it("recording a call (round 23): start is 1 row, each chunk's text is 1 UPDATE, Stop is 2 rows plus the one chat message; reads write nothing", async () => {
  const ctx = await makeTestApp();
  ctx.deps.fetch = (async (u: RequestInfo | URL) => String(u).endsWith("/audio/transcriptions")
    ? Response.json({ text: "We ship on Friday." })
    : Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "Ship Friday.", decisions: [], actionItems: [] }) } }] })) as typeof fetch;
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  await u.put("/api/ai/key", { provider: "openai", apiKey: "sk-test-0123456789abcdefWXYZ" });
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const g = ((await u.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
  const mid = (await u.post(`/api/chat/channels/${g.id}/call`, {})).body.meeting.id;
  const { startRecording, appendChunk, listRecordings, stopRecording } = await import("@/server/services/suite/meeting-recordings");
  const { postMessage } = await import("@/server/services/suite/chat");
  const take = meter(ctx.db);
  const rid = (await startRecording(ctx.deps, actor, mid)).recording.id;
  expect(take()).toBe(1);
  const audio = new Uint8Array([1, 2, 3, 4]);
  await appendChunk(ctx.deps, actor, mid, rid, { seq: 0, audio, mime: "audio/webm" });
  expect(take()).toBe(1);
  await appendChunk(ctx.deps, actor, mid, rid, { seq: 1, audio, mime: "audio/webm" });
  expect(take()).toBe(1);
  // A retried chunk and every read: nothing.
  await appendChunk(ctx.deps, actor, mid, rid, { seq: 1, audio, mime: "audio/webm" });
  await listRecordings(ctx.deps, actor, mid);
  expect(take()).toBe(0);
  // Stop: the claim and the summary (2) plus the chat message, at what any post costs.
  await stopRecording(ctx.deps, actor, mid, rid, {});
  const stopCost = take();
  await postMessage(ctx.deps, actor, g.id, { body: "A plain message for comparison" });
  const plainMessage = take();
  expect(stopCost).toBe(2 + plainMessage);
  // A second Stop writes nothing.
  await stopRecording(ctx.deps, actor, mid, rid, {});
  expect(take()).toBe(0);
});

it("calls in chat (round 23): presence polls write nothing; a DM call rings each member with one notification; the end is one meeting update, once", async () => {
  const ctx = await makeTestApp();
  const { meetings } = await import("@/server/db/schema");
  const { eq } = await import("drizzle-orm");
  const { clearCallCache } = await import("@/server/services/suite/calls");
  clearCallCache();
  const rooms = new Map<string, { identity: string; name: string; joinedAt: null }[]>();
  ctx.deps.callRooms = { list: async (room) => rooms.get(room) ?? [] };
  let clock = new Date("2026-10-20T00:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 20_000));
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const invite = await u.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
  const m = new Client(ctx.app);
  await m.signup("mate@acme.io", "Sam Mate", "");
  await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`);
  const mateId = (await m.get("/api/account/me")).body.user.id;
  const dm = (await u.post("/api/chat/dms", { userIds: [mateId] })).body.channel;
  const take = meter(ctx.db);
  const plain = await u.post(`/api/chat/channels/${dm.id}/messages`, { body: "hello" });
  expect(plain.status).toBe(201);
  const messageCost = take();
  const call = (await u.post(`/api/chat/channels/${dm.id}/call`, {})).body;
  const callCost = take();
  // Measured 18 for a plain DM message (with its chat.dm notification) and 33 for a DM call: the meeting, the
  // card, the channel's call claim and one call.started notification in place of the card's chat.dm one.
  expect(messageCost).toBeLessThanOrEqual(20);
  expect(callCost).toBeLessThanOrEqual(36);
  const room = (await ctx.db.select({ room: meetings.room }).from(meetings).where(eq(meetings.id, call.meeting.id)).get())!.room;
  for (let i = 0; i < 5; i++) await m.get(`/api/chat/channels/${dm.id}/call`);
  rooms.set(room, [{ identity: "a", name: "Olive Owner", joinedAt: null }]);
  for (let i = 0; i < 5; i++) await u.get(`/api/chat/channels/${dm.id}/call`);
  expect(take()).toBe(0);
  rooms.set(room, []);
  for (let i = 0; i < 5; i++) await u.get(`/api/chat/channels/${dm.id}/call`);
  // Measured 5: the meeting row and its 4 indexes by the meter's rule (D1 skips indexes whose columns didn't change), once.
  expect(take()).toBe(5);
  // A late "left" from the last client finds the call ended and writes nothing but the local rate limit counter (a binding in production).
  await u.post(`/api/chat/calls/${call.meeting.id}/left`, {});
  expect(take()).toBeLessThanOrEqual(4);
});

it("calendar sync (round 23): feed on 2, reset at most 3, off 2; other calendars 1 each; serving the feed and viewing events write nothing", async () => {
  const ics = "BEGIN:VCALENDAR\r\nX-WR-CALNAME:Home\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261103T090000Z\r\nDTEND:20261103T100000Z\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const ctx = await makeTestApp({}, { fetch: (async () => new Response(ics)) as typeof fetch });
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const cal = await import("@/server/services/suite/calendar-sync");
  await u.post("/api/meetings", { title: "Sync", startsAt: "2026-11-03T01:00:00Z" });
  const take = meter(ctx.db);
  const on = await cal.resetFeed(ctx.deps, actor);
  expect(take()).toBe(2);
  await cal.serveFeed(ctx.deps, on.url.split("/cal/")[1].replace(".ics", ""));
  await cal.feedStatus(ctx.deps, actor);
  await cal.listCalendarEvents(ctx.deps, actor, { from: "2026-11-01", to: "2026-12-01" });
  expect(take()).toBe(0);
  const res = await ctx.app.request(new URL(on.url).pathname, { headers: { host: "localhost" } });
  expect(res.status).toBe(200);
  expect(take()).toBe(0);
  await cal.resetFeed(ctx.deps, actor);
  expect(take()).toBeLessThanOrEqual(3);
  const s = await cal.addIcsSource(ctx.deps, actor, { url: "https://calendar.example.com/secret.ics" });
  expect(take()).toBe(1);
  await cal.listCalendarEvents(ctx.deps, actor, { from: "2026-11-01", to: "2026-12-01" });
  expect(take()).toBe(0);
  await cal.updateSource(ctx.deps, actor, s.id, { enabled: false });
  expect(take()).toBe(1);
  await cal.removeSource(ctx.deps, actor, s.id);
  expect(take()).toBe(1);
  await cal.disableFeed(ctx.deps, actor);
  expect(take()).toBe(2);
});

it("workload (R24.2): reading the workload writes nothing, through the app, the API and the service; a move is one task update", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const projectId = (await u.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  const t = (await u.post("/api/tasks", { title: "Ship", projectId, points: 3, due: "2026-11-03T10:00:00Z", assignee: `member:${me.user.id}` })).body.task;
  const key = (await u.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
  const { getWorkload } = await import("@/server/services/suite/workload");
  const take = meter(ctx.db);
  await getWorkload(ctx.deps, actor, { from: "2026-11-02", weeks: 12, unit: "hours" });
  await getWorkload(ctx.deps, { ...actor, agentId: null, scope: "read" }, { projectIds: [projectId] });
  expect(take()).toBe(0);
  // Through a key: whatever any key request writes (its last used time, the rate limit counter), and nothing more.
  const headers = { host: "localhost", authorization: `Bearer ${key}` };
  expect((await ctx.app.request("/api/v1/tasks", { headers })).status).toBe(200);
  const baseline = take();
  expect((await ctx.app.request("/api/v1/workload?weeks=4", { headers })).status).toBe(200);
  expect(take()).toBeLessThanOrEqual(baseline);
  await u.get("/api/tasks");
  const sessionBaseline = take();
  await u.get("/api/workload?weeks=4");
  expect(take()).toBeLessThanOrEqual(sessionBaseline);
  // Moving a chip is the normal task update: the task row and its indexes, plus the activity row.
  await u.patch(`/api/tasks/${t.id}`, { due: "2026-11-10T10:00:00Z" });
  expect(take()).toBeLessThanOrEqual(16);
});

it("workload capacity (R24): setting a person's capacity is 1 row write, an unchanged set and the workload read write nothing", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const { setCapacity } = await import("@/server/services/suite/workload-capacity");
  const { getWorkload } = await import("@/server/services/suite/workload");
  const take = meter(ctx.db);
  await setCapacity(ctx.deps, actor, { person: `member:${me.user.id}`, points: 12 });
  expect(take()).toBe(1);
  await setCapacity(ctx.deps, actor, { person: `member:${me.user.id}`, points: 12 });
  expect(take()).toBe(0);
  await setCapacity(ctx.deps, actor, { person: `member:${me.user.id}`, hours: 30 });
  expect(take()).toBe(1);
  await getWorkload(ctx.deps, actor, { weeks: 4 });
  expect(take()).toBe(0);
  await setCapacity(ctx.deps, actor, { person: `member:${me.user.id}`, points: null, hours: null });
  expect(take()).toBe(1);
});

it("automation recipes (R24.4): listing writes nothing; turning one on is one automation row with its activity; a run is the action plus the run count; due_passed idle writes nothing", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const projectId = (await u.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  const channelId = (await u.post("/api/chat/channels", { name: "engineering" })).body.channel.id;
  const { listRecipes, enableRecipe } = await import("@/server/services/suite/automation-recipes");
  const { runDuePassed } = await import("@/server/services/suite/automations-r24");
  const { createTask, updateTask } = await import("@/server/services/suite/tasks");
  const take = meter(ctx.db);
  await listRecipes(ctx.deps, actor);
  await u.get("/api/automations/recipes");
  expect(await runDuePassed(ctx.deps)).toEqual({ fired: 0, paused: false });
  expect(take()).toBe(0);
  // A task with no rules on costs what it cost before (the rules read writes nothing).
  await createTask(ctx.deps, actor, { title: "Baseline", projectId, priority: "urgent" });
  const plainCreate = take();
  await enableRecipe(ctx.deps, actor, "urgent_post_channel", { channelId });
  const enableCost = take();
  // Measured 9: the automation row (1 index), its activity and change rows.
  expect(enableCost).toBeLessThanOrEqual(10);
  await createTask(ctx.deps, actor, { title: "Server down", projectId, priority: "urgent" });
  const runCost = take() - plainCreate;
  // Measured 14: the run count, the rule's run stamp, and the chat message with its channel stamp and activity.
  expect(runCost).toBeLessThanOrEqual(16);
  // set_priority on a created bug: the run count, the rule's row, and one task update.
  await enableRecipe(ctx.deps, actor, "customer_label_priority");
  take();
  await createTask(ctx.deps, actor, { title: "Plain", projectId });
  const plain2 = take();
  await createTask(ctx.deps, actor, { title: "Customer", projectId, labels: ["customer"] });
  const prioCost = take() - plain2;
  // Measured 18: the run count, the rule's run stamp, and one task update with its activity and change rows.
  expect(prioCost).toBeLessThanOrEqual(20);
  // due_passed: the marker on the task plus the run.
  await enableRecipe(ctx.deps, actor, "due_passed_notify");
  const late = await createTask(ctx.deps, actor, { title: "Late", projectId, due: new Date(Date.now() - 3600_000).toISOString() });
  await updateTask(ctx.deps, actor, late.id, { assignee: null });
  take();
  await runDuePassed(ctx.deps);
  const dueCost = take();
  // Measured 12: the once per due date marker on the task (its indexes), the run count and the rule's run stamp.
  expect(dueCost).toBeLessThanOrEqual(14);
  await runDuePassed(ctx.deps);
  expect(take()).toBe(0);
});

it("docs tree and backlinks (R24.5): unchanged links write 0 link rows; a link is 2 (row + target index); a move is 1 docs row; tree and backlink reads write nothing", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const docsSvc = await import("@/server/services/suite/docs");
  const tree = await import("@/server/services/suite/doc-tree");
  const a = await docsSvc.createDoc(ctx.deps, actor, { title: "A", text: "" });
  const b = await docsSvc.createDoc(ctx.deps, actor, { title: "B", text: "" });
  const c = await docsSvc.createDoc(ctx.deps, actor, { title: "C", text: "" });
  const body = (...ids: string[]) => ({ type: "doc", content: [{ type: "paragraph", content: ids.map((id) => ({ type: "text", text: id, marks: [{ type: "link", attrs: { href: `/app/docs/${id}` } }] })) }] });
  const take = meter(ctx.db);
  expect(await tree.syncDocLinks(ctx.deps, actor.orgId, a.id, body(b.id))).toEqual({ added: 1, removed: 0 });
  expect(take()).toBe(2);
  // The leader's snapshot saves again with the same links: no link rows.
  expect(await tree.syncDocLinks(ctx.deps, actor.orgId, a.id, body(b.id, b.id))).toEqual({ added: 0, removed: 0 });
  expect(take()).toBe(0);
  await tree.syncDocLinks(ctx.deps, actor.orgId, a.id, body(c.id));
  expect(take()).toBe(4); // one out, one in
  // A whole doc save with unchanged links costs the same as a save of a doc with no links at all.
  await docsSvc.updateDoc(ctx.deps, actor, b.id, { content: body() });
  const plain = take();
  await docsSvc.updateDoc(ctx.deps, actor, a.id, { content: body(c.id) });
  expect(take()).toBe(plain);
  // A move: one docs row (the meter counts it with the docs key index and docs_org_idx, as for any docs update).
  await tree.moveDoc(ctx.deps, actor, b.id, { parentId: a.id });
  expect(take()).toBe(3);
  await tree.moveDoc(ctx.deps, actor, c.id, { parentId: a.id, beforeId: b.id });
  expect(take()).toBe(3);
  await tree.getDocTree(ctx.deps, { orgId: actor.orgId });
  await tree.getBacklinks(ctx.deps, { orgId: actor.orgId }, { type: "doc", id: c.id });
  expect(take()).toBe(0);
  // Deleting A lifts its two sub pages: 2 docs rows (3 each by the meter) on top of the delete itself.
  const d = await docsSvc.createDoc(ctx.deps, actor, { title: "D", text: "" });
  take();
  await docsSvc.deleteDoc(ctx.deps, actor, d.id);
  const lone = take();
  await docsSvc.deleteDoc(ctx.deps, actor, a.id);
  expect(take()).toBe(lone + 6);
});

it("dashboards (R24.3): viewing a dashboard's data writes nothing; create, a layout save and a delete are 2 each (one row and its index)", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const projectId = (await u.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  await u.post("/api/tasks", { title: "Ship", projectId, due: "2026-11-03T10:00:00Z" });
  const key = (await u.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const svc = await import("@/server/services/suite/dashboards");
  const take = meter(ctx.db);
  const d = await svc.createDashboard(ctx.deps, actor, { starter: "team" });
  expect(take()).toBe(2); // the row and its org index; no activity rows
  const widgets = [...d.widgets.reverse(), { type: "breakdown" as const, groupBy: "label" as const }, { type: "goals" as const }, { type: "workload" as const }, { type: "mail_volume" as const }, { type: "reply_times" as const }, { type: "count" as const, source: { projectId } }];
  await svc.updateDashboard(ctx.deps, actor, d.id, { name: "Team", widgets, shared: true });
  expect(take()).toBe(2); // ten widgets, a rename and the share flag: one row and its index
  await svc.addWidget(ctx.deps, actor, d.id, { type: "due" });
  expect(take()).toBe(2);
  await svc.dashboardData(ctx.deps, actor, d.id);
  expect(take()).toBe(0);
  await u.get("/api/tasks");
  const sessionBaseline = take();
  expect((await u.get(`/api/dashboards/${d.id}/data`)).status).toBe(200);
  expect(take()).toBeLessThanOrEqual(sessionBaseline);
  const headers = { host: "localhost", authorization: `Bearer ${key}` };
  expect((await ctx.app.request("/api/v1/tasks", { headers })).status).toBe(200);
  const baseline = take();
  expect((await ctx.app.request(`/api/v1/dashboards/${d.id}/data`, { headers })).status).toBe(200);
  expect(take()).toBeLessThanOrEqual(baseline);
  await svc.deleteDashboard(ctx.deps, actor, d.id);
  expect(take()).toBe(2);
});

it("formula and rollup fields (R24.1): reading computed values writes nothing; defining a field is one row", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const projectId = (await u.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  const budget = (await u.post("/api/fields", { projectId, name: "Budget", type: "number" })).body.field;
  const parent = (await u.post("/api/tasks", { title: "Parent", projectId })).body.task;
  for (const p of [1, 2, 3]) await u.post("/api/tasks", { title: `Sub ${p}`, projectId, parentId: parent.id, points: p });
  await u.patch(`/api/tasks/${parent.id}`, { fields: { [budget.id]: 10 } });
  const key = (await u.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
  const take = meter(ctx.db);
  // Defining a field: the custom_fields row and its index, plus the activity row.
  expect((await u.post("/api/fields", { projectId, name: "Tax", type: "formula", config: { expression: "{Budget} * 1.1" } })).status).toBe(201);
  expect(take()).toBeLessThanOrEqual(12);
  await u.post("/api/fields", { projectId, name: "Sub points", type: "rollup", config: { source: "subtasks", fn: "sum", field: "points" } });
  await u.post("/api/fields", { projectId, name: "Total", type: "rollup", config: { source: "project", fn: "sum", field: "points" } });
  take();
  // Reads: the list, a task, the computed endpoints and the preview write nothing beyond a plain list read.
  await u.get(`/api/tasks?projectId=${projectId}&fields=1`);
  const sessionBaseline = take();
  const seen: number[] = [];
  await u.get(`/api/tasks?projectId=${projectId}&includeSubtasks=true`); seen.push(take());
  await u.get(`/api/tasks/${parent.id}`); seen.push(take());
  await u.get(`/api/computed/tasks/${parent.id}`); seen.push(take());
  await u.get(`/api/computed/projects/${projectId}/rollups`); seen.push(take());
  await u.get(`/api/computed/preview?projectId=${projectId}&expression=${encodeURIComponent("{Budget} * 2")}`); seen.push(take());
  expect(seen).toEqual([sessionBaseline, sessionBaseline, sessionBaseline, sessionBaseline, sessionBaseline]);
  const headers = { host: "localhost", authorization: `Bearer ${key}` };
  expect((await ctx.app.request("/api/v1/tasks", { headers })).status).toBe(200);
  const baseline = take();
  expect((await ctx.app.request(`/api/v1/projects/${projectId}/rollups`, { headers })).status).toBe(200);
  expect(take()).toBeLessThanOrEqual(baseline);
  expect((await ctx.app.request(`/api/v1/tasks/${parent.id}/computed`, { headers })).status).toBe(200);
  expect(take()).toBeLessThanOrEqual(baseline);
  // The services alone write nothing at all.
  const { projectRollups } = await import("@/server/services/suite/computed");
  const { listTasks } = await import("@/server/services/suite/tasks");
  const me = (await u.get("/api/account/me")).body;
  take();
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const rows = await listTasks(ctx.deps, actor, { projectId, includeSubtasks: true });
  expect(rows.find((r) => r.title === "Parent")!.fields).toMatchObject({ [budget.id]: 10 });
  await projectRollups(ctx.deps, actor, projectId);
  expect(take()).toBe(0);
});

it("formula rename (R24 polish): renaming a field costs one extra custom_fields write per formula that reads it, none when no formula does", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const projectId = (await u.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  const budget = (await u.post("/api/fields", { projectId, name: "Budget", type: "number" })).body.field;
  const notes = (await u.post("/api/fields", { projectId, name: "Notes", type: "text" })).body.field;
  await u.post("/api/fields", { projectId, name: "Tax", type: "formula", config: { expression: "{Budget} * 0.1" } });
  await u.post("/api/fields", { projectId, name: "Gross", type: "formula", config: { expression: "{budget} * 1.1" } });
  const c = (ctx.db as unknown as { $client: { prepare: (q: string) => { get: () => unknown } } }).$client;
  const perRow = 1 + (c.prepare("select count(*) n from sqlite_master where type='index' and tbl_name='custom_fields' and (sql is null or sql not like '% WHERE %')").get() as { n: number }).n;
  const take = meter(ctx.db);
  expect((await u.patch(`/api/fields/${notes.id}`, { name: "Remarks" })).status).toBe(200);
  const plain = take();
  expect((await u.patch(`/api/fields/${budget.id}`, { name: "Spend" })).status).toBe(200);
  expect(take()).toBe(plain + 2 * perRow);
});

it("bulk assignee recipes (R24 polish): a bulk reassign writes the same with no rules or a rule that doesn't match; a matching rule adds only its runs, capped", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const projectId = (await u.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  const otherId = (await u.post("/api/projects", { name: "Other", key: "OTH" })).body.project.id;
  const { createTask } = await import("@/server/services/suite/tasks");
  const { bulkUpdateTasks } = await import("@/server/services/suite/bulk");
  const { createAutomation } = await import("@/server/services/suite/automations");
  const batch = async () => { const ids: string[] = []; for (let i = 0; i < 5; i++) ids.push((await createTask(ctx.deps, actor, { title: `T${i}`, projectId })).id); return ids; };
  const a = await batch(); const b = await batch(); const d = await batch();
  const take = meter(ctx.db);
  await bulkUpdateTasks(ctx.deps, actor, a, { assignee: { type: "member", id: actor.userId } });
  const none = take();
  await createAutomation(ctx.deps, actor, { name: "Elsewhere", trigger: "assignee_changed", conditions: { projectId: otherId }, action: "add_label", actionConfig: { label: "x" } });
  take();
  await bulkUpdateTasks(ctx.deps, actor, b, { assignee: { type: "member", id: actor.userId } });
  expect(take()).toBe(none);
  await createAutomation(ctx.deps, actor, { name: "Here", trigger: "assignee_changed", conditions: { projectId }, action: "add_label", actionConfig: { label: "x" } });
  take();
  await bulkUpdateTasks(ctx.deps, actor, d, { assignee: { type: "member", id: actor.userId } });
  const withRule = take();
  expect(withRule).toBeGreaterThan(none);
  // Each run is the action (a task update) plus the rule's run count: bounded per task.
  expect(withRule - none).toBeLessThanOrEqual(5 * 25);
});

it("R25: a Google sign in that links to an existing account, and the next one, stay inside their write ceilings", async () => {
  const idp = await fakeIdpR25();
  const ctx = await makeTestApp({ ...R25_IDP, APP_URL: "http://localhost", AUTH_LOCAL_PASSWORD: "on", AUTH0_SOCIAL_CONNECTIONS: "google-oauth2" });
  const local = new Client(ctx.app);
  const email = await local.signup();
  await (ctx.db as unknown as { $client: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } }).$client.prepare("update users set email_verified = 1 where email = ?").run(email);
  const take = meter(ctx.db);
  // Measured 19 (25 Oct 2026): the verification row Better Auth keeps for the round trip (written, then deleted),
  // the linked account row, the session row and the user's updated_at. No new user, member or org rows.
  const first = await socialSignIn(ctx.app, idp, "google-oauth2", { sub: "google-oauth2|w1", email, email_verified: true });
  expect(first.cb.status).toBe(302);
  const linkCost = take();
  expect(linkCost).toBeLessThanOrEqual(22);
  // Measured 19: the next Google sign in refreshes the account tokens instead of adding the link.
  await socialSignIn(ctx.app, idp, "google-oauth2", { sub: "google-oauth2|w1", email, email_verified: true });
  const repeatCost = take();
  expect(repeatCost).toBeLessThanOrEqual(linkCost);
});

it("API speed (R25): 0052 swaps two indexes for composites, so a task or message row costs the same as before; the cached and 304 reads write nothing", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const projectId = (await u.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  const c = (ctx.db as unknown as { $client: { prepare: (q: string) => { all: () => unknown[] } } }).$client;
  const full = (t: string) => (c.prepare(`select name from sqlite_master where type='index' and tbl_name='${t}' and (sql is null or sql not like '% WHERE %')`).all() as { name: string }[]).map((r) => r.name).sort();
  // Same number of full indexes as before 0052 (one replaced on each table): 6 each, primary key included, as on main.
  expect(full("messages")).toContain("messages_org_folder_date_idx");
  expect(full("messages")).not.toContain("messages_org_idx");
  expect(full("messages").length).toBe(6);
  expect(full("tasks")).toContain("tasks_org_project_cover_idx");
  expect(full("tasks")).not.toContain("tasks_org_project_idx");
  expect(full("tasks").length).toBe(6);
  const { createTask } = await import("@/server/services/suite/tasks");
  await createTask(ctx.deps, actor, { title: "Warm up", projectId });
  const take = meter(ctx.db);
  await createTask(ctx.deps, actor, { title: "Ship it", projectId });
  expect(take()).toBe(16) // measured on main 93dc6c7 before 0052: also 16;
  // The read cache, the intl cache and the ETag path add no writes.
  for (const p of ["/api/config", "/api/team/people", "/api/tasks/assignees", "/api/projects", `/api/tasks?projectId=${projectId}`, "/api/my-work"]) {
    expect((await u.get(p)).status, p).toBe(200);
  }
  const tag = (await ctx.app.request("/api/projects", { headers: { host: "localhost", cookie: u.cookie } })).headers.get("etag")!;
  expect((await u.call("GET", "/api/projects", undefined, { "if-none-match": tag })).status).toBe(304);
  expect(take()).toBe(0);
});

it("R25 (MB-60): branding an auth email hook is one row; a preview and an unchanged PATCH write nothing", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("owner@haajir.test", "Olive Owner");
  const d = (await u.post("/api/domains", { name: "haajir.test" })).body.domain;
  const { body } = await u.get(`/api/domains/${d.id}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await u.post(`/api/domains/${d.id}/verify`);
  await u.post("/api/mailboxes", { domainId: d.id, localPart: "no-reply", displayName: "Haajir" });
  const key = (await u.post("/api/developer/keys", { name: "Haajir HQ" })).body.secret as string;
  const v1 = async (method: string, path: string, b?: unknown) => (await ctx.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json" }, body: b !== undefined ? JSON.stringify(b) : undefined })).json();
  const secret = `v1,whsec_${Buffer.from("supabase-hook-secret-0123456789").toString("base64")}`;
  await v1("GET", "/auth-email-hooks"); // warm the key's last used write
  const take = meter(ctx.db);
  take();
  await v1("POST", "/auth-email-hooks", { from: "no-reply@haajir.test", secret, supabaseUrl: "https://abcd1234.supabase.co", appName: "Plain" });
  const plain = take();
  const made = await v1("POST", "/auth-email-hooks", { from: "no-reply@haajir.test", secret, supabaseUrl: "https://abcd1234.supabase.co", appName: "Haajir", branding: { brandColor: "#0F7B6C" } });
  // Branding rides in the same hook row: a branded create costs what a plain one does (the row and its org index).
  expect(take()).toBe(plain);
  const id = made.hook.id as string;
  const branding = { logoUrl: "https://haajir.test/logo.png", replyTo: "support@haajir.test", footer: "Haajir", templates: { signup: { subject: "Welcome to {appName}" } }, secondaryLanguage: { lang: "ne", templates: { signup: { intro: "नमस्ते" } } } };
  // Through a key the local rate limit counter (a binding in production) adds a varying few rows per
  // request, so the PATCH and preview costs are measured on the service itself.
  expect((await v1("PATCH", `/auth-email-hooks/${id}`, { branding })).hook.branding.replyTo).toBe("support@haajir.test");
  // The service alone, without the request's limiter: exactly 1, then 0 when nothing changed.
  const { updateAuthHook, previewAuthHook } = await import("@/server/services/mail/auth-email-hooks");
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const, sessionId: "s" };
  const raw = (ctx.db as unknown as { $client: { prepare: (q: string) => { get: () => unknown } } }).$client;
  const changed = () => (raw.prepare("select total_changes() n").get() as { n: number }).n;
  take();
  let c0 = changed();
  await updateAuthHook(ctx.deps, actor, id, { branding: { footer: "Haajir, Kathmandu" } });
  // One UPDATE of one row (D1 rows written: 1; neither index's columns change). This file's rule counts
  // the row plus each full index on the table (the primary key and org_id), so 3.
  expect(changed() - c0).toBe(1);
  expect(take()).toBe(3);
  c0 = changed();
  await updateAuthHook(ctx.deps, actor, id, { appName: "Haajir HQ", branding: { templates: { recovery: { subject: "Reset {appName}" } } } });
  expect(changed() - c0).toBe(1);
  expect(take()).toBe(3);
  await updateAuthHook(ctx.deps, actor, id, { branding: { footer: "Haajir, Kathmandu" } });
  await previewAuthHook(ctx.deps, actor.orgId, id, "recovery");
  expect(take()).toBe(0);
});


it("R26 (DF-3): pausing or editing an agent member costs one members row plus one audit row, nothing when unchanged", async () => {
  const ctx = await makeTestApp();
  const take = meter(ctx.db);
  const u = new Client(ctx.app);
  await u.signup("owner@acme.io", "Olive Owner");
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const, sessionId: "s" };
  const { createAgentMember } = await import("@/server/services/people");
  const { createAgentMemberR26, updateAgentMember } = await import("@/server/services/suite/agent-members-r26");
  take();
  await createAgentMember(ctx.deps, actor, { name: "Plain" });
  const plain = take();
  const made = await createAgentMemberR26(ctx.deps, actor, { name: "Builder", avatarColor: "#30B158" });
  const colour = take();
  await updateAgentMember(ctx.deps, actor, made.member.userId, { disabled: true });
  const paused = take();
  await updateAgentMember(ctx.deps, actor, made.member.userId, { disabled: true, title: null, avatarColor: "#30b158" });
  const same = take();
  await updateAgentMember(ctx.deps, actor, made.member.userId, { bio: "Ships code." });
  const edited = take();
  // Measured 25 October 2026: plain create 15, with a colour 19, pause 8, edit 8, unchanged 0.
  // A colour or inbox at create adds one members row update to the existing create.
  expect(colour - plain).toBeLessThanOrEqual(4);
  // Pause or edit: the members row (its primary key and two indexes counted) plus one audit row (3 indexes).
  expect(paused).toBeLessThanOrEqual(8);
  expect(edited).toBeLessThanOrEqual(8);
  expect(same).toBe(0);
});


it("R26: support@ on the company domain costs what any inbound delivery costs, a closed address writes nothing, the sent event writes one row", async () => {
  const ctx = await makeTestApp({ SUPPORT_EMAIL: "support@multies.si" });
  const u = new Client(ctx.app);
  await u.signup("ops@fintex.test", "Ops", "Multies HQ");
  const orgId = (await u.get("/api/account/me")).body.organization.id as string;
  Object.assign(ctx.deps.config.operatorInbox, { orgId, domain: "multies.si", addresses: ["support@multies.si", "security@multies.si"] });
  const hq = (await u.post("/api/domains", { name: "multies.si" })).body.domain.id as string;
  await u.post("/api/mailboxes", { domainId: hq, localPart: "support", displayName: "Support" });
  const v = new Client(ctx.app);
  await v.signup("ann@acme.test", "Ann", "Acme");
  const acme = (await v.post("/api/domains", { name: "acme.test" })).body.domain.id as string;
  await v.post("/api/mailboxes", { domainId: acme, localPart: "help", displayName: "Help" });
  const mail = (to: string) => deliverInbound(ctx.deps, {
    envelopeFrom: "pat@gmail.com", rcptTo: to, sizeBytes: 300, via: "test",
    email: { messageId: `<${to}.${Math.random()}@gmail.com>`, from: { address: "pat@gmail.com" }, to: [{ address: to }], cc: [], subject: "Help", text: "Hi", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
  await mail("help@acme.test"); // warm up (first message in each workspace)
  await mail("support@multies.si");
  const take = meter(ctx.db);
  await mail("help@acme.test");
  const ordinary = take(); // measured 20
  await mail("support@multies.si");
  // The same as an ordinary mailbox: the routing decision is config only, no extra read or write.
  expect(take()).toBe(ordinary);
  // A closed company address is refused before any lookup: no delivery log row.
  expect((await mail("hello@multies.si")).accepted).toBe(false);
  expect(take()).toBe(0);
  // The sent event's provider read writes the Sent copy once (the messages row and its indexes), then nothing.
  const { messages, deliveries } = await import("@/server/db/schema");
  const { handleResendEvent } = await import("@/server/services/deliverability/resend-events");
  const { mailboxes } = await import("@/server/db/schema");
  const { eq } = await import("drizzle-orm");
  const mb = (await ctx.db.select().from(mailboxes).where(eq(mailboxes.orgId, orgId)).get())!;
  await ctx.db.insert(messages).values({ id: "msg_r26", orgId, mailboxId: mb.id, folder: "sent", threadId: "thr_r26", fromAddress: mb.address, subject: "Quote", date: new Date() });
  await ctx.db.insert(deliveries).values({ id: "dlv_r26", orgId, messageId: "msg_r26", direction: "outbound", fromAddress: mb.address, toAddress: "pat@gmail.com", status: "sent", provider: "resend", providerMessageId: "em_r26" });
  const deps = { ...ctx.deps, fetch: (async () => new Response(JSON.stringify({ message_id: "<x@email.amazonses.com>" }))) as typeof fetch, config: { ...ctx.deps.config, outbound: { driver: "resend" as const, resendApiKey: "re_test" } } };
  take();
  await handleResendEvent(deps, { type: "email.sent", data: { email_id: "em_r26" } });
  const once = take();
  // Measured 7: one UPDATE of the messages row (the meter counts the row and its 6 full indexes).
  expect(once).toBe(7);
  await handleResendEvent(deps, { type: "email.sent", data: { email_id: "em_r26" } });
  expect(take()).toBe(0);
});


it("R26 (MB-87): a share link is 2 rows (the row and its token index), a revoke 2, and opening the public page writes nothing", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup("olive@share.test", "Olive Owner");
  const docId = (await u.post("/api/docs", { title: "Brief", text: "hello" })).body.doc.id as string;
  const projectId = (await u.post("/api/projects", { name: "Site", key: "SITE" })).body.project.id as string;
  await u.post("/api/tasks", { projectId, title: "Home page" });
  const me = (await u.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
  const { createShareLink, revokeShareLink, setShareLinksAllowed } = await import("@/server/services/suite/share-links");
  const take = meter(ctx.db);
  take();
  const made = await createShareLink(ctx.deps, actor, { kind: "doc", targetId: docId });
  // share_links is WITHOUT ROWID with one index (share_links_token_uq): 1 row + 1 index.
  expect(take()).toBe(2);
  const board = await createShareLink(ctx.deps, actor, { kind: "project_board", targetId: projectId, expiresInDays: 7 });
  expect(take()).toBe(2);
  // Opening the page and listing write nothing (views are not counted; the page's rate limit is in memory).
  for (const t of [made.token, board.token, "x".repeat(43)]) await ctx.app.request(`/s/${t}`, { headers: { host: "localhost" } });
  await u.get(`/api/share-links?kind=doc&targetId=${docId}`);
  expect(take()).toBe(0);
  await revokeShareLink(ctx.deps, actor, made.link.id);
  expect(take()).toBe(2);
  await revokeShareLink(ctx.deps, actor, made.link.id);
  expect(take()).toBe(0);
  // "Allow share links" lives in the workspace's metadata: one organizations row when it changes, nothing when it doesn't.
  await setShareLinksAllowed(ctx.deps, actor, true);
  expect(take()).toBe(0);
  await setShareLinksAllowed(ctx.deps, actor, false);
  expect(take()).toBeLessThanOrEqual(3);
});

it("R26 (MB-85): a checklist item costs its row plus two index entries to add, tick or delete; an unchanged tick writes no item and task queries write nothing", async () => {
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup();
  const projectId = (await u.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  const taskId = (await u.post("/api/tasks", { title: "Ship", projectId })).body.task.id;
  const take = meter(ctx.db);
  const item = (await u.post(`/api/tasks/${taskId}/checklist`, { title: "One" })).body.items[0];
  // Measured 6: 3 for the item (the row, its primary key index and task_checklist_items_task_idx) and 3 that every
  // app write pays here (the local rate limit counter, kept in a binding in production). No activity rows.
  expect(take()).toBe(6);
  await u.post(`/api/tasks/${taskId}/checklist`, { items: [{ title: "Two" }, { title: "Three" }] });
  expect(take()).toBe(9);
  await u.patch(`/api/checklist-items/${item.id}`, { done: true });
  expect(take()).toBe(6);
  await u.patch(`/api/checklist-items/${item.id}`, { done: true });
  expect(take()).toBe(3);
  const list = (await u.get(`/api/tasks/${taskId}/checklist`)).body.items as { id: string }[];
  // Moving the last item to the top rewrites the three positions: 3 rows at 3 each, plus the 3.
  await u.post(`/api/tasks/${taskId}/checklist/reorder`, { ids: [list[2].id, list[0].id, list[1].id] });
  expect(take()).toBeLessThanOrEqual(12);
  await u.del(`/api/checklist-items/${item.id}`);
  expect(take()).toBe(6);
  await u.get(`/api/tasks?q=${encodeURIComponent("has:checklist status:todo -label:wontfix")}`);
  expect(take()).toBe(0);
});

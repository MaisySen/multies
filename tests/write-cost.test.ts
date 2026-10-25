import { it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { runMaintenance } from "@/server/services/maintenance";

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

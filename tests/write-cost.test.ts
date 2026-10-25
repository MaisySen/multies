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
  for (const r of c.prepare("select tbl_name t, count(*) n from sqlite_master where type='index' group by tbl_name").all() as { t: string; n: number }[]) idx.set(r.t, r.n);
  const prepare = c.prepare.bind(c);
  const changes = () => (prepare("select total_changes() n").get() as { n: number }).n;
  let total = 0;
  c.prepare = (q: string) => {
    const st = prepare(q);
    const table = /^\s*(?:insert(?: or \w+)? into|update|delete from)\s+["`]?(\w+)/i.exec(q)?.[1];
    if (!table) return st;
    for (const fn of ["run", "all", "get"]) {
      const orig = st[fn].bind(st);
      st[fn] = (...a: unknown[]) => { const before = changes(); const r = orig(...a); total += (changes() - before) * (1 + (idx.get(table) ?? 0)); return r; };
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
  expect(call).toBeLessThanOrEqual(24);
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
  expect(tasksRun).toBeLessThanOrEqual(100 * 8 + 30);
  const again = await u.post("/api/work-imports/run", { content, projectId: project.id });
  expect(again.body).toMatchObject({ created: 0, alreadyThere: 100 });
  expect(take()).toBeLessThanOrEqual(4);
  const trello = readFileSync(join(__dirname, "fixtures/import/trello.json"), "utf8");
  await u.post("/api/work-imports/run", { content: trello, projectId: project.id });
  // Measured 66: 5 tasks, 2 comments, 2 new statuses for the board's lists, one batch and the summary.
  const withComments = take();
  expect(withComments).toBeLessThanOrEqual(5 * 8 + 2 * 2 + 30);

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

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { searchR98 } from "@/server/services/search-r98";

/** T1F: statements, time and query plans per global search on a large seeded workspace. Run with T1F_PERF=<out file>. */
describe.skipIf(!process.env.T1F_PERF)("T1F search cost", () => {
  it("measures", async () => {
    const ctx = await makeTestApp({ SEARCH_R98: "on", CRM_TIMELINE: "on" });
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    const me = (await c.get("/api/account/me")).body;
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const { body } = await c.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await c.post(`/api/domains/${domainId}/verify`);
    await c.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Sales" });
    await deliverInbound(ctx.deps, { envelopeFrom: "g@example.com", rcptTo: "sales@acme.io", sizeBytes: 300, via: "test",
      email: { messageId: "<seed@example.com>", from: { address: "g@example.com", name: "Grace" }, to: [{ address: "sales@acme.io" }], cc: [], subject: "Seed", text: "seed", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} } } as never);
    const p = (await c.post("/api/projects", { name: "Big" })).body.project;
    const t = (await c.post("/api/tasks", { title: "Template", projectId: p.id, notes: "notes" })).body.task;
    const d = (await c.post("/api/docs", { title: "Template", text: "body" })).body.doc;
    const g = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const m = (await c.post(`/api/chat/channels/${g.id}/messages`, { body: "template" })).body.message;
    const ct = (await c.post("/api/contacts", { email: "t@x.example", name: "Template" })).body.contact;
    const raw = (ctx.deps.db as unknown as { $client: { prepare: (s: string) => Record<string, (...a: unknown[]) => unknown> } }).$client;
    const one = <T,>(s: string) => raw.prepare(s).get() as unknown as T;
    const msgId = one<{ id: string }>("select id from messages limit 1").id;
    const db = ctx.deps.db as unknown as { all: (q: unknown) => Promise<unknown[]> | unknown[]; run: (q: unknown) => unknown };
    const cols = async (table: string) => ((await db.all(sql.raw(`pragma table_info(${table})`))) as { name: string }[]).map((r) => r.name);
    const words = ["invoice", "budget", "harbour", "kestrel", "proposal", "contract", "roadmap", "hiring", "launch", "quarterly"];
    const word = (i: string) => `(case (${i}) % 10 ${words.map((w, k) => `when ${k} then '${w}'`).join(" ")} end)`;
    async function clone(table: string, id: string, n: number, over: Record<string, string>) {
      const names = await cols(table);
      const select = names.map((nm) => over[nm] ?? `"${nm}"`).join(", ");
      await db.run(sql.raw(`with recursive seq(i) as (select 1 union all select i + 1 from seq where i < ${n}) insert into ${table} (${names.map((x) => `"${x}"`).join(", ")}) select ${select} from seq, ${table} where ${table}.id = '${id}'`));
    }
    const N = Number(process.env.T1F_N ?? 1);
    await clone("tasks", t.id, 5000 * N, { id: "'tsk_p' || i", title: `'Item ' || i || ' ' || ${word("i")}`, number: "1000 + i", notes: `'notes for ' || ${word("i + 3")}`, updated_at: "updated_at - i * 1000" });
    await clone("docs", d.id, 2000 * N, { id: "'doc_p' || i", title: `'Doc ' || i || ' ' || ${word("i")}`, plain_text: `'text about ' || ${word("i + 1")} || ' and more words here'`, updated_at: "updated_at - i * 1000" });
    await clone("chat_messages", m.id, 5000 * N, { id: "'msg_p' || i", body: `'chat ' || i || ' about ' || ${word("i")}`, created_at: "created_at - i * 1000" });
    await clone("contacts", ct.id, 2000 * N, { id: "'ct_p' || i", email: "'p' || i || '@x.example'", name: `'Person ' || i || ' ' || ${word("i")}` });
    await clone("messages", msgId, 5000 * N, { id: "'m_p' || i", thread_id: "'th_p' || i", subject: `'Mail ' || i || ' ' || ${word("i")}`, snippet: `'about ' || ${word("i + 2")}`, date: "date - i * 1000" });
    const v = { kind: "actor" as const, actor: { orgId: me.organization.id, userId: me.user.id, email: "owner@acme.io", name: "Olive", role: "owner" as const } };
    // count and time every statement during one search
    const log: { sql: string; params: unknown[]; ms: number; rows: number }[] = [];
    const orig = raw.prepare.bind(raw);
    let on = false;
    raw.prepare = (s: string) => {
      const st = orig(s);
      if (!on) return st;
      const wrap = (fn: string) => { const f = st[fn].bind(st); st[fn] = (...a: unknown[]) => { const t0 = performance.now(); const out = f(...a); log.push({ sql: s, params: a.flat(), ms: performance.now() - t0, rows: Array.isArray(out) ? out.length : out ? 1 : 0 }); return out; }; };
      for (const fn of ["all", "get", "run", "values"]) if (typeof st[fn] === "function") wrap(fn);
      return st;
    };
    const out: string[] = [];
    for (const q of ["kestrel", "kestrel budget", "invoise", "zqxwvk"]) {
      const runs: number[] = [];
      let stmts = 0, dbMs = 0, results = 0;
      for (let k = 0; k < 5; k++) {
        log.length = 0; on = true;
        const s = performance.now(); const r = await searchR98(ctx.deps, v, q, { budgetMs: 30_000 }); runs.push(performance.now() - s);
        on = false; stmts = log.length; dbMs = log.reduce((a, x) => a + x.ms, 0); results = r.groups.reduce((n, x) => n + x.items.length, 0);
      }
      runs.sort((a, b) => a - b);
      out.push(`Q "${q}": median ${runs[2].toFixed(1)} ms, ${stmts} statements, db ${dbMs.toFixed(1)} ms, ${results} results`);
      for (const x of [...log].sort((a, b) => b.ms - a.ms)) {
        let plan: string;
        try { plan = (raw.prepare("explain query plan " + x.sql).all(...x.params) as { detail: string }[]).map((p) => p.detail).join(" | "); } catch (e) { plan = String(e).slice(0, 80); }
        out.push(`  ${x.ms.toFixed(2)}ms rows=${x.rows} ${x.sql.replace(/\s+/g, " ").slice(0, 110)} PLAN ${plan.slice(0, 220)}`);
      }
    }
    writeFileSync(process.env.T1F_PERF!, out.join("\n") + "\n");
    expect(out.length).toBeGreaterThan(0);
  }, 600_000);
});

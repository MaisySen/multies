import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { searchR98, searchIndex } from "@/server/services/search-r98";
import { applyIndex, instantHits, NO_FILTERS, __test } from "@/web/lib/search-r98";

/** R98: index build and query time on a large seeded workspace. Run with R98_PERF=1 (numbers go to the console). */
describe.skipIf(!process.env.R98_PERF)("R98 search on a large workspace", () => {
  it("measures", async () => {
    const ctx = await makeTestApp({ SEARCH_R98: "on", CRM_TIMELINE: "on" });
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    const me = (await c.get("/api/account/me")).body;
    const p = (await c.post("/api/projects", { name: "Big" })).body.project;
    const t = (await c.post("/api/tasks", { title: "Template", projectId: p.id, notes: "notes" })).body.task;
    const d = (await c.post("/api/docs", { title: "Template", text: "body" })).body.doc;
    const g = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const m = (await c.post(`/api/chat/channels/${g.id}/messages`, { body: "template" })).body.message;
    const ct = (await c.post("/api/contacts", { email: "t@x.example", name: "Template" })).body.contact;
    const db = ctx.deps.db as unknown as { all: (q: unknown) => Promise<unknown[]> | unknown[]; run: (q: unknown) => unknown };
    const cols = async (table: string) => ((await db.all(sql.raw(`pragma table_info(${table})`))) as { name: string }[]).map((r) => r.name);
    const words = ["invoice", "budget", "harbour", "kestrel", "proposal", "contract", "roadmap", "hiring", "launch", "quarterly"];
    const word = (i: string) => `(case (${i}) % 10 ${words.map((w, k) => `when ${k} then '${w}'`).join(" ")} end)`;
    async function clone(table: string, id: string, n: number, over: Record<string, string>) {
      const names = await cols(table);
      const select = names.map((nm) => over[nm] ?? `"${nm}"`).join(", ");
      await db.run(sql.raw(`with recursive seq(i) as (select 1 union all select i + 1 from seq where i < ${n}) insert into ${table} (${names.map((x) => `"${x}"`).join(", ")}) select ${select} from seq, ${table} where ${table}.id = '${id}'`));
    }
    const t0 = Date.now();
    await clone("tasks", t.id, 20000, { id: "'tsk_p' || i", title: `'Item ' || i || ' ' || ${word("i")} || ' w' || (i % 997)`, number: "1000 + i", notes: `'notes for ' || ${word("i + 3")}` });
    await clone("docs", d.id, 5000, { id: "'doc_p' || i", title: `'Doc ' || i || ' ' || ${word("i")}`, plain_text: `'text about ' || ${word("i + 1")} || ' and more words here'` });
    await clone("chat_messages", m.id, 20000, { id: "'msg_p' || i", body: `'chat ' || i || ' about ' || ${word("i")}` });
    await clone("contacts", ct.id, 5000, { id: "'ct_p' || i", email: "'p' || i || '@x.example'", name: `'Person ' || i || ' ' || ${word("i")}` });
    const seedMs = Date.now() - t0;
    const v = { kind: "actor" as const, actor: { orgId: me.organization.id, userId: me.user.id, email: "owner@acme.io", name: "Olive", role: "owner" as const } };
    const time = async (label: string, q: string, opts = {}) => {
      const runs: number[] = [];
      let groups = 0;
      for (let k = 0; k < 5; k++) { const s = Date.now(); const r = await searchR98(ctx.deps, v, q, { budgetMs: 10_000, ...opts }); runs.push(Date.now() - s); groups = r.groups.reduce((n, x) => n + x.items.length, 0); }
      runs.sort((a, b) => a - b);
      return `${label}: median ${runs[2]} ms, max ${runs[4]} ms, ${groups} results`;
    };
    const lines = [
      `seeded 20000 tasks, 5000 docs, 20000 chat messages, 5000 contacts in ${seedMs} ms`,
      await time("exact one word", "kestrel"),
      await time("exact two words, any order", "w996 kestrel"),
      await time("typo (invoise)", "invoise"),
      await time("typo, no match anywhere", "zqxwvk"),
      await time("filtered by project and date", "budget", { filters: { project: p.id, from: "2026-01-01" } }),
    ];
    const s1 = Date.now();
    const idx = await searchIndex(ctx.deps, v.actor);
    lines.push(`index feed: ${idx.items.length} items in ${Date.now() - s1} ms (server)`);
    const store = { owner: "x", mini: __test.newMini(), byKey: new Map(), loadedAt: Date.now(), buildMs: 0, loading: null };
    __test.setStore(store);
    const s2 = performance.now();
    applyIndex(store, idx.items);
    lines.push(`browser index build: ${(performance.now() - s2).toFixed(1)} ms for ${idx.items.length} items`);
    const s3 = performance.now();
    for (let k = 0; k < 200; k++) instantHits(["kestrel", "invoise", "harbr", "item 19", "budg"][k % 5], NO_FILTERS);
    lines.push(`instant query: ${((performance.now() - s3) / 200).toFixed(2)} ms average over 200`);
    console.log(`R98PERF\n${lines.join("\n")}`);
    expect(idx.items.length).toBeLessThanOrEqual(1700);
  }, 300_000);
});

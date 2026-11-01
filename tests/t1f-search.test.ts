import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { searchR98, isOverload, overloadReportDue } from "@/server/services/search-r98";

/** T1F: global search under load. One search reads each shared lookup once, and the big groups read newest first by index. */
describe("T1F search cost", () => {
  async function setup() {
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
      email: { messageId: "<pelican@example.com>", from: { address: "g@example.com", name: "Grace" }, to: [{ address: "sales@acme.io" }], cc: [], subject: "Pelican order", text: "pelican", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} } } as never);
    const p = (await c.post("/api/projects", { name: "Birds" })).body.project;
    await c.post("/api/tasks", { title: "Pelican plan", projectId: p.id, notes: "notes" });
    await c.post("/api/docs", { title: "Pelican doc", text: "body" });
    await c.post("/api/contacts", { email: "pel@x.example", name: "Pelican Person" });
    const g = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    await c.post(`/api/chat/channels/${g.id}/messages`, { body: "the pelican landed" });
    const raw = (ctx.deps.db as unknown as { $client: { prepare: (s: string) => Record<string, (...a: unknown[]) => unknown> } }).$client;
    const log: { sql: string; params: unknown[] }[] = [];
    const orig = raw.prepare.bind(raw);
    let on = false;
    raw.prepare = (s: string) => {
      const st = orig(s);
      if (!on) return st;
      for (const fn of ["all", "get", "run", "values"]) {
        if (typeof st[fn] !== "function") continue;
        const f = st[fn].bind(st);
        st[fn] = (...a: unknown[]) => { log.push({ sql: s, params: a.flat() }); return f(...a); };
      }
      return st;
    };
    const v = { kind: "actor" as const, actor: { orgId: me.organization.id, userId: me.user.id, email: "owner@acme.io", name: "Olive", role: "owner" as const } };
    const run = async (q: string) => { log.length = 0; on = true; try { return await searchR98(ctx.deps, v, q, { budgetMs: 30_000 }); } finally { on = false; } };
    return { run, log, raw };
  }

  it("never runs the same statement twice in one search, typo pass included", async () => {
    const { run, log } = await setup();
    for (const q of ["pelican", "pelicna", "zqxwvk"]) {
      await run(q);
      const keys = log.map((x) => `${x.sql}|${JSON.stringify(x.params)}`);
      expect(new Set(keys).size, q).toBe(keys.length);
    }
  });

  it("finds the same items as before in every group", async () => {
    const { run } = await setup();
    const r = await run("pelican");
    expect(r.groups.map((g) => g.type).sort()).toEqual(["chat", "contacts", "docs", "mail", "tasks"]);
    const typo = await run("pelicna");
    expect(typo.groups.map((g) => g.type).sort()).toEqual(["chat", "contacts", "docs", "mail", "tasks"]);
    expect(typo.corrected).toBe("pelican");
  });

  it("reads mail, tasks and contacts newest first by index, with no sort of the whole workspace", async () => {
    const { run, log, raw } = await setup();
    await run("pelican");
    const plans = log.filter((x) => /order by/i.test(x.sql)).map((x) => (raw.prepare(`explain query plan ${x.sql}`).all(...x.params) as { detail: string }[]).map((p) => p.detail).join(" | "));
    const big = plans.filter((p) => /^SEARCH (messages|tasks|contacts) /.test(p) && !/task_files/.test(p)); // files on tasks sort their own few rows
    expect(big.length).toBeGreaterThanOrEqual(3);
    for (const p of big) expect(p).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    expect(big.join(" ")).toMatch(/messages_org_date_idx/);
    expect(big.join(" ")).toMatch(/tasks_org_updated_live_idx/);
    expect(big.join(" ")).toMatch(/contacts_org_recent_live_idx/);
  });

  it("tells the database's busy answers apart from real errors and reports them at most once a minute", () => {
    const busy = new Error("Failed query: select 1", { cause: new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.") });
    expect(isOverload(busy)).toBe(true);
    expect(isOverload(new Error("no such column: x"))).toBe(false);
    expect(isOverload(null)).toBe(false);
    const t0 = 10_000_000_000;
    expect(overloadReportDue(t0)).toBe(true);
    expect(overloadReportDue(t0 + 30_000)).toBe(false);
    expect(overloadReportDue(t0 + 61_000)).toBe(true);
  });

  it("answers a partial result, not an error, when the database is too busy for one group", async () => {
    const { run, raw } = await setup();
    const orig = raw.prepare.bind(raw);
    raw.prepare = (s: string) => { if (/from "deals"/.test(s)) throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."); return orig(s); };
    const r = await run("pelican");
    expect(r.partial).toBe(true);
    expect(r.groups.map((g) => g.type)).toContain("tasks");
  });
});

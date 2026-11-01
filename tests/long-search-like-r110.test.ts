import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";

/**
 * R110 (lead steer, prod 500): Contacts search built `%q%` LIKE patterns and D1 refuses a LIKE pattern over 50 bytes,
 * so a contacts search of about 48 characters or more answered 500 on multies.si. The same shape sat in Companies,
 * Docs and Tasks lists, global search, R98 search and Ask history. They now match with instr (no length limit).
 * The test database is SQLite without that limit, so this file installs D1's rule on LIKE (as contacts-long-address-r99).
 */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
const LONG = "Harbourside logistics and warehousing partners of the southern coast"; // 69 characters
const WORD = "supercalifragilisticexpialidociouslyhyperextraordinarywords"; // one word over 50 bytes

function d1Like(db: { function: (name: string, opts: object, fn: (...a: unknown[]) => unknown) => void }) {
  db.function("like", { varargs: true, deterministic: true }, (...a: unknown[]) => {
    const [pattern, value] = a as [string | null, string | null];
    if (pattern == null || value == null) return null;
    if (Buffer.byteLength(pattern) > 50) throw new Error("LIKE or GLOB pattern too complex");
    const re = new RegExp("^" + pattern.split("").map((ch) => (ch === "%" ? "[\\s\\S]*" : ch === "_" ? "[\\s\\S]" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("") + "$", "is");
    return re.test(value) ? 1 : 0;
  });
}

describe("R110 long searches do not hit the D1 LIKE limit", () => {
  beforeAll(async () => {
    ctx = await makeTestApp({ SEARCH_R98: "on", CRM_TIMELINE: "on", ASK_R110: "on" });
    d1Like((ctx.db as unknown as { $client: Parameters<typeof d1Like>[0] }).$client);
    owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    expect((await owner.post("/api/contacts", { name: LONG, email: "h@harbour.example" })).status).toBe(201);
    expect((await owner.post("/api/contacts", { name: "Ann Short", email: "ann@ex.com" })).status).toBe(201);
    expect((await owner.post("/api/crm/companies", { name: LONG })).status).toBeLessThan(300);
    const projectId = (await owner.post("/api/projects", { name: "Ops" })).body.project.id;
    expect((await owner.post("/api/tasks", { projectId, title: LONG })).status).toBeLessThan(300);
    expect((await owner.post("/api/docs", { title: LONG })).status).toBeLessThan(300);
  });

  it("the test database refuses long LIKE patterns, as D1 does", () => {
    expect(() => ctx.db.all(sql`select 1 where 'x' like ${"%" + "a".repeat(60) + "%"}`)).toThrow(/too complex/);
  });

  it("a 69 character Contacts search answers 200 and finds the contact", async () => {
    const r = await owner.get(`/api/contacts?q=${encodeURIComponent(LONG)}`);
    expect(r.status).toBe(200);
    expect(r.body.contacts.map((c: { name: string }) => c.name)).toEqual([LONG]);
    const lower = await owner.get(`/api/contacts?q=${encodeURIComponent(LONG.toLowerCase())}`);
    expect(lower.body.contacts.length).toBe(1);
    const none = await owner.get(`/api/contacts?q=${encodeURIComponent(LONG + " and more words")}`);
    expect(none.status).toBe(200);
    expect(none.body.contacts).toEqual([]);
  });

  it("percent and underscore are plain characters, not wildcards", async () => {
    const r = await owner.get(`/api/contacts?q=${encodeURIComponent("%_%")}`);
    expect(r.status).toBe(200);
    expect(r.body.contacts).toEqual([]);
  });

  it("Companies, Docs and Tasks lists answer a long search", async () => {
    for (const path of ["/api/companies", "/api/docs", "/api/tasks"]) {
      const r = await owner.get(`${path}?q=${encodeURIComponent(LONG)}`);
      expect(r.status, path).toBe(200);
      expect(JSON.stringify(r.body), path).toContain(LONG);
    }
  });

  it("global search answers a long query and one long word", async () => {
    for (const q of [LONG, WORD]) {
      const r = await owner.get(`/api/search?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
    }
    expect(JSON.stringify((await owner.get(`/api/search?q=${encodeURIComponent("harbourside")}`)).body)).toContain(LONG);
  });

  it("Ask history search answers a long query", async () => {
    const r = await owner.get(`/api/ask/threads?q=${encodeURIComponent(LONG + LONG)}`);
    expect(r.status).toBe(200);
    expect(r.body.threads).toEqual([]);
  });

  it("no search code builds a %term% LIKE pattern from what a person typed", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/server/services/suite/contacts.ts", "src/server/services/suite/docs.ts", "src/server/services/suite/tasks.ts", "src/server/services/search.ts", "src/server/services/search-r98.ts", "src/server/services/ask-r110.ts"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/`%\$\{(q\.q|f\.q|term|piece|escapeLike)/);
    }
  });
});

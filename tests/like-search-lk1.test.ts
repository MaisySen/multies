import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeTestApp, Client } from "./helpers";
import {
  D1_LIKE_MAX_BYTES, clipUtf8, containsAny, containsText, escapeLikeText, likePattern, startsWithText, textMatches, utf8Bytes,
} from "@/server/lib/like-search";

/**
 * LK1: D1 refuses a LIKE or GLOB pattern over 50 bytes ("LIKE or GLOB pattern too complex"), so long searches answered
 * 500 (Contacts on prod, Files on staging). The test database is SQLite without that limit, so this file installs D1's
 * rule on LIKE (2 and 3 argument forms) and checks every search area with 70+ character queries.
 */
type SqliteLike = { function: (name: string, opts: object, fn: (...a: unknown[]) => unknown) => void };
function d1Like(db: SqliteLike) {
  db.function("like", { varargs: true, deterministic: true }, (...a: unknown[]) => {
    const [pattern, value, esc] = a as [string | null, string | null, string | undefined];
    if (pattern == null || value == null) return null;
    if (Buffer.byteLength(pattern) > D1_LIKE_MAX_BYTES) throw new Error("LIKE or GLOB pattern too complex");
    let re = "";
    const chars = [...pattern];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      if (esc && ch === esc && i + 1 < chars.length) { re += chars[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
      re += ch === "%" ? "[\\s\\S]*" : ch === "_" ? "[\\s\\S]" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`, "iu").test(value) ? 1 : 0;
  });
}
const install = (x: unknown) => {
  const c = (x as { $client?: SqliteLike } | undefined)?.$client ?? (x as SqliteLike | undefined);
  if (c && typeof c.function === "function") d1Like(c);
};

const ascii = (n: number) => "a".repeat(n);
const NEPALI = "राम बहादुर श्रेष्ठ काठमाडौं उपत्यका कार्यालय"; // 3 bytes a letter
const EMOJI = "🏔️🎉🚀";

describe("like-search helper", () => {
  it("counts UTF 8 bytes and clips on character boundaries", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("र")).toBe(3);
    expect(utf8Bytes("🚀")).toBe(4);
    expect(clipUtf8("ab🚀", 5)).toBe("ab"); // never half an emoji
    expect(clipUtf8("ab🚀", 6)).toBe("ab🚀");
    expect(clipUtf8("रामर", 7)).toBe("रा"); // 6 of 7 bytes, the third letter would cut
    expect(clipUtf8("abc", 0)).toBe("");
    for (let n = 0; n <= 60; n++) expect(utf8Bytes(clipUtf8(NEPALI + EMOJI, n))).toBeLessThanOrEqual(n);
  });

  it("escapes % _ and the escape character", () => {
    expect(escapeLikeText("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });

  it.each([49, 50, 51, 200])("keeps a %i byte query within D1's limit", (n) => {
    for (const q of [ascii(n), clipUtf8(NEPALI.repeat(10), n), clipUtf8(EMOJI.repeat(30), n)]) {
      for (const mode of ["contains", "prefix"] as const) {
        const { pattern, complete } = likePattern(q, mode);
        expect(utf8Bytes(pattern)).toBeLessThanOrEqual(D1_LIKE_MAX_BYTES);
        expect(complete).toBe(utf8Bytes(escapeLikeText(q.trim())) + (mode === "contains" ? 2 : 1) <= D1_LIKE_MAX_BYTES);
      }
    }
  });

  it("searches a long query on its longest word and says it is not complete", () => {
    const { pattern, complete } = likePattern("the quarterly reconciliation for harbour holdings limited and partners");
    expect(complete).toBe(false);
    expect(pattern).toBe("%reconciliation%");
    expect(likePattern("50% off").pattern).toBe("%50\\% off%");
    expect(likePattern("Ann", "prefix")).toEqual({ pattern: "Ann%", complete: true });
  });

  it("matches in code the way SQLite folds case (ASCII only)", () => {
    expect(textMatches("Quarterly Board PACK", "board pack")).toBe(true);
    expect(textMatches("50% off_now", "0% off_n")).toBe(true);
    expect(textMatches("500 offxnow", "0% off_n")).toBe(false);
    expect(textMatches(null, "x")).toBe(false);
  });
});

describe("LK1 long searches on D1's LIKE rule", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let c: Client;
  beforeAll(async () => {
    ctx = await makeTestApp({ FILES_PLUS_R101: "on" });
    install(ctx.db);
    install(ctx.indexDb);
    c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
  });
  const has = (body: unknown, needle: string) => JSON.stringify(body).includes(JSON.stringify(needle).slice(1, -1));

  it("the test database refuses a long LIKE pattern, as D1 does", () => {
    expect(() => ctx.db.all(sql`select 1 where 'x' like ${`%${ascii(60)}%`}`)).toThrow(/too complex/);
  });

  it("helper conditions run with any query length, % and _ literal", () => {
    const run = (cond: ReturnType<typeof sql>) => (ctx.db.all(sql`select v from (select ${`Discount 50% off_now ${ascii(80)} ${NEPALI} ${EMOJI}`} as v) where ${cond}`) as unknown[]).length;
    const col = sql`v`;
    expect(run(containsText(col, `50% off_now ${ascii(80)} ${NEPALI}`))).toBe(1);
    expect(run(containsText(col, "DISCOUNT 50%"))).toBe(1);
    expect(run(containsText(col, "0_ off"))).toBe(0);
    expect(run(containsAny([col, sql`'zzz'`], `${NEPALI} ${EMOJI}`))).toBe(1);
    expect(run(startsWithText(col, `discount 50% off_now ${ascii(60)}`))).toBe(1);
    expect(run(startsWithText(col, "50%"))).toBe(0);
  });

  it("Files: a 70+ character search finds the file", async () => {
    const name = "Quarterly board pack for the harbour expansion project final signed copy v3.txt";
    const qs = new URLSearchParams({ space: "team", name });
    const up = await ctx.app.request(`/api/drive/upload?${qs}`, { method: "PUT", headers: { cookie: c.cookie, host: "localhost", "content-type": "text/plain", "x-multies-upload": "1" }, body: new TextEncoder().encode("hello") });
    expect(up.status).toBeLessThan(300);
    const q = name.slice(0, -4);
    expect(q.length).toBeGreaterThanOrEqual(70);
    const r = await c.get(`/api/drive/list?view=team&q=${encodeURIComponent(q)}`);
    expect(r.status).toBe(200);
    expect(has(r.body, name)).toBe(true);
    const none = await c.get(`/api/drive/list?view=team&q=${encodeURIComponent(q + " not there")}`);
    expect(none.status).toBe(200);
    expect(has(none.body, name)).toBe(false);
  });

  it("Contacts and Companies: long, Nepali and emoji searches answer 200 and find the person", async () => {
    const long = "Ravindra Bahadur Shrestha Thapa Magar of the Kathmandu Valley Office";
    for (const [name, email] of [[long, "ravindra@valley-office.com.np"], [`${NEPALI} ${EMOJI}`, "ram@valley-office.com.np"]] as const) {
      expect((await c.post("/api/contacts", { email, name })).status).toBeLessThan(300);
    }
    for (const q of [long, `${NEPALI} ${EMOJI}`]) {
      const r = await c.get(`/api/contacts?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      expect(r.body.contacts.map((x: { name: string }) => x.name)).toEqual([q]);
    }
    const co = await c.get(`/api/companies?q=${encodeURIComponent("valley-office.com.np".repeat(4))}`);
    expect(co.status).toBe(200);
  });

  it("Docs: a 70+ character search finds the doc", async () => {
    const title = "Harbour expansion launch brief with the board approved budget and timeline";
    expect((await c.post("/api/docs", { title, text: "Ship it" })).status).toBeLessThan(300);
    const r = await c.get(`/api/docs?q=${encodeURIComponent(title)}`);
    expect(r.status).toBe(200);
    expect(r.body.docs.map((d: { title: string }) => d.title)).toContain(title);
  });

  it("Tasks and global Search: a 70+ character search finds the task", async () => {
    const title = "Book the refrigerated van for the harbour market stall on Saturday morning 50% off_now";
    expect((await c.post("/api/tasks", { title })).status).toBeLessThan(300);
    const r = await c.get(`/api/tasks?q=${encodeURIComponent(title)}`);
    expect(r.status).toBe(200);
    expect(has(r.body, title)).toBe(true);
    const lit = await c.get(`/api/tasks?q=${encodeURIComponent("0_ off")}`);
    expect(lit.status).toBe(200);
    expect(has(lit.body, title)).toBe(false);
    const s = await c.get(`/api/search?q=${encodeURIComponent(title.slice(0, 74))}`);
    expect(s.status).toBe(200);
    expect(has(s.body, title)).toBe(true);
    const s2 = await c.get(`/api/search?q=${encodeURIComponent("refrigeratedvanforthehardourmarketstallonsaturdaymorning")}`);
    expect(s2.status).toBe(200);
  });

  it("Chat: a 70+ character search finds the message", async () => {
    const ch = (await c.post("/api/chat/channels", { name: "lk1-long" })).body.channel;
    const body = "Please send the signed harbour expansion contract to the board before Friday ✅";
    expect((await c.post(`/api/chat/channels/${ch.id}/messages`, { body })).status).toBeLessThan(300);
    const r = await c.get(`/api/chat/search?q=${encodeURIComponent(body)}`);
    expect(r.status).toBe(200);
    expect(r.body.results.length).toBe(1);
  });
});

describe("LK1 guard: no user text becomes a LIKE pattern", () => {
  it("src/server builds no `%${...}` LIKE pattern from a variable", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts") && !p.includes("migrations.generated")) files.push(p); } };
    walk(join(__dirname, "..", "src", "server"));
    const bad: string[] = [];
    for (const p of files) {
      if (p.endsWith("like-search.ts")) continue;
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (/\blike\b/i.test(line) && /%\$\{|"%" \+|[a-z]\w* \+ "%"/.test(line)) bad.push(`${p.split("src/server/")[1]}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

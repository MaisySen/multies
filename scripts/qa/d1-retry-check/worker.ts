/**
 * R29: the R28 read retry against the real D1 binding (workerd's D1Database and D1PreparedStatement), through
 * Drizzle the way the app uses it. A failure is injected by patching the real statement prototype for the next
 * N calls with Cloudflare's own error words; everything else is real D1 (local SQLite under workerd).
 */
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { d1BusyKind, withReadRetry } from "../../../src/server/lib/d1-busy";

type Stmt = { bind: (...a: unknown[]) => Stmt; first: <T>() => Promise<T | null> };
type D1 = { prepare: (sql: string) => Stmt; exec: (sql: string) => Promise<unknown> };
type Env = { DB: D1 };
type Check = { name: string; ok: boolean; detail?: unknown };

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const checks: Check[] = [];
    const ok = (name: string, cond: boolean, detail?: unknown) => checks.push({ name, ok: !!cond, detail });
    const raw = env.DB;
    await raw.exec("DROP TABLE IF EXISTS t; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const retries: string[] = [];
    const db = withReadRetry(raw, { delayMs: 20, onRetry: (k) => retries.push(k) });
    ok("wrapper installed on the real binding", (db as unknown as { __readRetry?: boolean }).__readRetry === true);
    const d = drizzle(db as unknown as Parameters<typeof drizzle>[0]);

    // Real batch with wrapped statements (D1 batch must still accept them).
    await d.batch([d.run(sql`insert into t (v) values ('a')`), d.run(sql`insert into t (v) values ('b')`)]);
    const rows = await d.all<{ v: string }>(sql`select v from t order by id`);
    ok("batch of wrapped statements writes, select reads back", rows.length === 2 && rows[0].v === "a", rows);

    // Inject: the next `n` calls of `method` on real D1PreparedStatement objects throw `msg`.
    const proto = Object.getPrototypeOf(raw.prepare("select 1")) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    let calls = 0;
    const inject = (msg: string, n: number) => {
      const saved: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
      let left = n;
      for (const m of ["all", "raw", "first", "run"]) {
        saved[m] = proto[m];
        proto[m] = async function (this: unknown, ...a: unknown[]) { calls++; if (left > 0) { left--; throw new Error(msg); } return saved[m].apply(this, a); };
      }
      return () => { for (const m of Object.keys(saved)) proto[m] = saved[m]; };
    };
    const attempt = async <T>(fn: () => Promise<T>) => { try { return { value: await fn() }; } catch (e) { return { error: e as Error }; } };

    // 1. A read that fails once with "Network connection lost" retries and succeeds (Drizzle path).
    calls = 0; retries.length = 0;
    let restore = inject("D1_ERROR: Network connection lost.", 1);
    let r = await attempt(() => d.all(sql`select v from t`));
    restore();
    ok("read: one network loss is retried once and succeeds", !r.error && calls === 2 && retries.join() === "network", { calls, retries: [...retries], err: r.error?.message });

    // 2. Overloaded and reset also retry; .first() via raw binding too.
    calls = 0; retries.length = 0;
    restore = inject("D1 DB is overloaded. Too many requests queued.", 1);
    const f = await attempt(() => db.prepare("select count(*) as n from t").first<{ n: number }>());
    restore();
    ok("read: overloaded on .first() is retried", !f.error && (f.value as { n: number } | null)?.n === 2 && retries.join() === "overloaded", { calls, retries: [...retries] });

    // 3. Two failures in a row: the second error reaches the caller (one retry only), and it classifies as busy (503).
    calls = 0; retries.length = 0;
    restore = inject("D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.", 2);
    r = await attempt(() => d.all(sql`select v from t`));
    restore();
    ok("read: a second failure is not retried again and maps to busy", !!r.error && calls === 2 && d1BusyKind(r.error)?.kind === "reset", { calls, kind: d1BusyKind(r.error)?.kind, msg: r.error?.message?.slice(0, 120) });

    // 4. An export is not retried (it lasts far longer than the pause) but is busy (503).
    calls = 0; retries.length = 0;
    restore = inject("D1_ERROR: Currently processing a long-running export.", 1);
    r = await attempt(() => d.all(sql`select v from t`));
    restore();
    ok("read: export is not retried, classifies as export", !!r.error && calls === 1 && d1BusyKind(r.error)?.kind === "export", { calls });

    // 5. A write is never retried, even on a retryable error, so it is never sent twice.
    calls = 0; retries.length = 0;
    restore = inject("D1_ERROR: Network connection lost.", 1);
    const w = await attempt(() => d.run(sql`insert into t (v) values ('c')`));
    restore();
    const after = await d.all<{ n: number }>(sql`select count(*) as n from t`);
    ok("write: not retried, nothing written twice", !!w.error && calls === 1 && retries.length === 0 && after[0].n === 2, { calls, n: after[0].n });

    // 6. A real D1 error from a real bad query keeps its 500 path (not busy) and is not retried.
    calls = 0; retries.length = 0;
    const bad = await attempt(() => d.all(sql`select * from no_such_table`));
    ok("real D1 error (no such table) is not busy and not retried", !!bad.error && d1BusyKind(bad.error) === null && retries.length === 0, { msg: String(bad.error?.message).slice(0, 160), causeMsg: String((bad.error as { cause?: Error })?.cause?.message ?? "").slice(0, 160) });

    // 7. The error shape Drizzle hands the app: the D1 message sits on the cause chain and is found there.
    restore = inject("D1_ERROR: Network connection lost.", 2);
    r = await attempt(() => d.all(sql`select v from t`));
    restore();
    ok("drizzle-wrapped busy error is found through err.cause", d1BusyKind(r.error) !== null, { top: r.error?.constructor?.name, hasCause: !!(r.error as { cause?: unknown })?.cause });

    // 8. A real write after all of this still works (statements not left patched).
    await d.run(sql`insert into t (v) values ('d')`);
    const end = await d.all<{ n: number }>(sql`select count(*) as n from t`);
    ok("prototype restored, writes work", end[0].n === 3);

    return Response.json({ ok: checks.every((c) => c.ok), checks });
  },
};

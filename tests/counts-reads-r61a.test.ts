import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { getCounts } from "@/server/services/counts-r34";
import { splitCountParts } from "@/server/services/mail/splits";
import { readsView } from "@/server/services/write-budget";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";

/**
 * R61a (D1 reads, 30 Oct): GET /api/counts read 1,109,372 rows per call on production for a workspace with 10,411 unread
 * Inbox rows, and two app opens took the account past the Free plan's 5M reads a day. The cause was the wrapper
 * coalesce(<Important rule>, 0): inside it SQLite ran the rule's IN subqueries again for every row. "is true" means the
 * same and reads 73,836 rows for the same count. MAIL_SPLIT_COUNTS=off skips the rule altogether.
 */
type Raw = { prepare: (q: string) => { run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown } };

const dialect = new SQLiteSyncDialect();
function sqlOf(q: SQL | null) {
  return q ? dialect.sqlToQuery(q).sql : "";
}

async function seeded(env: Record<string, string> = {}) {
  const ctx = await makeTestApp(env);
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const me = (await c.get("/api/account/me")).body.user.id as string;
  const org = (await c.get("/api/org")).body;
  const orgId = (org.org ?? org.organization ?? org).id as string;
  const raw = (ctx.db as unknown as { $client: Raw }).$client;
  raw.prepare("PRAGMA foreign_keys = OFF").run();
  const ins = raw.prepare(`INSERT INTO messages (id, org_id, mailbox_id, folder, thread_id, from_address, to_json, snippet, size_bytes, date, created_at, is_read, auth_results)
    VALUES (?, ?, 'mbx_1', ?, ?, ?, ?, 'hi', 100, ?, ?, ?, ?)`);
  const now = Date.now();
  // Sent to ann (so mail from ann is Important), a robot sender, a first time sender with passing auth, a repeat sender.
  ins.run("m_sent", orgId, "sent", "t_sent", "owner@acme.io", JSON.stringify([{ address: "ann@x.com" }]), now - 9000, now, 1, null);
  ins.run("m_ann", orgId, "inbox", "t_ann", "ann@x.com", "[]", now - 8000, now, 0, null);
  ins.run("m_robot", orgId, "inbox", "t_robot", "noreply@x.com", "[]", now - 7000, now, 0, null);
  const pass = JSON.stringify({ spf: "pass", dkim: "pass", dmarc: "pass" });
  ins.run("m_new1", orgId, "inbox", "t_new1", "bob@y.com", "[]", now - 6000, now, 0, pass);
  ins.run("m_new2", orgId, "inbox", "t_new2", "bob@y.com", "[]", now - 5000, now, 0, pass);
  ins.run("m_read", orgId, "inbox", "t_read", "ann@x.com", "[]", now - 4000, now, 1, null);
  return { ctx, actor: { orgId, userId: me, role: "owner" } as never, raw };
}

describe("R61a counts read the Important rule once", () => {
  it("the count parts use is true / is not true, never coalesce(<rule>, 0)", () => {
    const parts = splitCountParts("org_1", [{ id: "s1", name: "Clients", leavesImportant: true, rules: [{ field: "from", op: "contains", value: "client" }] } as never]);
    const imp = sqlOf(parts.important);
    expect(imp).toContain(") is true");
    expect(sqlOf(parts.notClaimed)).toContain(") is not true");
    expect(imp).not.toMatch(/coalesce\(\(\(coalesce/);
  });

  it("counts Important and Other the same as before (Important: a sender written to, a first time sender with passing auth)", async () => {
    const { ctx, actor } = await seeded();
    const r = await getCounts(ctx.deps, actor);
    // Unread Inbox: ann, robot, bob x2. Important: ann (written to) and bob's first message. Other: robot and bob's second.
    expect(r.mail).toEqual({ inbox: 4, important: 2, other: 2 });
  });

  it("MAIL_SPLIT_COUNTS=off answers 0 for Important and Other and never evaluates the rule", async () => {
    const { ctx, actor, raw } = await seeded({ MAIL_SPLIT_COUNTS: "off" });
    expect(ctx.deps.config.mailSplitCounts).toBe(false);
    const seen: string[] = [];
    const orig = raw.prepare.bind(raw);
    raw.prepare = (q: string) => { seen.push(q); return orig(q); };
    const r = await getCounts(ctx.deps, actor);
    raw.prepare = orig;
    expect(r.mail).toEqual({ inbox: 4, important: 0, other: 0 });
    expect(seen.join("\n")).not.toContain("row_number()");
    expect((await makeTestApp()).deps.config.mailSplitCounts).toBe(true);
  });
});

describe("R61a read budget on /api/health", () => {
  it("reads.pct is against the configured daily read budget", async () => {
    expect(readsView(1_000_000)).toMatchObject({ budget: 5_000_000, pct: 20, warnAt: 60 });
    const paid = await makeTestApp({ D1_DAILY_READ_BUDGET: "833000000", READ_BUDGET_WARN_PCT: "60" });
    const cfg = paid.deps.config.writeBudget;
    expect(cfg.readsDaily).toBe(833_000_000);
    expect(readsView(7_000_000, cfg)).toMatchObject({ budget: 833_000_000, pct: 0.8, level: "ok" });
    expect(readsView(500_000_000, cfg)?.level).toBe("warn");
    expect((await makeTestApp()).deps.config.writeBudget.readsDaily).toBe(5_000_000);
  });
});

import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers";
import { backfillAllowance, flagRowsQuery, flagWindowQuery, oldestUidQuery, readsHold, repairRowsQuery, repairStep, parseState } from "@/server/services/connect/sync";
import type { ImapSession } from "@/server/services/connect/imap";

/**
 * R61 D1 reads: production read 2.83M rows in one hour while one connected mailbox (about 10,500 rows) backfilled about
 * 5,000 messages. The flag window, the oldest stored UID and the header repair sweep each read the whole mailbox. They
 * now walk messages_mailbox_remote_idx and messages_mailbox_repair_idx (0093), and older mail waits once the day's reads
 * pass the read stop line.
 */
type Client = { prepare: (s: string) => { all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown } };

async function seeded(n = 3000) {
  const ctx = await makeTestApp();
  const client = (ctx.db as unknown as { $client: Client }).$client;
  client.prepare("PRAGMA foreign_keys = OFF").run();
  const ins = client.prepare(`INSERT INTO messages (id, org_id, mailbox_id, folder, thread_id, from_address, snippet, size_bytes, remote_box, remote_uid, date, created_at)
    VALUES (?, 'org_1', ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?)`);
  // One big connected mailbox (inbox and sent copies, a few rows waiting for repair) beside a smaller one.
  for (let i = 0; i < n; i++) {
    const pending = i % 500 === 0;
    ins.run(`msg_${String(i).padStart(6, "0")}`, "mbx_big", `thr_${i}`, pending ? "unknown@invalid" : `p${i}@x.y`, i % 700 === 0 ? "" : "hello", i % 2 ? -100 : 100, i % 3 ? "inbox" : "sent", i, Date.now(), Date.now());
  }
  for (let i = 0; i < 200; i++) ins.run(`msh_${i}`, "mbx_small", `thr_s${i}`, `s${i}@x.y`, "hi", 10, null, null, Date.now(), Date.now());
  client.prepare("ANALYZE").run();
  return { ctx, client };
}

function plan(client: Client, q: { sql: string; params: unknown[] }) {
  return (client.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as { detail: string }[]).map((r) => r.detail).join(" | ");
}

describe("R61 connected mailbox sync reads ride indexes", () => {
  it("flag window, changed UIDs and the oldest stored UID walk messages_mailbox_remote_idx", async () => {
    const { ctx, client } = await seeded();
    const w = plan(client, flagWindowQuery(ctx.db, "mbx_big", "inbox", 2800, 3000).toSQL());
    expect(w).toContain("messages_mailbox_remote_idx (mailbox_id=? AND remote_box=? AND remote_uid>? AND remote_uid<?)");
    const r = plan(client, flagRowsQuery(ctx.db, "mbx_big", "inbox", [5, 6, 7]).toSQL());
    expect(r).toMatch(/messages_mailbox_remote_idx \(mailbox_id=\? AND remote_box=\? AND remote_uid=\?\)/);
    const m = plan(client, oldestUidQuery(ctx.db, "mbx_big", "sent").toSQL());
    expect(m).toContain("messages_mailbox_remote_idx");
    for (const p of [w, r, m]) expect(p).not.toMatch(/SCAN messages(?! USING)|messages_mailbox_folder_idx|messages_mailbox_msgid_idx/);
    // Same answers as before.
    expect((await flagWindowQuery(ctx.db, "mbx_big", "inbox", 2800, 3000)).length).toBe(134);
    expect((await oldestUidQuery(ctx.db, "mbx_big", "sent").get())!.lo).toBe(0);
    expect((await oldestUidQuery(ctx.db, "mbx_small", "inbox").get())!.lo).toBeNull();
  });

  it("the repair sweep walks only rows still waiting for repair, in id order, with no sort", async () => {
    const { ctx, client } = await seeded();
    const p = plan(client, repairRowsQuery(ctx.db, "mbx_big", "").toSQL());
    expect(p).toContain("messages_mailbox_repair_idx (mailbox_id=? AND id>?)");
    expect(p).not.toMatch(/TEMP B-TREE|SCAN messages(?! USING)/);
    const rows = await repairRowsQuery(ctx.db, "mbx_big", "");
    // Waiting: an unknown sender (every 500th row) or a negative size with no preview (none here: those rows are even).
    const expected = Array.from({ length: 3000 }, (_, i) => i).filter((i) => i % 500 === 0 || (i % 700 === 0 && i % 2 === 1));
    expect(rows.map((x) => x.id)).toEqual(expected.map((i) => `msg_${String(i).padStart(6, "0")}`));
    expect(await repairRowsQuery(ctx.db, "mbx_big", rows[2].id)).toHaveLength(expected.length - 3);
  });
});

describe("R61 read stop line for older mail", () => {
  const reading = (rowsRead?: number) => ({ rowsWritten: 0, budget: 100_000, level: "ok", rowsRead });

  it("holds at 40% of D1's 5M daily reads by default, and unknown reads never hold", async () => {
    expect(readsHold({ rowsRead: 1_999_999 }, 40)).toBe(false);
    expect(readsHold({ rowsRead: 2_000_000 }, 40)).toBe(true);
    expect(readsHold({}, 40)).toBe(false);
    const ctx = await makeTestApp();
    expect(ctx.deps.config.mailConnect.backfill.readStopPct).toBe(40);
    const day = "2026-10-30";
    expect(await backfillAllowance(ctx.deps, parseState("{}"), reading(2_100_000), day)).toEqual({ n: 0, wait: "budget" });
    expect((await backfillAllowance(ctx.deps, parseState("{}"), reading(1_000_000), day)).n).toBeGreaterThan(0);
    expect((await backfillAllowance(ctx.deps, parseState("{}"), reading(undefined), day)).n).toBeGreaterThan(0);
  });

  it("MAIL_SYNC_BACKFILL_READ_STOP_PCT moves the line, capped at 60", async () => {
    expect((await makeTestApp({ MAIL_SYNC_BACKFILL_READ_STOP_PCT: "30" })).deps.config.mailConnect.backfill.readStopPct).toBe(30);
    expect((await makeTestApp({ MAIL_SYNC_BACKFILL_READ_STOP_PCT: "95" })).deps.config.mailConnect.backfill.readStopPct).toBe(60);
  });

  it("the repair sweep reads nothing past the line", async () => {
    const ctx = await makeTestApp();
    let fetched = 0;
    const session = { fetchHeads: async () => { fetched++; return []; }, open: async () => { throw new Error("not reached"); } } as unknown as ImapSession;
    const state = parseState("{}");
    const r = await repairStep(ctx.deps, { id: "conn_1", mailboxId: "mbx_1" }, session, state, reading(2_500_000));
    expect(r).toMatchObject({ more: false, repaired: 0 });
    expect(fetched).toBe(0);
    expect(state.rp).toBeUndefined(); // the sweep's cursor is left where it was
  });
});

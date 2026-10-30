import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { toBase64, splitMbox } from "../src/web/lib/mbox-r40";
import { dataMoves, jobs, mailboxes, messages } from "../src/server/db/schema";
import { moveEmail, nudgeLeftBehindMoves, notifyMoveEnded } from "../src/server/services/data-move/service";
import { runDueJobs } from "../src/server/services/jobs";
import { makeTestApp, Client } from "./helpers";

const rawMsg = (id: string, subject: string) =>
  `Message-ID: <${id}@old.example>\r\nFrom: Old Friend <friend@old.example>\r\nTo: me@acme.io\r\nSubject: ${subject}\r\nDate: Tue, 1 Sep 2026 09:00:00 +1000\r\nContent-Type: text/plain\r\n\r\nHello from the archive.\r\n`;
const mbox = (ids: string[]) => splitMbox(new TextEncoder().encode(ids.map((id) => `From a@x Mon Sep  1 09:00:00 2026\r\n${rawMsg(id, `Archive ${id}`)}`).join("\r\n"))).map(toBase64);

async function setup() {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const box = (await c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" })).body.mailbox;
  return { ctx, c, box };
}

const used = async (ctx: Awaited<ReturnType<typeof makeTestApp>>, id: string) => (await ctx.db.select({ u: mailboxes.usedBytes }).from(mailboxes).where(eq(mailboxes.id, id)).get())!.u;

describe("R41 Undo for a mail archive import", () => {
  it("removes exactly the 3 imported messages, keeps other mail and frees the space", async () => {
    const { ctx, c, box } = await setup();
    // Mail that was there before the import: brought in by an earlier run (so a different run's ids).
    const before = await c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: box.id, total: 1, last: true, messages: mbox(["keep1"]) }, { "idempotency-key": "mbox_r41_keep_0001" });
    expect(before.status).toBe(200);
    const usedBefore = await used(ctx, box.id);
    const run = await c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: box.id, total: 3, fileName: "old.mbox", last: true, messages: mbox(["a1", "a2", "a3"]) }, { "idempotency-key": "mbox_r41_run_00001" });
    expect(run.status).toBe(200);
    expect(run.body.move).toMatchObject({ status: "done", created: 3, canUndo: true });
    expect((await ctx.db.select().from(messages).where(eq(messages.mailboxId, box.id))).length).toBe(4);
    expect(await used(ctx, box.id)).toBeGreaterThan(usedBefore);

    const undo = await c.post(`/api/data-moves/${run.body.move.id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.body.removed).toBe(3);
    expect(undo.body.move).toMatchObject({ status: "undone", canUndo: false });
    const left = await ctx.db.select({ subject: messages.subject }).from(messages).where(eq(messages.mailboxId, box.id));
    expect(left.map((m) => m.subject)).toEqual(["Archive keep1"]);
    expect(await used(ctx, box.id)).toBe(usedBefore);
    // A second undo removes nothing more.
    expect((await c.post(`/api/data-moves/${run.body.move.id}/undo`, {})).body.removed).toBe(0);
  });
});

describe("R41 done email and runs left behind", () => {
  it("a finished import queues exactly one email, sent with the counts and the history link", async () => {
    const { ctx, c, box } = await setup();
    const run = await c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: box.id, total: 2, fileName: "old.mbox", last: true, messages: mbox(["d1", "d2"]) }, { "idempotency-key": "mbox_r41_done_0001" });
    const id = run.body.move.id;
    const row = (await ctx.db.select().from(dataMoves).where(eq(dataMoves.id, id)).get())!;
    expect(row.notifiedAt).toBeInstanceOf(Date);
    expect(row.lastStepAt).toBeInstanceOf(Date);
    // A second finishing call (page and pass at once) does not queue another.
    expect(await notifyMoveEnded(ctx.deps, row, "done")).toBe(false);
    expect(await notifyMoveEnded(ctx.deps, { ...row, notifiedAt: null }, "done")).toBe(false);
    const queued = (await ctx.db.select().from(jobs)).filter((j) => j.type === "data-move.notify");
    expect(queued).toHaveLength(1);
    const e = moveEmail(ctx.deps, row, "done");
    expect(e.subject).toBe("Your import finished");
    expect(e.text).toContain("2 messages brought in.");
    expect(e.action.url).toMatch(/\/app\/settings\/import$/);
    expect(e.text).not.toMatch(/[\u2013\u2014]/);
    const sentBefore = ctx.outbound.sent.length;
    await runDueJobs(ctx.deps, 10, { types: ["data-move.notify"] });
    const mails = ctx.outbound.sent.slice(sentBefore).filter((m) => m.subject === "Your import finished");
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(["owner@acme.io"]);
  });

  it("the pass picks only running runs whose last step is older than 10 minutes, at most 5, and pauses each once", async () => {
    const { ctx, c, box } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: box.id, total: 9, messages: mbox([`n${i}`]) }, { "idempotency-key": `mbox_r41_nudge_${i}0000` });
      expect(r.body.move.status).toBe("running");
      ids.push(r.body.move.id);
    }
    const old = new Date(Date.now() - 11 * 60_000);
    for (const id of ids.slice(0, 6)) await ctx.db.update(dataMoves).set({ lastStepAt: old }).where(eq(dataMoves.id, id));
    // ids[6] stepped just now: not left behind. A done run with an old step is never touched.
    await ctx.db.update(dataMoves).set({ status: "done", lastStepAt: old }).where(eq(dataMoves.id, ids[5]));
    const first = await nudgeLeftBehindMoves(ctx.deps);
    expect(first).toEqual({ checked: 5, paused: 5 });
    const rows = await ctx.db.select().from(dataMoves);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids.slice(0, 5)) { expect(byId.get(id)!.status).toBe("stopped"); expect(byId.get(id)!.notifiedAt).toBeInstanceOf(Date); }
    expect(byId.get(ids[5])!.status).toBe("done");
    expect(byId.get(ids[6])!.status).toBe("running");
    expect((await ctx.db.select().from(jobs)).filter((j) => j.type === "data-move.notify")).toHaveLength(5);
    // The next pass finds nothing left.
    expect(await nudgeLeftBehindMoves(ctx.deps)).toEqual({ checked: 0, paused: 0 });
    const e = moveEmail(ctx.deps, byId.get(ids[0])!, "paused");
    expect(e.subject).toBe("Your import is paused");
    expect(e.text).toContain("choose the same file again");
  });
});

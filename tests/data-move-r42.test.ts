import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { toBase64, splitMbox } from "../src/web/lib/mbox-r40";
import { dataMoves, jobs, meetings } from "../src/server/db/schema";
import { moveEmail, nudgeLeftBehindMoves } from "../src/server/services/data-move/service";
import { runDueJobs } from "../src/server/services/jobs";
import { runMaintenance } from "../src/server/services/maintenance";
import { makeTestApp, Client } from "./helpers";

/* R42 move: what really happens when an import's page closes. The file never reaches the server whole, so nothing
 * finishes on its own; the paused email and "choose the same file again" must be true for every kind. */

const ics = ["BEGIN:VCALENDAR", "VERSION:2.0",
  "BEGIN:VEVENT", "UID:a@x", "DTSTART:20261110T010000Z", "DTEND:20261110T013000Z", "SUMMARY:Check A", "END:VEVENT",
  "BEGIN:VEVENT", "UID:b@x", "DTSTART:20261111T010000Z", "DTEND:20261111T013000Z", "SUMMARY:Check B", "END:VEVENT",
  "END:VCALENDAR", ""].join("\r\n");
const mbox = (ids: string[]) => splitMbox(new TextEncoder().encode(ids.map((id) => `From a@x Mon Sep  1 09:00:00 2026\r\nMessage-ID: <${id}@old.example>\r\nFrom: a@old.example\r\nSubject: ${id}\r\n\r\nHi\r\n`).join("\r\n"))).map(toBase64);

async function setup() {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  return { ctx, c };
}

/** Turns a finished calendar run into one paused after its first event, as a page closed between steps leaves it. */
async function pauseAfterFirst(ctx: Awaited<ReturnType<typeof makeTestApp>>, id: string, old = false) {
  const row = (await ctx.db.select().from(dataMoves).where(eq(dataMoves.id, id)).get())!;
  const made = JSON.parse(row.created ?? "{}") as { meetings: string[] };
  await ctx.db.delete(meetings).where(eq(meetings.id, made.meetings[1]));
  await ctx.db.update(dataMoves).set({ status: "stopped", done: 1, finishedAt: null, notifiedAt: null, created: JSON.stringify({ meetings: [made.meetings[0]] }),
    ...(old ? { lastStepAt: new Date(Date.now() - 11 * 60_000) } : {}) }).where(eq(dataMoves.id, id));
}

describe("R42 choosing the same file again carries on", () => {
  it("a paused calendar run is continued, not doubled, when the same file is chosen again", async () => {
    const { ctx, c } = await setup();
    const first = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "team.ics", content: ics });
    expect(first.body.move).toMatchObject({ status: "done", created: 2 });
    await pauseAfterFirst(ctx, first.body.move.id);
    expect(await ctx.db.select().from(meetings)).toHaveLength(1);

    const again = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "team.ics", content: ics });
    expect(again.status).toBe(200);
    expect(again.body.move.id).toBe(first.body.move.id);
    expect(again.body.move).toMatchObject({ status: "done", done: 2, total: 2, created: 2 });
    const titles = (await ctx.db.select({ t: meetings.title }).from(meetings)).map((m) => m.t).sort();
    expect(titles).toEqual(["Check A", "Check B"]);
    expect((await ctx.db.select().from(dataMoves)).filter((m) => m.kind === "import")).toHaveLength(1);
    // The continued run still sends its one "finished" email.
    expect((await ctx.db.select().from(jobs)).filter((j) => j.type === "data-move.notify")).toHaveLength(2);
  });

  it("a different file name, or a done run, starts a new run", async () => {
    const { ctx, c } = await setup();
    const first = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "team.ics", content: ics });
    await pauseAfterFirst(ctx, first.body.move.id);
    const other = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "other.ics", content: ics });
    expect(other.body.move.id).not.toBe(first.body.move.id);
    const done = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "other.ics", content: ics });
    expect(done.body.move.id).not.toBe(other.body.move.id);
  });
});

describe("R42 the scheduled pass and the paused email", () => {
  it("a paused calendar run gets one paused email; a cancelled mail import gets none", async () => {
    const { ctx, c } = await setup();
    const run = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "team.ics", content: ics });
    await pauseAfterFirst(ctx, run.body.move.id, true);
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const box = (await c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" })).body.mailbox;
    const mail = await c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: box.id, total: 9, messages: mbox(["c1"]) }, { "idempotency-key": "mbox_r42_cancel_0001" });
    expect((await c.post(`/api/data-moves/mbox/${mail.body.move.id}/stop`, {})).status).toBe(200);
    await ctx.db.update(dataMoves).set({ lastStepAt: new Date(Date.now() - 11 * 60_000) }).where(eq(dataMoves.id, mail.body.move.id));
    const before = (await ctx.db.select().from(jobs)).filter((j) => j.type === "data-move.notify").length;

    expect(await nudgeLeftBehindMoves(ctx.deps)).toEqual({ checked: 1, paused: 1 });
    expect((await ctx.db.select().from(jobs)).filter((j) => j.type === "data-move.notify").length).toBe(before + 1);
    const row = (await ctx.db.select().from(dataMoves).where(eq(dataMoves.id, run.body.move.id)).get())!;
    expect(row.status).toBe("stopped");
    expect(row.notifiedAt).toBeInstanceOf(Date);
    expect(await nudgeLeftBehindMoves(ctx.deps)).toEqual({ checked: 0, paused: 0 });

    const e = moveEmail(ctx.deps, row, "paused");
    expect(e.subject).toBe("Your import is paused");
    expect(e.text).toContain("Imports run only while their page is open, so nothing more will come in on its own.");
    expect(e.text).toContain("choose the same file again: it carries on from where it stopped");
    expect(e.text).toContain("1 item brought in, 1 of 2 done.");
    expect(e.text).not.toMatch(/[\u2013\u2014]|finishes on its own|in the background/);
  });

  it("the mail paused email says the page closed and that duplicates are skipped", async () => {
    const { ctx } = await setup();
    const row = { id: "mov_x", orgId: "org_x", kind: "import", source: "mail:mbox", fileName: "old.mbox", status: "stopped", total: 5, done: 3,
      counts: JSON.stringify({ stored: 3, duplicates: 0, unreadable: 0 }), created: JSON.stringify({ messages: ["a", "b", "c"] }) } as unknown as typeof dataMoves.$inferSelect;
    const e = moveEmail(ctx.deps, { ...row, createdAt: new Date(), updatedAt: new Date() } as typeof dataMoves.$inferSelect, "paused");
    expect(e.text).toContain("stopped part way, most likely because its page was closed");
    expect(e.text).toContain("Messages already in the mailbox are skipped, so nothing is doubled.");
    expect(e.text).toContain("3 messages brought in.");
  });

  it("one maintenance pass both finds the paused run and sends its email (the pass runs before the jobs step)", async () => {
    const { ctx, c } = await setup();
    const run = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "team.ics", content: ics });
    await runDueJobs(ctx.deps, 10, { types: ["data-move.notify"] }); // the "finished" email of the first run
    await pauseAfterFirst(ctx, run.body.move.id, true);
    const sentBefore = ctx.outbound.sent.length;
    await runMaintenance(ctx.deps);
    const paused = ctx.outbound.sent.slice(sentBefore).filter((m) => m.subject === "Your import is paused");
    expect(paused).toHaveLength(1);
    expect(paused[0].to).toEqual(["owner@acme.io"]);
  });
});

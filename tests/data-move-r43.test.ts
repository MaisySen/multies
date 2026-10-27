import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { toBase64, splitMbox } from "../src/web/lib/mbox-r40";
import { dataMoves, jobs, meetings, messages } from "../src/server/db/schema";
import { continueKeptMoves } from "../src/server/services/data-move/continue";
import { MemoryImportFileStore } from "../src/server/services/data-move/kept-file";
import { nudgeLeftBehindMoves } from "../src/server/services/data-move/service";
import { runDueJobs } from "../src/server/services/jobs";
import { makeTestApp, Client } from "./helpers";

/* R43: imports finish after the page closes. The upload is kept (Workers KV in production, a memory store here) and
 * the scheduled pass runs the rest as the person who started it, then sends the one "finished" email. */

const ev = (n: number) => ["BEGIN:VEVENT", `UID:e${n}@x`, `DTSTART:202611${String(10 + n).padStart(2, "0")}T010000Z`, `DTEND:202611${String(10 + n).padStart(2, "0")}T013000Z`, `SUMMARY:Check ${n}`, "END:VEVENT"];
const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", ...ev(1), ...ev(2), ...ev(3), "END:VCALENDAR", ""].join("\r\n");
const mbox = (ids: string[]) => splitMbox(new TextEncoder().encode(ids.map((id) => `From a@x Mon Sep  1 09:00:00 2026\r\nMessage-ID: <${id}@old.example>\r\nFrom: a@old.example\r\nSubject: ${id}\r\n\r\nHi\r\n`).join("\r\n"))).map(toBase64);

async function setup(env: Record<string, string> = { IMPORT_STEP_MAX_ITEMS: "1" }) {
  const ctx = await makeTestApp(env);
  const store = new MemoryImportFileStore();
  ctx.deps.importFiles = store;
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  return { ctx, c, store };
}
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
const row = async (ctx: Ctx, id: string) => (await ctx.db.select().from(dataMoves).where(eq(dataMoves.id, id)).get())!;
/** The page closed: no step for 3 minutes. */
const quiet = (ctx: Ctx, id: string) => ctx.db.update(dataMoves).set({ lastStepAt: new Date(Date.now() - 3 * 60_000) }).where(eq(dataMoves.id, id));
const notifyJobs = async (ctx: Ctx) => (await ctx.db.select().from(jobs)).filter((j) => j.type === "data-move.notify");

describe("R43 a calendar import finishes after its page closes", () => {
  it("keeps the file when a step stops part way, finishes in the scheduled pass, emails once and deletes the file", async () => {
    const { ctx, c, store } = await setup();
    const first = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "team.ics", content: ics });
    expect(first.status).toBe(200);
    expect(first.body.move).toMatchObject({ status: "stopped", done: 1, total: 3, background: true });
    const id = first.body.move.id as string;
    expect(store.data.size).toBe(1);
    expect((await row(ctx, id)).fileKey).toBe(`move/${(await row(ctx, id)).orgId}/${id}`);

    // While the page is still stepping (last step just now), the pass leaves the run alone.
    expect(await continueKeptMoves(ctx.deps)).toMatchObject({ checked: 0 });
    // A paused but kept run gets no "paused" email.
    await ctx.db.update(dataMoves).set({ lastStepAt: new Date(Date.now() - 11 * 60_000) }).where(eq(dataMoves.id, id));
    expect(await nudgeLeftBehindMoves(ctx.deps)).toMatchObject({ checked: 0, paused: 0 });

    const pass = await continueKeptMoves(ctx.deps);
    expect(pass).toMatchObject({ checked: 1, continued: 1, finished: 1 });
    const done = await row(ctx, id);
    expect(done).toMatchObject({ status: "done", done: 3, total: 3, fileKey: null, fileParts: null });
    expect(store.data.size).toBe(0);
    expect((await ctx.db.select().from(meetings)).map((m) => m.title).sort()).toEqual(["Check 1", "Check 2", "Check 3"]);
    expect(await notifyJobs(ctx)).toHaveLength(1);
    const sentBefore = ctx.outbound.sent.length;
    await runDueJobs(ctx.deps, 10);
    expect(ctx.outbound.sent.slice(sentBefore).filter((m) => m.subject === "Your import finished")).toHaveLength(1);
    // A second pass finds nothing.
    expect(await continueKeptMoves(ctx.deps)).toMatchObject({ checked: 0 });
  });

  it("a run undone before its email goes out sends no email, and Undo deletes a kept file", async () => {
    const { ctx, c, store } = await setup();
    const first = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "a.ics", content: ics });
    const id = first.body.move.id as string;
    await quiet(ctx, id);
    await continueKeptMoves(ctx.deps);
    expect((await row(ctx, id)).status).toBe("done");
    expect((await c.post(`/api/data-moves/${id}/undo`, {})).status).toBe(200);
    const sentBefore = ctx.outbound.sent.length;
    await runDueJobs(ctx.deps, 10);
    expect(ctx.outbound.sent.slice(sentBefore).filter((m) => m.subject?.startsWith("Your import"))).toHaveLength(0);

    const second = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "b.ics", content: ics });
    expect(store.data.size).toBe(1);
    expect((await c.post(`/api/data-moves/${second.body.move.id}/undo`, {})).status).toBe(200);
    expect(store.data.size).toBe(0);
    expect((await row(ctx, second.body.move.id)).fileKey).toBeNull();
    await quiet(ctx, second.body.move.id);
    expect(await continueKeptMoves(ctx.deps)).toMatchObject({ checked: 0 });
  });

  it("an import that finishes in one step keeps nothing; without a store nothing is kept and the paused email still works", async () => {
    const { c, store } = await setup({});
    const r = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "one.ics", content: ics });
    expect(r.body.move).toMatchObject({ status: "done", background: false });
    expect(store.data.size).toBe(0);

    const off = await makeTestApp({ IMPORT_STEP_MAX_ITEMS: "1" });
    const c2 = new Client(off.app);
    await c2.signup("owner@acme.io");
    const p = await c2.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "team.ics", content: ics });
    expect(p.body.move).toMatchObject({ status: "stopped", background: false });
    await off.db.update(dataMoves).set({ lastStepAt: new Date(Date.now() - 11 * 60_000) }).where(eq(dataMoves.id, p.body.move.id));
    expect(await nudgeLeftBehindMoves(off.deps)).toMatchObject({ paused: 1 });
  });

  it("an expired kept file is dropped and the run then gets its paused email", async () => {
    const { ctx, c, store } = await setup();
    const first = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "old.ics", content: ics });
    const id = first.body.move.id as string;
    await ctx.db.update(dataMoves).set({ fileExpiresAt: new Date(Date.now() - 1000), lastStepAt: new Date(Date.now() - 11 * 60_000) }).where(eq(dataMoves.id, id));
    expect(await continueKeptMoves(ctx.deps)).toMatchObject({ checked: 1, continued: 0 });
    expect(store.data.size).toBe(0);
    expect((await row(ctx, id)).fileKey).toBeNull();
    expect(await nudgeLeftBehindMoves(ctx.deps)).toMatchObject({ paused: 1 });
  });
});

describe("R43 a mail archive import finishes after its page closes", () => {
  async function mailSetup() {
    const s = await setup({});
    const domainId = (await s.c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const box = (await s.c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" })).body.mailbox;
    return { ...s, box };
  }
  const keep = (ctx: Ctx, c: Client, id: string, qs: string, body: string) =>
    ctx.app.request(`/api/data-moves/mbox/${id}/keep?${qs}`, { method: "POST", headers: { cookie: c.cookie, "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ lines: body }) });

  it("keeps the parts the page uploads, then the pass brings in the rest, emails once and deletes the parts", async () => {
    const { ctx, c, store, box } = await mailSetup();
    const all = mbox(["k1", "k2", "k3", "k4", "k5"]);
    const b1 = await c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: box.id, total: 5, fileName: "old.mbox", messages: all.slice(0, 3) }, { "idempotency-key": "mbox_r43_keep_0001" });
    expect(b1.status).toBe(200);
    const id = b1.body.move.id as string;
    const p0 = await keep(ctx, c, id, "part=0&parts=2", all.slice(0, 2).join("\n"));
    expect(p0.status).toBe(200);
    expect(await p0.json()).toMatchObject({ kept: false, reason: "more" });
    expect((await row(ctx, id)).fileKey).toBeNull();
    const p1 = await keep(ctx, c, id, `part=1&parts=2&starts=0,2&mailboxId=${box.id}&folder=INBOX`, all.slice(2).join("\n"));
    expect(await p1.json()).toMatchObject({ kept: true });
    expect(store.data.size).toBe(2);
    const listed = await c.get(`/api/data-moves/${id}`);
    expect(listed.body.move ?? listed.body).toMatchObject({ background: true });

    await quiet(ctx, id);
    // A kept mail run is not ended by the left behind pass.
    await ctx.db.update(dataMoves).set({ lastStepAt: new Date(Date.now() - 11 * 60_000) }).where(eq(dataMoves.id, id));
    expect(await nudgeLeftBehindMoves(ctx.deps)).toMatchObject({ checked: 0 });
    expect(await continueKeptMoves(ctx.deps)).toMatchObject({ continued: 1, finished: 1 });
    expect(await row(ctx, id)).toMatchObject({ status: "done", done: 5, fileKey: null });
    expect(store.data.size).toBe(0);
    expect((await ctx.db.select().from(messages).where(eq(messages.mailboxId, box.id))).map((m) => m.subject).sort()).toEqual(["k1", "k2", "k3", "k4", "k5"]);
    expect(await notifyJobs(ctx)).toHaveLength(1);
  });

  it("Cancel deletes the kept parts, so nothing carries on", async () => {
    const { ctx, c, store, box } = await mailSetup();
    const all = mbox(["x1", "x2", "x3", "x4"]);
    const b1 = await c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: box.id, total: 4, messages: all.slice(0, 3) }, { "idempotency-key": "mbox_r43_cancel_001" });
    const id = b1.body.move.id as string;
    await keep(ctx, c, id, `part=0&parts=1&starts=0&mailboxId=${box.id}`, all.join("\n"));
    expect(store.data.size).toBe(1);
    expect((await c.post(`/api/data-moves/mbox/${id}/stop`, {})).status).toBe(200);
    expect(store.data.size).toBe(0);
    await quiet(ctx, id);
    expect(await continueKeptMoves(ctx.deps)).toMatchObject({ checked: 0 });
  });

  it("refuses bad part numbers and a last part without starts", async () => {
    const { ctx, c, box } = await mailSetup();
    const b1 = await c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: box.id, total: 4, messages: mbox(["y1"]) }, { "idempotency-key": "mbox_r43_bad_00001" });
    const id = b1.body.move.id as string;
    expect((await keep(ctx, c, id, "part=3&parts=2", "a")).status).toBe(422);
    expect((await keep(ctx, c, id, "part=0&parts=1", "a")).status).toBe(422);
  });
});

describe("R43 IMPORT_STEP_CAP_ORGS (a live check on production)", () => {
  it("takes one item steps only in the named workspace, so a tiny file still exercises the background finish", async () => {
    const { ctx, c, store } = await setup({});
    const plain = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "plain.ics", content: ics });
    expect(plain.body.move).toMatchObject({ status: "done", done: 3, total: 3 });
    expect(store.data.size).toBe(0);
    const orgId = (await row(ctx, plain.body.move.id as string)).orgId;
    (ctx.deps.config as { importStepCapOrgs?: string[] }).importStepCapOrgs = ["org_someoneelse", orgId];
    const two = ["BEGIN:VCALENDAR", "VERSION:2.0", ...ev(7), ...ev(8), "END:VCALENDAR", ""].join("\r\n");
    const capped = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "two.ics", content: two });
    expect(capped.body.move).toMatchObject({ status: "stopped", done: 1, total: 2, background: true });
    expect(store.data.size).toBe(1);
    await quiet(ctx, capped.body.move.id as string);
    expect(await continueKeptMoves(ctx.deps)).toMatchObject({ continued: 1, finished: 1 });
    expect(store.data.size).toBe(0);
  });
});

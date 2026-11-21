import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import {
  addNote, deleteNote, getNote, listNotes, NOTE_BODY_MAX, setNotePinned, type NoteSortField, type OperatorNote,
} from "@/server/services/console/notes";
import type { PageCursor, PageRequest } from "@/server/services/console/moderation";

/** OPS1: operator notes on workspaces and people (data layer). */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let orgA: string, orgB: string, userA: string;
let clock = new Date("2026-11-20T00:00:00.000Z").getTime();
const author = { userId: "op_1", email: "ops@multies.io" };

beforeEach(async () => {
  ctx = await makeTestApp();
  const a = new Client(ctx.app);
  await a.signup("olive@acme.io", "Olive Owner", "Acme");
  const b = new Client(ctx.app);
  await b.signup("bea@beta.io", "Bea Boss", "Beta Works");
  const meA = (await a.get("/api/account/me")).body;
  orgA = meA.organization.id; userA = meA.user.id;
  orgB = (await b.get("/api/account/me")).body.organization.id;
  clock = new Date("2026-11-20T00:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
});

const pageOf = (limit: number, cursor: PageCursor | null = null, dir: "asc" | "desc" = "desc"): PageRequest<NoteSortField> => ({ limit, cursor, sort: { field: "createdAt", dir } });

async function all(targetType: "workspace" | "user", targetId: string, limit: number, dir: "asc" | "desc" = "desc") {
  const out: OperatorNote[] = [];
  let cursor: PageCursor | null = null;
  for (let i = 0; i < 50; i++) {
    const p = await listNotes(ctx.deps, { targetType, targetId, page: pageOf(limit, cursor, dir) });
    out.push(...p.items);
    if (!p.next) break;
    cursor = p.next;
  }
  return out;
}

describe("operator notes", () => {
  it("adds trimmed notes, keeps workspaces and people apart, and checks the target", async () => {
    const r = await addNote(ctx.deps, { targetType: "workspace", targetId: orgA, body: "  Called the owner about bounces.  ", author });
    expect(r.note).toMatchObject({ targetType: "workspace", targetId: orgA, body: "Called the owner about bounces.", pinned: false, authorUserId: "op_1", authorEmail: "ops@multies.io" });
    expect(r.before).toBeNull();
    expect(r.after).toEqual({ id: r.note.id, targetType: "workspace", targetId: orgA, pinned: false, length: 31, deleted: false });
    await addNote(ctx.deps, { targetType: "workspace", targetId: orgB, body: "Other workspace", author });
    await addNote(ctx.deps, { targetType: "user", targetId: userA, body: "About the person", author });
    expect((await all("workspace", orgA, 50)).map((n) => n.body)).toEqual(["Called the owner about bounces."]);
    expect((await all("user", userA, 50)).map((n) => n.body)).toEqual(["About the person"]);
    expect(await all("user", orgA, 50)).toEqual([]);
    await expect(addNote(ctx.deps, { targetType: "workspace", targetId: "org_missing", body: "x", author })).rejects.toMatchObject({ status: 404 });
    await expect(addNote(ctx.deps, { targetType: "user", targetId: orgA, body: "x", author })).rejects.toMatchObject({ status: 404 });
  });

  it("enforces the body limits", async () => {
    await expect(addNote(ctx.deps, { targetType: "workspace", targetId: orgA, body: "   ", author })).rejects.toMatchObject({ status: 422 });
    await expect(addNote(ctx.deps, { targetType: "workspace", targetId: orgA, body: "x".repeat(NOTE_BODY_MAX + 1), author })).rejects.toMatchObject({ status: 422 });
    const max = await addNote(ctx.deps, { targetType: "workspace", targetId: orgA, body: ` ${"y".repeat(NOTE_BODY_MAX)} `, author });
    expect(max.note.body).toHaveLength(NOTE_BODY_MAX);
    await expect(addNote(ctx.deps, { targetType: "team" as "user", targetId: orgA, body: "x", author })).rejects.toMatchObject({ status: 400 });
  });

  it("lists pinned first, then newest, and pages without duplicates or gaps", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await addNote(ctx.deps, { targetType: "workspace", targetId: orgA, body: `note ${i}`, pinned: i === 2 || i === 9, author })).note.id);
    // Same time for two notes: the id breaks the tie.
    const same = clock;
    ctx.deps.now = () => new Date(same);
    ids.push((await addNote(ctx.deps, { targetType: "workspace", targetId: orgA, body: "tie a", author })).note.id);
    ids.push((await addNote(ctx.deps, { targetType: "workspace", targetId: orgA, body: "tie b", author })).note.id);
    ctx.deps.now = () => new Date((clock += 1000));

    const full = await all("workspace", orgA, 200);
    expect(full.slice(0, 2).map((n) => n.body)).toEqual(["note 9", "note 2"]);
    expect(full.slice(2, 4).map((n) => n.body).sort()).toEqual(["tie a", "tie b"]);
    expect(full.slice(4).map((n) => n.body)).toEqual([11, 10, 8, 7, 6, 5, 4, 3, 1, 0].map((i) => `note ${i}`));
    for (const limit of [1, 3, 5]) {
      const paged = await all("workspace", orgA, limit);
      expect(paged.map((n) => n.id)).toEqual(full.map((n) => n.id));
    }
    const asc = await all("workspace", orgA, 4, "asc");
    expect(asc.slice(0, 2).map((n) => n.body)).toEqual(["note 2", "note 9"]);
    expect(new Set(asc.map((n) => n.id)).size).toBe(14);
    await expect(listNotes(ctx.deps, { targetType: "workspace", targetId: orgA, page: { limit: 5, cursor: null, sort: { field: "body" as "createdAt", dir: "desc" } } })).rejects.toMatchObject({ status: 400, code: "bad_sort" });
  });

  it("pins, unpins and soft deletes, with before and after", async () => {
    const a = (await addNote(ctx.deps, { targetType: "workspace", targetId: orgA, body: "first", author })).note;
    const b = (await addNote(ctx.deps, { targetType: "workspace", targetId: orgA, body: "second", author })).note;
    const pin = await setNotePinned(ctx.deps, a.id, true);
    expect(pin.before?.pinned).toBe(false);
    expect(pin.after.pinned).toBe(true);
    expect((await all("workspace", orgA, 50)).map((n) => n.id)).toEqual([a.id, b.id]);
    await setNotePinned(ctx.deps, a.id, false);
    expect((await all("workspace", orgA, 50)).map((n) => n.id)).toEqual([b.id, a.id]);

    const del = await deleteNote(ctx.deps, b.id);
    expect(del.before).toMatchObject({ id: b.id, deleted: false, length: 6 });
    expect(del.after).toMatchObject({ id: b.id, deleted: true });
    expect((await all("workspace", orgA, 50)).map((n) => n.id)).toEqual([a.id]);
    expect((await getNote(ctx.deps, b.id))?.deletedAt).toEqual(expect.any(String));
    expect(await getNote(ctx.deps, "onote_missing")).toBeNull();
    await expect(deleteNote(ctx.deps, b.id)).rejects.toMatchObject({ status: 404 });
    await expect(setNotePinned(ctx.deps, b.id, true)).rejects.toMatchObject({ status: 404 });
  });
});

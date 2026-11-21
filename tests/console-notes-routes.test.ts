/**
 * OPS1: operator notes on a workspace or a person (/api/console/workspaces/notes). Staff only, pinned first, the
 * author or an owner deletes, and every change is audited without the note's text (and never on the workspace's own
 * log, which its admins can read).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { auditLogs, platformAuditLogs } from "@/server/db/schema";

const SECRET_NOTE = "NOTE-TEXT-SENTINEL-Vb93kXq7Lm2 customer promised a refund";

let ctx: Ctx;
let owner: Client;
let support: Client;
let support2: Client;
let readonly: Client;
let customer: Client;
let orgId: string;
let custUserId: string;

const base = "/api/console/workspaces/notes";
const notesOn = (c: Client, targetType: string, targetId: string, extra = "") => c.get(`${base}?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}${extra}`);

beforeAll(async () => {
  ctx = await makeTestApp();
  owner = (await signUpAs(ctx, "own@ops.test", "admin", "Ops Home")).c;
  support = (await signUpAs(ctx, "sup@ops.test", "ops_support", "Support Home")).c;
  support2 = (await signUpAs(ctx, "sup2@ops.test", "ops_support", "Support Two")).c;
  readonly = (await signUpAs(ctx, "ro@ops.test", "ops_readonly", "Readonly Home")).c;
  const cu = await signUpAs(ctx, "cust@else.test", null, "Customer Co");
  customer = cu.c;
  custUserId = cu.id;
  orgId = (await customer.get("/api/account/me")).body.organization.id;
}, 120_000);

describe("operator notes", { timeout: 60_000 }, () => {
  it("adds, lists pinned first, pages, pins and audits without the text", async () => {
    expect((await readonly.post(base, { targetType: "workspace", targetId: orgId, body: "hello" })).status).toBe(403);
    expect((await customer.post(base, { targetType: "workspace", targetId: orgId, body: "hello" })).status).toBe(403);
    expect((await new Client(ctx.app).post(base, { targetType: "workspace", targetId: orgId, body: "hello" })).status).toBe(401);
    expect((await support.post(base, { targetType: "workspace", targetId: orgId, body: "   " })).status).toBe(422);
    expect((await support.post(base, { targetType: "team", targetId: orgId, body: "hi" })).status).toBe(422);
    expect((await support.post(base, { targetType: "workspace", targetId: "org_nope", body: "hi" })).status).toBe(404);

    const a = await support.post(base, { targetType: "workspace", targetId: orgId, body: SECRET_NOTE });
    expect(a.status).toBe(201);
    expect(a.body.note).toMatchObject({ body: SECRET_NOTE, pinned: false, authorEmail: "sup@ops.test" });
    const b = await support.post(base, { targetType: "workspace", targetId: orgId, body: "Second note", reason: "Handover to the next shift" });
    const c = await owner.post(base, { targetType: "workspace", targetId: orgId, body: "Third note", pinned: true });
    expect(c.body.note.pinned).toBe(true);

    const list = await notesOn(readonly, "workspace", orgId);
    expect(list.status).toBe(200);
    expect(list.body.items.map((n: { body: string }) => n.body)).toEqual(["Third note", "Second note", SECRET_NOTE]);

    const p1 = await notesOn(readonly, "workspace", orgId, "&limit=2");
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await notesOn(readonly, "workspace", orgId, `&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.items.map((n: { id: string }) => n.id)).toEqual([a.body.note.id]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await notesOn(readonly, "workspace", orgId, "&sort=body:asc")).status).toBe(400);
    expect((await readonly.get(`${base}?targetType=team&targetId=x`)).status).toBe(400);
    expect((await customer.get(`${base}?targetType=workspace&targetId=${orgId}`)).status).toBe(403);

    // Pin the first note: it moves to the top band.
    expect((await readonly.post(`${base}/${a.body.note.id}/pin`, { pinned: true })).status).toBe(403);
    expect((await support2.post(`${base}/${a.body.note.id}/pin`, {})).status).toBe(422);
    expect((await support2.post(`${base}/onote_nope/pin`, { pinned: true })).status).toBe(404);
    const pin = await support2.post(`${base}/${a.body.note.id}/pin`, { pinned: true });
    expect(pin.status).toBe(200);
    expect(pin.body.note.pinned).toBe(true);
    const after = await notesOn(readonly, "workspace", orgId);
    expect(after.body.items.slice(0, 2).map((n: { pinned: boolean }) => n.pinned)).toEqual([true, true]);
    expect(after.body.items[2].body).toBe("Second note");

    // Audit: rows for each change, never the text, and nothing on the workspace's own log.
    const rows = await ctx.db.select().from(platformAuditLogs).where(like(platformAuditLogs.action, "note.%")).all();
    expect(rows.map((r) => r.action).sort()).toEqual(["note.added", "note.added", "note.added", "note.pinned"]);
    expect(rows.find((r) => r.targetId === b.body.note.id)).toMatchObject({ reason: "Handover to the next shift", orgId, targetType: "note" });
    expect(JSON.stringify(rows)).not.toContain("NOTE-TEXT-SENTINEL-Vb93kXq7Lm2");
    const wsRows = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), like(auditLogs.action, "note.%"))).all();
    expect(wsRows).toEqual([]);
  });

  it("only the author or an owner deletes, with a reason", async () => {
    const n = (await support.post(base, { targetType: "user", targetId: custUserId, body: "Asked twice about invoices" })).body.note;
    expect(n.targetType).toBe("user");
    expect((await notesOn(readonly, "user", custUserId)).body.items.map((x: { id: string }) => x.id)).toEqual([n.id]);

    expect((await support.call("DELETE", `${base}/${n.id}`, {})).status).toBe(422);
    const other = await support2.call("DELETE", `${base}/${n.id}`, { reason: "Not needed any more" });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("not_author");
    expect((await readonly.call("DELETE", `${base}/${n.id}`, { reason: "Not needed any more" })).status).toBe(403);
    expect((await support.call("DELETE", `${base}/${n.id}`, { reason: "Not needed any more" })).status).toBe(200);
    expect((await notesOn(readonly, "user", custUserId)).body.items).toEqual([]);
    expect((await support.call("DELETE", `${base}/${n.id}`, { reason: "Again please" })).status).toBe(404);
    const del = (await ctx.db.select().from(platformAuditLogs).where(and(eq(platformAuditLogs.action, "note.deleted"), eq(platformAuditLogs.targetId, n.id))).get())!;
    expect(del).toMatchObject({ actorEmail: "sup@ops.test", reason: "Not needed any more", orgId: null });
    expect(JSON.parse(del.after!)).toMatchObject({ deleted: true });
    expect(JSON.stringify(del)).not.toContain("Asked twice about invoices");

    // An owner may delete someone else's note.
    const m = (await support.post(base, { targetType: "user", targetId: custUserId, body: "Owner will remove this" })).body.note;
    expect((await owner.call("DELETE", `${base}/${m.id}`, { reason: "Duplicate of the ticket" })).status).toBe(200);
  });
});

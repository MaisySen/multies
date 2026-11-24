/**
 * PRIV1b P59 (round 2, owner decision): a personal mailbox is suspended, deleted or disconnected only by the person it
 * belongs to. Workspace owners and admins manage people, not their mail: they keep quota changes, and they can still
 * remove the person (which ends shares and leaves the mailbox as an orphan). Once the owner has left, the workspace
 * owner (role owner) may suspend, delete or disconnect it. Team mailboxes are unchanged: admins only.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { mailConnections, mailboxes } from "@/server/db/schema";

type W = Awaited<ReturnType<typeof privacyWorld>>;
const box = async (w: W, id: string) => w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
async function v1(w: W, key: string, method: string, path: string, body?: unknown) {
  const res = await w.ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return res.status;
}

describe("PRIV1b P59: only the owner suspends, deletes or disconnects a personal mailbox", () => {
  it("owner and admin can't (app and API); a send-as delegate can't; admins keep quota; the owner can", async () => {
    const w = await privacyWorld({ real: true });
    const r = w.real!;
    const adaKey = (await w.admin.c.post("/api/developer/keys", { name: "k" })).body.secret as string;
    const oliveKey = (await w.owner.post("/api/developer/keys", { name: "k" })).body.secret as string;
    for (const c of [w.owner, w.admin.c]) {
      expect((await c.patch(`/api/mailboxes/${w.boxes.personal}`, { status: "suspended" })).status).toBe(404);
      expect((await c.del(`/api/mailboxes/${w.boxes.personal}`)).status).toBe(404);
      expect((await c.del(`/api/connections/${r.connectionId}`)).status).toBe(404);
    }
    for (const k of [adaKey, oliveKey]) {
      expect(await v1(w, k, "PATCH", `/mailboxes/${w.boxes.personal}`, { displayName: "x" })).toBe(404);
      expect(await v1(w, k, "DELETE", `/mailboxes/${w.boxes.personal}`)).toBe(404);
    }
    // A delegate who can open it is told why.
    const shared = await w.dSend.c.del(`/api/mailboxes/${w.boxes.personal}`);
    expect(shared.status).toBe(403);
    expect(shared.body.error.message).toMatch(/belongs to/);
    expect((await w.dSend.c.patch(`/api/mailboxes/${w.boxes.personal}`, { status: "suspended" })).status).toBe(403);
    expect(await box(w, w.boxes.personal)).toMatchObject({ status: "active" });
    expect(await w.ctx.db.select().from(mailConnections).where(eq(mailConnections.id, r.connectionId)).get()).toBeTruthy();
    // Admins keep storage.
    expect((await w.admin.c.patch(`/api/mailboxes/${w.boxes.personal}`, { quotaMb: 50 })).status).toBe(200);

    // Pat, a member, suspends and deletes her own, and disconnects her Gmail.
    expect((await w.pat.c.patch(`/api/mailboxes/${w.boxes.personal}`, { status: "suspended" })).status).toBe(200);
    expect(await box(w, w.boxes.personal)).toMatchObject({ status: "suspended" });
    expect((await w.pat.c.del(`/api/mailboxes/${w.boxes.personal}`)).status).toBe(200);
    expect(await box(w, w.boxes.personal)).toBeUndefined();
    expect((await w.pat.c.del(`/api/connections/${r.connectionId}`)).status).toBe(200);
    expect(await box(w, r.connected)).toBeUndefined();
  }, 120_000);

  it("after the owner leaves, the workspace owner can; an admin still can't", async () => {
    const w = await privacyWorld({ real: true });
    const r = w.real!;
    expect((await w.owner.del(`/api/team/members/${w.pat.id}`)).status).toBeLessThan(300);
    expect((await w.admin.c.patch(`/api/mailboxes/${w.boxes.personal}`, { status: "suspended" })).status).toBe(404);
    expect((await w.admin.c.del(`/api/connections/${r.connectionId}`)).status).toBe(404);
    expect((await w.owner.patch(`/api/mailboxes/${w.boxes.personal}`, { status: "suspended" })).status).toBe(200);
    expect((await w.owner.del(`/api/mailboxes/${w.boxes.personal}`)).status).toBe(200);
    expect((await w.owner.del(`/api/connections/${r.connectionId}`)).status).toBe(200);
  }, 120_000);

  it("team mailboxes: admins suspend and delete as before, members can't", async () => {
    const w = await privacyWorld();
    expect((await w.member.c.del(`/api/mailboxes/${w.boxes.team}`)).status).toBe(403);
    expect((await w.member.c.patch(`/api/mailboxes/${w.boxes.team}`, { status: "suspended" })).status).toBe(403);
    expect((await w.admin.c.patch(`/api/mailboxes/${w.boxes.team}`, { status: "suspended" })).status).toBe(200);
    expect((await w.admin.c.del(`/api/mailboxes/${w.boxes.team}`)).status).toBe(200);
  }, 120_000);
});

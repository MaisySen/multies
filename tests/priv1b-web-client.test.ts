/**
 * PRIV1b web-client: P52 (the undo-send rescue copy belongs to one person and workspace, another person's is dropped,
 * sign out clears it), P66 (the client follows the share level, From is never a mailbox the person can't send from,
 * a 404 removes the mailbox, the notice is dismissed per person), and the web side of P23 and P24 (pickers and the
 * palette offer only mailboxes the person can open; Team pickers offer team mailboxes only).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { privacyWorld } from "./priv1a-world";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear(),
};

const A = { userId: "usr_A", orgId: "org_1" };
const B = { userId: "usr_B", orgId: "org_1" };
const draftOf = (text: string) => ({ mailboxId: "mbx_A_personal", to: "boss@x.com", subject: "Salary", text, inReplyToId: "msg_1" });

describe("PRIV1b (P52): held-send rescue copies stay with their person", () => {
  beforeEach(() => mem.clear());

  it("another person's copy is dropped, never reopened; the owner's own copy still comes back", async () => {
    const us = await import("@/web/lib/undo-send");
    const old = Date.now() - 60_000;
    us.rescueAdd({ key: "send_a1", dueAt: old, label: "to boss@x.com", draft: draftOf("secret body"), hadFiles: false, ...A });
    // B signs in on the same browser: held-status answers "unknown" for A's key (it is scoped to B).
    const reopened: unknown[] = [];
    await us.recoverHeldSends({ owner: B, status: async () => "unknown", reopen: (d) => reopened.push(d), notify: () => {} });
    expect(reopened).toEqual([]);
    expect(mem.get(us.HELD_RESCUE_KEY) ?? "").not.toContain("secret body");
    // A's own copy, in A's session, still comes back to A's Compose.
    us.rescueAdd({ key: "send_a2", dueAt: old, label: "to boss@x.com", draft: draftOf("mine"), hadFiles: false, ...A });
    await us.recoverHeldSends({ owner: A, status: async () => "unknown", reopen: (d) => reopened.push(d), notify: () => {} });
    expect(reopened).toHaveLength(1);
    expect((reopened[0] as { text: string }).text).toBe("mine");
  });

  it("a copy with no owner is dropped; another workspace of the same person waits; nothing runs before sign in", async () => {
    const us = await import("@/web/lib/undo-send");
    const old = Date.now() - 60_000;
    mem.set(us.HELD_RESCUE_KEY, JSON.stringify([{ key: "send_legacy", dueAt: old, label: "", draft: draftOf("legacy"), hadFiles: false }]));
    us.rescueAdd({ key: "send_o2", dueAt: old, label: "", draft: draftOf("org two"), hadFiles: false, userId: A.userId, orgId: "org_2" });
    const reopened: unknown[] = [];
    await us.recoverHeldSends({ owner: null, status: async () => "unknown", reopen: (d) => reopened.push(d), notify: () => {} });
    expect(mem.get(us.HELD_RESCUE_KEY)).toContain("legacy"); // not signed in yet: untouched
    await us.recoverHeldSends({ owner: A, status: async () => "unknown", reopen: (d) => reopened.push(d), notify: () => {} });
    expect(reopened).toEqual([]);
    const left = JSON.parse(mem.get(us.HELD_RESCUE_KEY) ?? "[]") as { key: string }[];
    expect(left.map((r) => r.key)).toEqual(["send_o2"]);
    await us.recoverHeldSends({ owner: { userId: A.userId, orgId: "org_2" }, status: async () => "unknown", reopen: (d) => reopened.push(d), notify: () => {} });
    expect(reopened).toHaveLength(1);
  });

  it("rescueAdd stamps the signed in person from the saved account copy", async () => {
    const us = await import("@/web/lib/undo-send");
    const { writeMeCache, clearMeCache } = await import("@/web/lib/me-cache");
    writeMeCache({ user: { id: "usr_C" }, organization: { id: "org_9" } } as never);
    us.rescueAdd({ key: "send_c1", dueAt: 1, label: "", draft: draftOf("c"), hadFiles: false });
    expect(JSON.parse(mem.get(us.HELD_RESCUE_KEY)!)[0]).toMatchObject({ userId: "usr_C", orgId: "org_9" });
    clearMeCache();
  });

  it("sign out (clearOfflineData) removes the rescue copies", async () => {
    const us = await import("@/web/lib/undo-send");
    const { clearOfflineData } = await import("@/web/lib/sw-client");
    us.rescueAdd({ key: "send_a3", dueAt: 1, label: "", draft: draftOf("secret body"), hadFiles: false, ...A });
    expect(mem.get(us.HELD_RESCUE_KEY)).toContain("secret body");
    await clearOfflineData();
    expect(mem.get(us.HELD_RESCUE_KEY)).toBeUndefined();
  });
});

describe("PRIV1b (P66): the client follows the share level", () => {
  it("read gets no changes, no reply, no new mail; reply gets changes and reply; send_as, own and team get all", async () => {
    const l = await import("@/web/lib/mail-level-priv1b");
    const box = (level?: "own" | "send_as" | "reply" | "read" | "team", openable?: boolean) => ({ id: "b", level, openable });
    expect([l.canChangeMail(box("read")), l.canReplyIn(box("read")), l.canSendNewFrom(box("read"))]).toEqual([false, false, false]);
    expect([l.canChangeMail(box("reply")), l.canReplyIn(box("reply")), l.canSendNewFrom(box("reply"))]).toEqual([true, true, false]);
    for (const lv of ["send_as", "own", "team"] as const) expect([l.canChangeMail(box(lv)), l.canReplyIn(box(lv)), l.canSendNewFrom(box(lv))]).toEqual([true, true, true]);
    // A mailbox list row with no level counts as full unless it is not openable; an unknown mailbox gets nothing.
    expect(l.canSendNewFrom(box())).toBe(true);
    expect(l.canChangeMail(box(undefined, false))).toBe(false);
    expect(l.canChangeMail(undefined)).toBe(false);
  });

  it("the composer's From is never a mailbox the person can't send from", async () => {
    const l = await import("@/web/lib/mail-level-priv1b");
    const boxes = [{ id: "pread", level: "read" as const }, { id: "preply", level: "reply" as const }, { id: "team", level: "team" as const }, { id: "psend", level: "send_as" as const }];
    // New mail from a read or reply share opens on a mailbox that can send.
    expect(l.defaultFrom(boxes, { mailboxId: "pread" })).toBe("team");
    expect(l.defaultFrom(boxes, { mailboxId: "preply" })).toBe("team");
    expect(l.fromChoices(boxes, { mailboxId: "preply" }).map((b) => b.id)).toEqual(["team", "psend"]);
    // A reply in the reply share's thread keeps it; a reply in a read share's thread does not.
    expect(l.defaultFrom(boxes, { mailboxId: "preply", inReplyToId: "m1" })).toBe("preply");
    expect(l.fromChoices(boxes, { mailboxId: "preply", inReplyToId: "m1" }).map((b) => b.id)).toEqual(["preply", "team", "psend"]);
    expect(l.defaultFrom(boxes, { mailboxId: "pread", inReplyToId: "m1" })).toBe("team");
    // Legitimate: the person's own choice stays.
    expect(l.defaultFrom(boxes, { mailboxId: "psend" })).toBe("psend");
    // Nothing allowed: no From at all (Send stays off) rather than one that 403s.
    expect(l.defaultFrom([{ id: "pread", level: "read" }], { mailboxId: "pread" })).toBe("");
  });

  it("pickers and the palette offer only mailboxes the person can open; Team pickers only team mailboxes (P23, P24)", async () => {
    const l = await import("@/web/lib/mail-level-priv1b");
    const rows = [{ id: "team", personal: false, openable: true }, { id: "mine", personal: true, openable: true }, { id: "colleague", personal: true, openable: false }, { id: "old" }];
    expect(l.openableOnly(rows).map((r) => r.id)).toEqual(["team", "mine", "old"]);
    expect(l.teamPickable(rows).map((r) => r.id)).toEqual(["team", "old"]);
    expect(l.openableOnly(undefined)).toEqual([]);
  });

  it("a 404 is a mailbox gone; the notice key names the person and workspace", async () => {
    const l = await import("@/web/lib/mail-level-priv1b");
    const { ApiError } = await import("@/web/lib/api");
    expect(l.isGone(new ApiError(404, "not_found", "Not found"))).toBe(true);
    expect(l.isGone(new ApiError(403, "forbidden", "No"))).toBe(false);
    expect(l.isGone(null)).toBe(false);
    expect(l.noticeKey("usr_A", "org_1")).not.toBe(l.noticeKey("usr_B", "org_1"));
    expect(l.noticeKey("usr_A", "org_1")).not.toBe(l.noticeKey("usr_A", "org_2"));
  });
});

describe("PRIV1b (P66): the server answers the client relies on", () => {
  it("a taken back share answers the mailbox list with 404, and the level matches what the server allows", async () => {
    const w = await privacyWorld();
    const list = (c: typeof w.pat.c) => c.get(`/api/mail/messages?mailboxId=${w.boxes.personal}&folder=inbox`);
    const lvl = async (c: typeof w.pat.c) => ((await c.get("/api/mail/overview")).body.mailboxes as { id: string; level?: string }[]).find((m) => m.id === w.boxes.personal)?.level;
    expect((await list(w.dRead.c)).status).toBe(200);
    expect(await lvl(w.dRead.c)).toBe("read");
    // A read share really changes nothing (the client hides Archive for it).
    await w.dRead.c.post("/api/mail/messages/bulk", { ids: [w.msgs.personal], action: "archive" });
    expect((await w.pat.c.get(`/api/mail/messages/${w.msgs.personal}`)).body.message.folder).toBe("inbox");
    expect((await w.pat.c.del(`/api/mailboxes/${w.boxes.personal}/sharing/${w.dRead.id}`)).status).toBe(200);
    expect((await list(w.dRead.c)).status).toBe(404);
    expect(await lvl(w.dRead.c)).toBeUndefined();
    // Legitimate: the owner keeps the list and the level.
    expect((await list(w.pat.c)).status).toBe(200);
    expect(await lvl(w.pat.c)).toBe("own");
  }, 120_000);

  it("an orphan the workspace owner holds is read, not own (it can't be changed or sent from)", async () => {
    const w = await privacyWorld();
    expect((await w.owner.del(`/api/team/members/${w.pat.id}`)).status).toBe(200);
    const boxes = (await w.owner.get("/api/mail/overview")).body.mailboxes as { id: string; level?: string }[];
    expect(boxes.find((m) => m.id === w.boxes.personal)?.level).toBe("read");
    expect(boxes.find((m) => m.id === w.boxes.team)?.level).toBe("team");
    expect((await w.owner.post("/api/mail/drafts", { mailboxId: w.boxes.personal, to: ["a@b.io"], subject: "x", text: "x" })).status).toBe(403);
  }, 120_000);

  it("an admin's mailbox list has a colleague's personal mailbox only as a reduced row with openable false", async () => {
    const w = await privacyWorld();
    const rows = (await w.admin.c.get("/api/mailboxes")).body.mailboxes as { id: string; openable: boolean; usedBytes?: number; personal: boolean }[];
    const p = rows.find((m) => m.id === w.boxes.personal)!;
    expect(p).toMatchObject({ openable: false, personal: true });
    expect(p.usedBytes).toBeUndefined();
    expect(rows.find((m) => m.id === w.boxes.team)).toMatchObject({ openable: true, personal: false });
    const memberRows = (await w.member.c.get("/api/mailboxes")).body.mailboxes as { id: string }[];
    expect(memberRows.some((m) => m.id === w.boxes.personal)).toBe(false);
  }, 120_000);
});

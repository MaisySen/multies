import { applyChange, backLabel, patchPage, supportsTriage, triageMode, viewOf } from "@/lib/triage";
import { endpoints } from "@/api/endpoints";
import { SampleTransport } from "@/sample/transport";
import type { AppNotification, NotificationPage } from "@/api/types";
import type { Method, Transport } from "@/api/transport";

const n = (id: string, over: Partial<AppNotification> = {}): AppNotification => ({ id, type: "chat.mention", category: "mention", entityType: "task", entityId: "t1", title: id, read: false, createdAt: "2026-10-26T00:00:00Z", ...over });
const legacy: NotificationPage = { notifications: [n("a"), n("b", { read: true })], unread: 1, counts: {}, hasMore: false };
const modern: NotificationPage = { ...legacy, viewCounts: { inbox: 2, later: 1, done: 0 }, notifications: [n("a", { doneAt: null, snoozedUntil: null }), n("b", { read: true, doneAt: null, snoozedUntil: null })] };

describe("R31 triage fallback", () => {
  it("an older server (no viewCounts) gets the plain list and no Later or Done", () => {
    expect(supportsTriage(legacy)).toBe(false);
    const m = triageMode(legacy, "later");
    expect(m.kind).toBe("legacy");
    if (m.kind === "legacy") expect(m.items.map((x) => x.id)).toEqual(["a", "b"]);
    expect(triageMode(undefined, "inbox").kind).toBe("loading");
  });

  it("a new server shows the view with its counts", () => {
    const m = triageMode(modern, "inbox");
    expect(m.kind).toBe("triage");
    if (m.kind === "triage") { expect(m.items).toHaveLength(2); expect(m.counts).toEqual({ inbox: 2, later: 1, done: 0 }); }
  });

  it("an item's view follows doneAt and snoozedUntil; a passed snooze is back in Inbox", () => {
    const now = Date.parse("2026-10-26T05:00:00Z");
    expect(viewOf({ doneAt: "2026-10-26T01:00:00Z", snoozedUntil: null }, now)).toBe("done");
    expect(viewOf({ doneAt: null, snoozedUntil: "2026-10-27T00:00:00Z" }, now)).toBe("later");
    expect(viewOf({ doneAt: null, snoozedUntil: "2026-10-26T04:00:00Z" }, now)).toBe("inbox");
    expect(viewOf({}, now)).toBe("inbox");
  });

  it("optimistic changes move items between views and keep the counts right", () => {
    const now = new Date("2026-10-26T05:00:00Z");
    const done = patchPage(modern, ["a"], { action: "done" }, now);
    expect(done.viewCounts).toEqual({ inbox: 1, later: 1, done: 1 });
    expect(done.unread).toBe(0);
    expect(triageMode(done, "inbox").kind === "triage" && (triageMode(done, "inbox") as { items: AppNotification[] }).items.map((x) => x.id)).toEqual(["b"]);
    const snoozed = patchPage(modern, ["b"], { action: "snooze", until: "2026-10-27T00:00:00Z" }, now);
    expect(snoozed.viewCounts).toEqual({ inbox: 1, later: 2, done: 0 });
    expect(patchPage(legacy, ["a"], { action: "done" }, now)).toBe(legacy);
    expect(applyChange(n("x", { doneAt: "2026-10-26T01:00:00Z" }), { action: "undone" }).doneAt).toBeNull();
  });

  it("labels a snoozed item with when it comes back", () => {
    expect(backLabel("2026-10-27T21:00:00Z")).toMatch(/^Back /);
    expect(backLabel("nope")).toBe("Snoozed");
  });
});

describe("R31 API contract (exact paths and bodies)", () => {
  const seen: { method: Method; path: string; body?: unknown }[] = [];
  const fake: Transport = { kind: "live", request: async (method: Method, path: string, body?: unknown) => { seen.push({ method, path, body }); return {} as never; } } as unknown as Transport;
  const api = endpoints(fake);
  beforeEach(() => { seen.length = 0; });

  it("calls the triage routes the web helper builds", async () => {
    await api.notifications({ view: "later", limit: 50 });
    await api.notificationDone("ntf_1");
    await api.notificationUndone("ntf_1");
    await api.notificationSnooze("ntf_1", { preset: "tomorrow" });
    await api.notificationSnooze("ntf_1", { until: "2026-10-27T00:00:00.000Z" });
    await api.notificationsDone(["a", "b"]);
    expect(seen).toEqual([
      { method: "GET", path: "/notifications?view=later&limit=50", body: undefined },
      { method: "POST", path: "/notifications/ntf_1/done", body: {} },
      { method: "POST", path: "/notifications/ntf_1/undone", body: {} },
      { method: "POST", path: "/notifications/ntf_1/snooze", body: { preset: "tomorrow" } },
      { method: "POST", path: "/notifications/ntf_1/snooze", body: { until: "2026-10-27T00:00:00.000Z" } },
      { method: "POST", path: "/notifications/done", body: { ids: ["a", "b"] } },
    ]);
  });

  it("mail snooze and run cancel use the existing server routes", async () => {
    await api.snoozeMessage("msg_1", "next_week");
    await api.cancelRun("run_1");
    expect(seen).toEqual([
      { method: "POST", path: "/mail-schedules/snooze", body: { messageId: "msg_1", preset: "next_week" } },
      { method: "POST", path: "/agent-runs/run_1/cancel", body: {} },
    ]);
  });
});

describe("R31 sample workspace speaks the same contract", () => {
  it("moves a notification through Inbox, Later and Done", async () => {
    const api = endpoints(new SampleTransport());
    const inbox = await api.notifications({ view: "inbox" });
    expect(supportsTriage(inbox)).toBe(true);
    const first = inbox.notifications[0];
    const before = inbox.viewCounts!;
    await api.notificationDone(first.id);
    let after = await api.notifications({ view: "inbox" });
    expect(after.viewCounts!.inbox).toBe(before.inbox - 1);
    expect(after.viewCounts!.done).toBe(before.done + 1);
    expect((await api.notifications({ view: "done" })).notifications.map((x) => x.id)).toContain(first.id);
    await api.notificationSnooze(first.id, { preset: "tomorrow" });
    expect((await api.notifications({ view: "later" })).notifications.map((x) => x.id)).toEqual([first.id]);
    await api.notificationUndone(first.id);
    after = await api.notifications({ view: "inbox" });
    expect(after.viewCounts).toEqual({ ...before });
    await expect(api.notificationSnooze(first.id, { until: "2000-01-01T00:00:00Z" })).rejects.toMatchObject({ status: 422 });
  });

  it("snoozes mail out of the inbox and cancels a running run", async () => {
    const t = new SampleTransport();
    const api = endpoints(t);
    const list = await api.messages({ folder: "inbox" });
    const m = list.messages[0];
    await api.snoozeMessage(m.id, "tomorrow");
    expect((await api.messages({ folder: "inbox" })).messages.map((x) => x.id)).not.toContain(m.id);
    const runs = (await api.runs()).runs;
    const live = runs.find((r) => r.status === "running" || r.status === "queued");
    if (live) {
      const r = await api.cancelRun(live.id);
      expect(r.run.status).toBe("cancelled");
    }
    const done = runs.find((r) => r.status === "succeeded" || r.status === "failed");
    if (done) await expect(api.cancelRun(done.id)).rejects.toMatchObject({ status: 409 });
  });
});

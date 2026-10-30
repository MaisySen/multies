import { memoryKV } from "@/lib/kv";
import { ApiError, NETWORK_ERROR } from "@/api/errors";
import { CommandQueue, QUEUE_KEY, isRejection, swapId, waitingLabel, type Command } from "@/lib/command-queue";
import { isTempId, pendingTask, tempId } from "@/lib/pending";

function rig(answer: (c: Command, n: number) => Promise<{ realId?: string } | void>) {
  const store = memoryKV();
  const seen: Command[] = [];
  const q = new CommandQueue(store, async (c) => { seen.push(c); return answer(c, seen.length); });
  return { q, seen, store };
}

describe("R33 offline command queue", () => {
  it("flushes in the order the edits were made", async () => {
    const { q, seen } = rig(async () => {});
    await q.enqueue({ kind: "mail.action", messageId: "m1", action: "archive" });
    await q.enqueue({ kind: "task.update", taskId: "t1", patch: { status: "done" } });
    await q.enqueue({ kind: "task.delete", taskId: "t2" });
    expect(q.size).toBe(3);
    const r = await q.flush();
    expect(r).toMatchObject({ sent: 3, stopped: false, rejected: [] });
    expect(seen.map((c) => c.kind)).toEqual(["mail.action", "task.update", "task.delete"]);
    expect(q.size).toBe(0);
  });

  it("swaps a temp id for the real id in every later command", async () => {
    const temp = tempId();
    const { q, seen } = rig(async (c) => (c.kind === "task.create" ? { realId: "real_9" } : undefined));
    await q.enqueue({ kind: "task.create", tempId: temp, input: { title: "Call Jordan" } });
    await q.enqueue({ kind: "task.update", taskId: temp, patch: { status: "done" } });
    await q.enqueue({ kind: "task.create", tempId: tempId(), input: { title: "Sub", parentId: temp } });
    const r = await q.flush();
    expect(r.ids[temp]).toBe("real_9");
    expect(seen[1]).toMatchObject({ kind: "task.update", taskId: "real_9" });
    expect(seen[2]).toMatchObject({ kind: "task.create", input: { parentId: "real_9" } });
    expect(q.ids.get(temp)).toBe("real_9");
  });

  it("drops a rejected command and the edits that depend on it, then carries on", async () => {
    const temp = tempId();
    const { q, seen } = rig(async (c) => { if (c.kind === "task.create") throw new ApiError(400, "bad_request", "Add a title"); });
    await q.enqueue({ kind: "task.create", tempId: temp, input: { title: "" } });
    await q.enqueue({ kind: "task.update", taskId: temp, patch: { status: "done" } });
    await q.enqueue({ kind: "mail.action", messageId: "m1", action: "read" });
    const r = await q.flush();
    expect(r.rejected.map((x) => x.command.kind)).toEqual(["task.create", "task.update"]);
    expect(r.sent).toBe(1);
    expect(seen.map((c) => c.kind)).toEqual(["task.create", "mail.action"]);
    expect(q.size).toBe(0);
  });

  it("stops at a network error and keeps the rest, saved on the phone", async () => {
    const { q, store } = rig(async (_c, n) => { if (n === 2) throw NETWORK_ERROR(); });
    await q.enqueue({ kind: "mail.action", messageId: "a", action: "archive" });
    await q.enqueue({ kind: "mail.action", messageId: "b", action: "archive" });
    await q.enqueue({ kind: "mail.action", messageId: "c", action: "archive" });
    const r = await q.flush();
    expect(r).toMatchObject({ sent: 1, stopped: true });
    expect(q.size).toBe(2);
    const saved = JSON.parse((await store.get(QUEUE_KEY))!) as Command[];
    expect(saved.map((c) => (c as { messageId: string }).messageId)).toEqual(["b", "c"]);
    // A fresh queue on the same store (the app was closed) picks them up.
    const again = new CommandQueue(store, async () => {});
    await again.load();
    expect(again.size).toBe(2);
  });

  it("tells a refusal from a reason to try later", () => {
    expect(isRejection(new ApiError(400, "x", "x"))).toBe(true);
    expect(isRejection(new ApiError(404, "x", "x"))).toBe(true);
    for (const s of [0, 401, 408, 429, 500, 503]) expect(isRejection(new ApiError(s, "x", "x"))).toBe(false);
    expect(isRejection(new TypeError("x"))).toBe(false);
  });

  it("labels and temp rows", () => {
    expect(waitingLabel(1)).toBe("1 change waiting");
    expect(waitingLabel(3)).toBe("3 changes waiting");
    const t = pendingTask({ title: "Quote" });
    expect(isTempId(t.id)).toBe(true);
    expect(t).toMatchObject({ title: "Quote", status: "todo" });
    expect(swapId({ id: "1", at: 0, kind: "task.delete", taskId: t.id }, t.id, "r1")).toMatchObject({ taskId: "r1" });
  });
});

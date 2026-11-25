/**
 * e2e/suite-r10 (weekly repeat): setting Repeat and then pressing Mark as done sent two task edits at once; when the
 * second reached the server first, the task was done before it repeated and no next task was made. Task edits now go
 * one at a time per task (src/web/lib/key-queue.ts).
 */
import { describe, it, expect } from "vitest";
import { inOrder, queuedKeys } from "@/web/lib/key-queue";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("inOrder: one at a time per key", () => {
  it("a second edit to the same task starts only after the first has finished", async () => {
    const log: string[] = [];
    const slow = inOrder("tsk_1", async () => { log.push("repeat start"); await wait(30); log.push("repeat end"); return 1; });
    const fast = inOrder("tsk_1", async () => { log.push("done start"); return 2; });
    expect(await Promise.all([slow, fast])).toEqual([1, 2]);
    expect(log).toEqual(["repeat start", "repeat end", "done start"]);
  });

  it("other tasks are not held up, a failure does not stop the next edit, and nothing is left queued", async () => {
    const log: string[] = [];
    const a = inOrder("tsk_a", async () => { await wait(30); log.push("a"); });
    const b = inOrder("tsk_b", async () => { log.push("b"); });
    await Promise.all([a, b]);
    expect(log).toEqual(["b", "a"]);
    const bad = inOrder("tsk_c", async () => { throw new Error("offline"); });
    const after = inOrder("tsk_c", async () => "saved");
    await expect(bad).rejects.toThrow("offline");
    expect(await after).toBe("saved");
    await wait(0);
    expect(queuedKeys()).toBe(0);
  });
});

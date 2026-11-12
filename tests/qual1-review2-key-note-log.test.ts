/**
 * QUAL1 second review of PR 20 ("no silent failures"): recordKeyProblem (services/ai/keys.ts) wraps its write in
 * `catch { }` with no log, so when the ai_keys write fails (D1 busy, the daily write budget shed, migration 0170 not yet
 * applied: "no such column: problem") the refusal is never noted, Settings keeps showing "Connected", and nothing
 * anywhere says why. The comment says a failed note must not hide the answer; it can still be logged.
 */
import { describe, it, expect, vi } from "vitest";
import { recordKeyProblem } from "@/server/services/ai/keys";

describe("QUAL1 second review: a failed key-problem write is at least logged", () => {
  it("logs when the ai_keys update throws", async () => {
    const warn = vi.fn(), error = vi.fn();
    const deps = {
      now: () => new Date("2026-11-12T00:00:00Z"),
      log: { info: vi.fn(), warn, error },
      db: { update: () => ({ set: () => ({ where: async () => { throw new Error("D1_ERROR: no such column: problem"); } }) }) },
    };
    await recordKeyProblem(deps as never, "org_1", new Date(0), "key_refused");
    const calls = [...warn.mock.calls, ...error.mock.calls].map((c) => String(c[0]));
    expect(calls, "the failed write is swallowed with no log line at all").toContainEqual(expect.stringMatching(/key_problem/));
    expect(calls.some((m) => /fail|error/.test(m)), "a log line names the failure (not only the ai.key_problem warning for a successful write)").toBe(true);
  });
});

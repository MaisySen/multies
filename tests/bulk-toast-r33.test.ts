import { describe, it, expect } from "vitest";
import { startToast, toastReduce, toastView, UNDONE_MS, type ToastEvent, type ToastState } from "@/web/lib/bulk-toast-r33";
import { UNDO_MS } from "@/web/lib/mail-selection";

/** R33: the bulk mail toast: Cancel (on its way), Undo (confirmed, 8 s), Undoing..., Undone (1.5 s), Retry on failure. */
const run = (s: ToastState, ...events: ToastEvent[]) => events.reduce(toastReduce, s);
const view = (s: ToastState) => toastView(s, UNDO_MS);

describe("bulk toast states", () => {
  it("pending shows Cancel and stays; confirmed shows Undo for 8 s; Undo goes Undoing then Undone for 1.5 s, then closes", () => {
    const s0 = startToast("archive", 3, true);
    expect(view(s0)).toEqual({ text: "Archiving 3 conversations", button: "Cancel", autoClose: null, tone: "info" });
    const s1 = run(s0, { type: "confirmed" });
    expect(view(s1)).toEqual({ text: "Archived 3 conversations", button: "Undo", autoClose: 8000, tone: "success" });
    const s2 = run(s1, { type: "undo" });
    expect(view(s2)).toMatchObject({ text: "Undoing...", button: null, autoClose: null });
    const s3 = run(s2, { type: "undone" });
    expect(view(s3)).toMatchObject({ text: "Undone", button: null, autoClose: UNDONE_MS });
    expect(UNDONE_MS).toBe(1500);
    expect(run(s3, { type: "expire" }).phase).toBe("closed");
  });

  it("Cancel before the server answers is remembered, then undone once it confirms", () => {
    const s = run(startToast("trash", 2, true), { type: "undo" });
    expect(s.phase).toBe("pending");
    expect(s.cancelAsked).toBe(true);
    const c = run(s, { type: "confirmed" }, { type: "undo" });
    expect(c.phase).toBe("undoing");
    expect(run(c, { type: "undone" }).phase).toBe("undone");
  });

  it("a select all job shows progress with thousands separators and Undo while it runs", () => {
    const s = run(startToast("archive", 3100, true), { type: "progress", done: 1240, total: 3100 });
    expect(view(s)).toEqual({ text: "Archiving 1,240 of 3,100", button: "Undo", autoClose: null, tone: "info" });
    expect(run(s, { type: "undo" }).phase).toBe("undoing");
    const done = run(s, { type: "progress", done: 2140, total: 3100 }, { type: "confirmed", count: 3100 });
    expect(view(done).text).toBe("Archived 3,100 conversations");
  });

  it("failure says so with Retry; Retry goes back to pending (or back to Undoing for a failed undo)", () => {
    const f = run(startToast("read", 1, true), { type: "failed" });
    expect(view(f)).toMatchObject({ text: "Couldn't mark 1 conversation. Nothing changed.", button: "Retry", tone: "error", autoClose: null });
    expect(run(f, { type: "retry" }).phase).toBe("pending");
    const uf = run(startToast("archive", 4, true), { type: "confirmed" }, { type: "undo" }, { type: "failed" });
    expect(view(uf)).toMatchObject({ text: "Couldn't undo that. Check your connection and try again.", button: "Retry" });
    expect(run(uf, { type: "retry" }).phase).toBe("undoing");
  });

  it("an action with no undo (delete forever) never offers Cancel or Undo; stray events change nothing", () => {
    const s = startToast("delete", 2, false);
    expect(view(s).button).toBeNull();
    const c = run(s, { type: "confirmed" });
    expect(view(c)).toMatchObject({ text: "Deleted 2 conversations forever", button: null });
    expect(run(c, { type: "undo" })).toBe(c);
    expect(run(c, { type: "undone" })).toBe(c);
    expect(run(startToast("snooze", 1, true, "until tomorrow"), { type: "confirmed" }).phase).toBe("applied");
    expect(view(run(startToast("snooze", 1, true, "until tomorrow"), { type: "confirmed" })).text).toBe("Snoozed 1 conversation until tomorrow");
  });
});

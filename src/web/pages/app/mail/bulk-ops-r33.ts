/**
 * R33: runs a bulk mail action with the toast states of lib/bulk-toast-r33.ts. Two kinds:
 *  - "ids": the selection is in the list (POST /api/mail/messages/bulk, Undo runs the inverse calls);
 *  - "job": "select all" past what is loaded, as ONE server job (POST /api/mail/bulk-jobs, repeated with the same
 *    body until done, progress in the toast; Undo is POST /bulk-jobs/:id/undo then /step until reverted).
 * Cancel shows while the request is on its way; pressing it undoes the action the moment the server confirms.
 * Undo stays for 8 s after it is confirmed (Cmd/Ctrl+Z too), "Undoing..." until the server is done, then "Undone"
 * for 1.5 s. A failure says so and offers Retry.
 */
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import type { BulkCall } from "@/web/lib/mail-selection";
import { startToast, toastReduce, toastView, UNDONE_MS, type ToastEvent, type ToastState } from "@/web/lib/bulk-toast-r33";
import { randomId } from "@/shared/random";

export interface JobBody {
  client_job_id: string; action: "read" | "unread" | "star" | "unstar" | "archive" | "inbox" | "spam" | "trash" | "snooze" | "move";
  scope: { mailboxId: string; folder?: string; remote?: string; q?: string; split?: string; /** R45: mail dated before this time only. */ before?: string };
  exclude_ids: string[]; max_received_at: string;
  /** R34: move destination; snooze time. */
  to?: string; when?: { preset?: "later_today" | "tomorrow" | "next_week"; at?: string; local?: string };
}
interface JobView { id: string; status: "running" | "done" | "reverting" | "reverted" | "failed"; done: number; total: number; undoable: boolean }
export type BulkOp =
  | { kind: "ids"; call: BulkCall; plan: BulkCall[] | null; apply: (c: BulkCall) => Promise<unknown>; folderLabel?: string }
  | { kind: "job"; body: JobBody; count: number; onSettled: () => void };

interface Live { key: string; state: ToastState; op: BulkOp; jobId?: string; timer?: ReturnType<typeof setTimeout> }

/** A client job id: letters and digits, made here so a retried request continues the same job. */
export const newJobId = () => `job_${Date.now().toString(36)}_${randomId(8)}`;

export function useBulkOps(undoMs: number) {
  const live = useRef<Live | null>(null);
  useEffect(() => () => { if (live.current?.timer) clearTimeout(live.current.timer); }, []);

  const paint = useCallback((l: Live) => {
    const v = toastView(l.state, undoMs);
    if (l.timer) clearTimeout(l.timer);
    l.timer = undefined;
    if (l.state.phase === "closed") { toast.dismiss(l.key); if (live.current === l) live.current = null; return; }
    const action = v.button ? { label: v.button, onClick: (e: { preventDefault?: () => void }) => { e?.preventDefault?.(); press(l); } } : undefined;
    const opts = { id: l.key, duration: v.autoClose ?? Number.POSITIVE_INFINITY, action, className: "bulk-toast", dismissible: v.button !== "Cancel" };
    if (v.tone === "error") toast.error(v.text, opts);
    else if (v.tone === "success") toast.success(v.text, opts);
    else toast.loading(v.text, opts);
    if (v.autoClose) l.timer = setTimeout(() => send(l, { type: "expire" }), v.autoClose);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoMs]);

  const send = useCallback((l: Live, e: ToastEvent) => {
    const next = toastReduce(l.state, e);
    if (next === l.state) return false;
    l.state = next;
    paint(l);
    return true;
  }, [paint]);

  const undo = async (l: Live) => {
    if (l.state.phase !== "undoing") return;
    try {
      if (l.op.kind === "ids") {
        for (const c of l.op.plan ?? []) await l.op.apply(c);
      } else {
        let r = await api.post<JobView>(`/mail/bulk-jobs/${l.jobId}/undo`);
        while (r.status === "reverting") r = await api.post<JobView>(`/mail/bulk-jobs/${l.jobId}/step`);
        l.op.onSettled();
      }
      send(l, { type: "undone" });
      l.timer = setTimeout(() => send(l, { type: "expire" }), UNDONE_MS);
    } catch {
      send(l, { type: "failed" });
    }
  };

  const forward = async (l: Live) => {
    try {
      if (l.op.kind === "ids") {
        await l.op.apply(l.op.call);
        send(l, { type: "confirmed" });
      } else {
        let r = await api.post<JobView>("/mail/bulk-jobs", l.op.body);
        l.jobId = r.id;
        while (r.status === "running" && (l.state.phase === "pending" || l.state.phase === "running")) {
          if (l.state.cancelAsked) break;
          send(l, { type: "progress", done: r.done, total: r.total });
          r = await api.post<JobView>("/mail/bulk-jobs", l.op.body);
        }
        if (r.status === "done" || l.state.cancelAsked) send(l, { type: "confirmed", count: r.total, ...(r.status === "done" && !l.state.cancelAsked ? { undoable: r.undoable } : {}) });
        if (r.status === "done") l.op.onSettled();
      }
    } catch {
      send(l, { type: "failed" });
      return;
    }
    // Cancel pressed while the request was on its way: put it back now.
    if (l.state.cancelAsked || (l.state.phase as string) === "undoing") {
      if (l.state.phase === "applied") send(l, { type: "undo" });
      void undo(l);
    }
  };

  /** The toast's button: Cancel, Undo or Retry. */
  const press = (l: Live) => {
    const was = l.state.phase;
    if (was === "failed") { send(l, { type: "retry" }); if ((l.state.phase as string) === "undoing") void undo(l); else void forward(l); return; }
    if (!send(l, { type: "undo" })) return;
    if (l.state.phase === "undoing") void undo(l);
  };

  /** Starts a bulk action; returns nothing, the toast tells the story. */
  const run = useCallback((op: BulkOp, label: { action: BulkCall["action"]; count: number; folderLabel?: string }) => {
    const prev = live.current;
    if (prev?.timer) clearTimeout(prev.timer);
    // R35: every job can be undone, a move to a synced folder too (it moves back); the job's answer says if nothing changed.
    const undoable = op.kind === "job" ? true : !!op.plan?.length;
    const l: Live = { key: `bulk-${Date.now().toString(36)}`, state: startToast(label.action, label.count, undoable, label.folderLabel), op };
    live.current = l;
    paint(l);
    void forward(l);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paint]);

  /** Cmd/Ctrl+Z: undoes (or cancels) the latest bulk action while its toast offers it. */
  const undoLatest = useCallback(() => {
    const l = live.current;
    if (!l || !["pending", "running", "applied"].includes(l.state.phase) || !l.state.undoable) return false;
    press(l);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { run, undoLatest };
}

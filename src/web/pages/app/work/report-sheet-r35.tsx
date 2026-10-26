/**
 * R35 (Apple 1.2): report a chat message or a person, and block people. One hook for every chat surface
 * (channels, threads, DMs and meeting chat): useModeration() gives the actions, the set of blocked people
 * (so live events from them are dropped on this side too) and the sheet and dialogs to render once.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCheck, IconFlag } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Textarea } from "@/web/components/ui/input";
import { useDialogs } from "@/web/components/ui/confirm";

export const REPORT_REASONS = [
  { id: "spam", label: "Spam or scam" },
  { id: "harassment", label: "Harassment or bullying" },
  { id: "hate", label: "Hate speech" },
  { id: "sexual", label: "Sexual content" },
  { id: "violence", label: "Violence or threats" },
  { id: "self_harm", label: "Self harm" },
  { id: "other", label: "Something else" },
] as const;
export type ReportReasonId = (typeof REPORT_REASONS)[number]["id"];
export interface Blocked { userId: string; name: string; avatarUrl: string | null; createdAt: string }
export interface ReportTarget { targetType: "message" | "user"; messageId?: string; userId: string; name: string; context?: "chat" | "meeting" | "dm" }

export const BLOCK_CONFIRM_TEXT = "You won't see their messages and they can't message you. They won't be told.";

/** The people I blocked (GET /api/blocks), shared by every chat surface. */
export function useBlocks() {
  return useQuery({ queryKey: ["blocks"], queryFn: async () => (await api.get<{ blocks: Blocked[] }>("/blocks")).blocks, staleTime: 60_000 });
}

export function useModeration() {
  const qc = useQueryClient();
  const blocks = useBlocks();
  const blocked = useMemo(() => new Set((blocks.data ?? []).map((b) => b.userId)), [blocks.data]);
  const { confirm, dialogs } = useDialogs();
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const refreshChat = async () => { await qc.invalidateQueries({ queryKey: ["blocks"] }); await qc.invalidateQueries({ queryKey: ["chat"] }); };

  const block = async (userId: string, name: string) => {
    const ok = await confirm({ title: `Block ${name}?`, description: BLOCK_CONFIRM_TEXT, confirmLabel: "Block", tone: "danger" });
    if (!ok) return false;
    try { await api.post("/blocks", { userId }); toast.success(`${name} is blocked`); await refreshChat(); return true; }
    catch (e) { showError(e as Error); return false; }
  };
  const unblock = async (userId: string, name: string) => {
    try { await api.del(`/blocks/${userId}`); toast.success(`${name} is unblocked`); await refreshChat(); }
    catch (e) { showError(e as Error); }
  };
  const sheet = (
    <>
      <ReportSheet target={target} onClose={() => setTarget(null)} isBlocked={!!target && blocked.has(target.userId)} onBlock={(t) => { setTarget(null); void block(t.userId, t.name); }} />
      {dialogs}
    </>
  );
  return { blocked, block, unblock, report: setTarget, sheet };
}

/** The report sheet: a grouped list of reasons with radio rows, an optional note, Send; then a calm thank you with an offer to block. */
export function ReportSheet({ target, onClose, onBlock, isBlocked }: { target: ReportTarget | null; onClose: () => void; onBlock: (t: ReportTarget) => void; isBlocked: boolean }) {
  const [reason, setReason] = useState<ReportReasonId | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const close = () => { setReason(null); setNote(""); setSent(false); onClose(); };
  const send = async () => {
    if (!target || !reason) return;
    setBusy(true);
    try {
      await api.post("/reports", { targetType: target.targetType, messageId: target.messageId, userId: target.targetType === "user" ? target.userId : undefined, context: target.context, reason, note: note.trim() || undefined });
      setSent(true);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  if (!target) return null;
  const what = target.targetType === "message" ? "message" : target.name;
  return (
    <Dialog open onClose={close} title={sent ? "Report sent" : `Report ${target.targetType === "message" ? "message" : target.name}`}
      description={sent ? undefined : `Tell us what is wrong with this ${target.targetType === "message" ? `message from ${target.name}` : "person"}. ${target.name} won't know who reported it.`}>
      <div className="px-6 pb-6 pt-4" data-testid="report-sheet">
        {sent ? (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-brand"><IconCheck className="h-6 w-6" aria-hidden /></div>
            <p className="text-[15px] text-fg">Thanks. Our team reviews reports within 24 hours.</p>
            {!isBlocked && <p className="text-[13.5px] text-muted">You can also block {target.name}, so you won't see their messages and they can't message you.</p>}
            <div className="flex flex-col gap-2">
              {!isBlocked && <Button variant="danger" onClick={() => onBlock(target)} data-testid="report-block">Block {target.name}</Button>}
              <Button variant="ghost" onClick={close}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="space-y-4">
            <fieldset>
              <legend className="mb-2 text-[12px] font-medium uppercase tracking-wide text-subtle">Why are you reporting this {what === "message" ? "message" : "person"}?</legend>
              <ul className="overflow-hidden rounded-xl border border-line bg-surface" role="radiogroup">
                {REPORT_REASONS.map((r, i) => (
                  <li key={r.id} className={cn(i > 0 && "border-t border-line")}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 px-4 py-2.5 text-[15px] hover:bg-hover active:bg-hover">
                      <input type="radio" name="report-reason" value={r.id} checked={reason === r.id} onChange={() => setReason(r.id)} className="peer sr-only" />
                      <span className="flex-1">{r.label}</span>
                      <span aria-hidden className={cn("flex h-5 w-5 items-center justify-center rounded-full border transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-brand", reason === r.id ? "border-brand bg-brand text-brand-fg" : "border-line-strong")}>
                        {reason === r.id && <IconCheck className="h-3 w-3" />}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-fg">Anything else? <span className="font-normal text-subtle">(optional)</span></span>
              <Textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} rows={3} maxLength={500} placeholder="Add details that help our team" aria-label="Note" />
              <span className="mt-1 block text-right text-[11.5px] text-subtle">{note.length}/500</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={close}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={!reason} data-testid="report-send"><IconFlag className="h-4 w-4" aria-hidden />Send report</Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}

/** The quiet row in a conversation: shown once, no count. */
export function BlockedHiddenRow() {
  return <li className="py-2 text-center text-[12.5px] text-subtle" data-testid="blocked-hidden-row">Messages from people you blocked are hidden</li>;
}

/** Settings, Privacy: the people I blocked, with Unblock. */
export function BlockedPeople() {
  const { data, isLoading } = useBlocks();
  const { unblock, sheet: sheetless } = useModeration();
  return (
    <div className="max-w-xl space-y-2" data-testid="blocked-people">
      {isLoading ? null : !data?.length ? <p className="rounded-xl border border-line px-4 py-3 text-[13.5px] text-subtle">You haven't blocked anyone.</p> : (
        <ul className="overflow-hidden rounded-xl border border-line bg-surface">
          {data.map((b, i) => (
            <li key={b.userId} className={cn("flex items-center gap-3 px-4 py-2.5", i > 0 && "border-t border-line")}>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-fill text-[12px] font-semibold text-muted" aria-hidden>{b.name.slice(0, 1).toUpperCase()}</span>
              <span className="flex-1 truncate text-[14px]">{b.name}</span>
              <Button variant="ghost" size="sm" onClick={() => void unblock(b.userId, b.name)}>Unblock</Button>
            </li>
          ))}
        </ul>
      )}
      {sheetless}
    </div>
  );
}

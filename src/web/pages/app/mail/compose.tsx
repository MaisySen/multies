import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Info, Minus, Send, Trash2, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { api, ApiError } from "@/web/lib/api";
import type { Mailbox, MailboxOverview } from "@/web/lib/types";
import { Button } from "@/web/components/ui/button";
import { Kbd } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { holdMessage, reopenDraft, useUndoSeconds } from "@/web/lib/undo-send";
import { SavedRepliesButton, useSnippetShortcut } from "./saved-replies";
import { AlsoReplying, useThreadPresence } from "@/web/lib/thread-presence";
import { parseUndoSeconds, UNDO_SEND_CHOICES } from "@/shared/undo-send";
import { shouldAskForSubject, SUBJECT_PROMPT } from "@/web/lib/subject-prompt";
import { zonedDateTime } from "@/web/lib/format";
import { RemindSelect, SendLaterMenu, type When } from "./schedules";

export interface ComposeDraft {
  mailboxId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  inReplyToId?: string;
  draftId?: string;
  /** Round 22: the thread a reply belongs to, for live presence ("Maya is also replying"). */
  threadId?: string;
}

type SendResult = { messageId?: string; internal: string[]; external: { address: string; status: string; detail?: string }[] };

/** The outcome toast after a held message has been posted. */
function reportSent(r: SendResult) {
  const failed = r.external.filter((e) => e.status === "failed");
  const queued = r.external.filter((e) => e.status === "queued");
  if (failed.length) toast.error(`Couldn't deliver to ${failed.map((f) => f.address).join(", ")}`, { description: failed[0].detail });
  else if (queued.length) {
    const held = queued.some((q) => q.detail?.startsWith("Held:"));
    const n = `${queued.length} outside recipient${queued.length > 1 ? "s" : ""}`;
    toast.warning("Saved to Sent, not delivered outside yet", {
      duration: 10000,
      description: `${r.internal.length ? `Delivered inside Multies to ${r.internal.length}. ` : ""}${held
        ? `${n} held: verify this domain with the email provider to send outside Multies.`
        : `${n} queued: outside delivery starts once an email provider is connected.`}`,
    });
  }
  else toast.success("Message sent");
}

const splitAddrs = (s?: string) => (s ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export function Compose({ initial, mailboxes, onClose }: { initial: ComposeDraft; mailboxes: (Mailbox | MailboxOverview)[]; onClose: () => void }) {
  const [d, setD] = useState(initial);
  const [showCc, setShowCc] = useState(!!(initial.cc || initial.bcc));
  const [minimized, setMinimized] = useState(false);
  const qc = useQueryClient();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [askedSubject, setAskedSubject] = useState(false);
  useEffect(() => { (initial.to ? bodyRef : toRef).current?.focus(); if (initial.to) bodyRef.current?.setSelectionRange(0, 0); }, [initial.to]);
  const set = (k: keyof ComposeDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setD((x) => ({ ...x, [k]: e.target.value }));
  const dirty = d.to !== initial.to || d.subject !== initial.subject || d.text !== initial.text;

  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"] });
  const [undoSeconds, setUndoSeconds] = useUndoSeconds();
  // Round 20: "remind me if no reply" (days, 0 is off) and send later, both through the same hold as Send.
  const [remindDays, setRemindDays] = useState(0);
  // Send holds the message in the browser for a few seconds (Undo send), then posts it.
  // Compose closes at once; the hold lives outside this component, so it keeps counting after it unmounts.
  const send = (anyway = false, later?: When) => {
    if (!d.to.trim()) { toRef.current?.focus(); return; }
    // A gentle nudge, once: Send again (or "Send anyway") sends it without a subject.
    if (!anyway && shouldAskForSubject(d.subject, askedSubject)) { setAskedSubject(true); return; }
    const snapshot = d;
    const to = [...splitAddrs(d.to), ...splitAddrs(d.cc), ...splitAddrs(d.bcc)];
    // One key per held message: a retried post can never deliver twice.
    const key = `send_${crypto.randomUUID()}`;
    const message = {
      mailboxId: snapshot.mailboxId, to: splitAddrs(snapshot.to), cc: splitAddrs(snapshot.cc), bcc: splitAddrs(snapshot.bcc),
      subject: snapshot.subject, text: snapshot.text, inReplyToId: snapshot.inReplyToId, draftId: snapshot.draftId,
    };
    const remind = remindDays;
    if (later) {
      // Send later: the same hold (Undo still works), then the message waits in Scheduled.
      holdMessage<{ dueAt: string }>({
        seconds: undoSeconds,
        to,
        send: () => api.post<{ dueAt: string }>("/mail-schedules/send", { message, ...later, ...(remind ? { remindDays: remind } : {}) }),
        onSent: (r) => { void qc.invalidateQueries({ queryKey: ["mail"] }); toast.success(`Scheduled for ${zonedDateTime(r.dueAt)}`, { description: "Find it in Scheduled to edit or cancel it." }); },
        onError: (e) => { toast.error(e instanceof ApiError ? e.message : "Couldn't schedule it.", { description: "Your message is back in Compose." }); reopenDraft(snapshot, "failed"); },
        onUndo: () => reopenDraft(snapshot, "undo"),
      });
      onClose();
      return;
    }
    holdMessage({
      seconds: undoSeconds,
      to,
      send: () => api.post<SendResult>("/mail/send", message, { idempotencyKey: key }),
      onSent: (r) => {
        void qc.invalidateQueries({ queryKey: ["mail"] });
        void qc.invalidateQueries({ queryKey: ["dashboard"] });
        reportSent(r);
        if (remind && r.messageId) {
          void api.post("/mail-schedules/remind", { messageId: r.messageId, days: remind })
            .then(() => toast.success(`We'll bring it back if nobody replies in ${remind} day${remind > 1 ? "s" : ""}`))
            .catch((e: Error) => showError(e));
        }
      },
      onError: (e) => {
        toast.error(e instanceof ApiError ? e.message : "Couldn't send.", { description: "Your message is back in Compose." });
        reopenDraft(snapshot, "failed");
      },
      onUndo: () => reopenDraft(snapshot, "undo"),
    });
    onClose();
  };
  const saveDraft = useMutation({
    mutationFn: () => api.post("/mail/drafts", { id: d.draftId, mailboxId: d.mailboxId, to: splitAddrs(d.to), cc: splitAddrs(d.cc), bcc: splitAddrs(d.bcc), subject: d.subject, text: d.text, inReplyToId: d.inReplyToId }),
    onSuccess: () => { refresh(); toast.success("Draft saved"); onClose(); },
    onError: (e) => showError(e),
  });
  // Round 22: while a reply is open, teammates in the thread see "replying".
  const presence = useThreadPresence(d.threadId, "replying");
  const close = () => (dirty && (d.to || d.text.trim() || d.subject) ? saveDraft.mutate() : onClose());
  // Round 22: saved replies go in at the cursor; the subject fills only when empty.
  const applySnippet = (next: { subject: string; text: string }, cursor: number) => {
    setD((x) => ({ ...x, ...next }));
    requestAnimationFrame(() => { bodyRef.current?.focus(); bodyRef.current?.setSelectionRange(cursor, cursor); });
  };
  const snippetKeys = useSnippetShortcut(d, bodyRef, applySnippet);

  return (
    <div role="dialog" aria-label="New message" className={cn(
      "fixed z-50 flex flex-col border border-line-strong bg-elevated shadow-pop animate-pop-in",
      "inset-0 sm:inset-auto sm:bottom-0 sm:right-6 sm:w-[560px] sm:rounded-t-xl",
      minimized ? "sm:h-12" : "sm:h-[min(620px,85dvh)]",
    )}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); }
        if (e.key === "Escape") { e.stopPropagation(); close(); }
      }}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
        <span className="truncate text-sm font-medium">{d.subject || (d.inReplyToId ? "Reply" : "New message")}</span>
        <div className="flex items-center">
          <button className="hidden rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg sm:block" onClick={() => setMinimized((m) => !m)} aria-label={minimized ? "Expand" : "Minimize"}><Minus className="h-4 w-4" /></button>
          <button className="inline-flex items-center justify-center rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg max-sm:-mr-2 max-sm:h-10 max-sm:w-10" onClick={close} aria-label="Close and save draft"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {!minimized && (
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <Row label="From">
            <select value={d.mailboxId} onChange={set("mailboxId")} className="h-9 w-full bg-transparent text-sm outline-none" aria-label="From">
              {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.displayName} &lt;{m.address}&gt;</option>)}
            </select>
          </Row>
          <Row label="To">
            <input ref={toRef} value={d.to} onChange={set("to")} className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-subtle" placeholder="name@example.com" aria-label="To" autoComplete="off" spellCheck={false} />
            {!showCc && <button type="button" className="shrink-0 text-xs text-muted hover:text-fg" onClick={() => setShowCc(true)}>Cc Bcc</button>}
          </Row>
          {showCc && <>
            <Row label="Cc"><input value={d.cc ?? ""} onChange={set("cc")} className="h-9 w-full bg-transparent text-sm outline-none" aria-label="Cc" spellCheck={false} /></Row>
            <Row label="Bcc"><input value={d.bcc ?? ""} onChange={set("bcc")} className="h-9 w-full bg-transparent text-sm outline-none" aria-label="Bcc" spellCheck={false} /></Row>
          </>}
          <Row label="Subject"><input ref={subjectRef} value={d.subject} onChange={set("subject")} className="h-9 w-full bg-transparent text-sm font-medium outline-none" aria-label="Subject" /></Row>
          <textarea ref={bodyRef} value={d.text} onChange={set("text")} onKeyDown={snippetKeys} aria-label="Message" className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-[14.5px] leading-relaxed outline-none placeholder:text-subtle" placeholder="Write your message…" />
          {askedSubject && !d.subject.trim() && (
            <div role="status" data-testid="subject-prompt" className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-[#0071E3]/[0.06] px-4 py-2 text-[13px]">
              <Info className="h-4 w-4 shrink-0 text-[#0071E3]" aria-hidden />
              <span className="min-w-0 flex-1">{SUBJECT_PROMPT}</span>
              <button type="button" className="rounded-md px-2 py-1 font-medium text-[#0071E3] hover:bg-hover" onClick={() => subjectRef.current?.focus()}>Add subject</button>
              <button type="button" className="rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-fg" onClick={() => send(true)}>Send anyway</button>
            </div>
          )}
          <AlsoReplying people={presence.people} />
          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {/* R25 wave 2: on a 390 px phone the row wraps instead of pushing saved replies and Discard off the screen. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
              <Button type="submit" disabled={!d.to.trim()}><Send className="h-4 w-4" />Send</Button>
              <SendLaterMenu disabled={!d.to.trim()} onPick={(when) => send(true, when)} />
              <span className="hidden items-center gap-1 text-[11px] text-subtle sm:flex"><Kbd>⌘</Kbd><Kbd>↵</Kbd></span>
              <label className="ml-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted hover:bg-hover" title="How long you have to undo after pressing Send">
                <Undo2 className="h-3.5 w-3.5" aria-hidden />
                <select value={undoSeconds} onChange={(e) => setUndoSeconds(parseUndoSeconds(e.target.value))} className="cursor-pointer bg-transparent outline-none" aria-label="Undo send window">
                  {UNDO_SEND_CHOICES.map((n) => <option key={n} value={n}>{n} s</option>)}
                </select>
              </label>
              <RemindSelect value={remindDays} onChange={setRemindDays} />
              <SavedRepliesButton draft={d} bodyRef={bodyRef} onApply={applySnippet} />
            </div>
            <button type="button" onClick={onClose} className="inline-flex shrink-0 items-center justify-center rounded-md p-2 text-muted hover:bg-hover hover:text-bad max-sm:h-10 max-sm:w-10" aria-label="Discard"><Trash2 className="h-4 w-4" /></button>
          </div>
        </form>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line px-4">
      <span className="w-14 shrink-0 text-[13px] text-subtle">{label}</span>
      {children}
    </div>
  );
}

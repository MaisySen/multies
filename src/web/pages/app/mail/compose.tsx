import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Minus, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import type { Mailbox, MailboxOverview } from "@/web/lib/types";
import { Button } from "@/web/components/ui/button";
import { Kbd } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";

export interface ComposeDraft {
  mailboxId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  inReplyToId?: string;
  draftId?: string;
}

const splitAddrs = (s?: string) => (s ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export function Compose({ initial, mailboxes, onClose }: { initial: ComposeDraft; mailboxes: (Mailbox | MailboxOverview)[]; onClose: () => void }) {
  const [d, setD] = useState(initial);
  const [showCc, setShowCc] = useState(!!(initial.cc || initial.bcc));
  const [minimized, setMinimized] = useState(false);
  const qc = useQueryClient();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  useEffect(() => { (initial.to ? bodyRef : toRef).current?.focus(); if (initial.to) bodyRef.current?.setSelectionRange(0, 0); }, [initial.to]);
  const set = (k: keyof ComposeDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setD((x) => ({ ...x, [k]: e.target.value }));
  const dirty = d.to !== initial.to || d.subject !== initial.subject || d.text !== initial.text;

  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"] });
  const send = useMutation({
    mutationFn: () => api.post<{ internal: string[]; external: { address: string; status: string; detail?: string }[] }>("/mail/send", {
      mailboxId: d.mailboxId, to: splitAddrs(d.to), cc: splitAddrs(d.cc), bcc: splitAddrs(d.bcc), subject: d.subject, text: d.text, inReplyToId: d.inReplyToId, draftId: d.draftId,
    }),
    onSuccess: (r) => {
      refresh();
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      const failed = r.external.filter((e) => e.status === "failed");
      const queued = r.external.filter((e) => e.status === "queued");
      if (failed.length) toast.error(`Couldn't deliver to ${failed.map((f) => f.address).join(", ")}`, { description: failed[0].detail });
      else if (queued.length) toast.success("Message saved to Sent", { description: `Delivered inside MyMail${r.internal.length ? ` to ${r.internal.length}` : ""}. External delivery needs an email provider key — ${queued.length} recipient${queued.length > 1 ? "s" : ""} queued.` });
      else toast.success("Message sent");
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't send."),
  });
  const saveDraft = useMutation({
    mutationFn: () => api.post("/mail/drafts", { id: d.draftId, mailboxId: d.mailboxId, to: splitAddrs(d.to), cc: splitAddrs(d.cc), bcc: splitAddrs(d.bcc), subject: d.subject, text: d.text }),
    onSuccess: () => { refresh(); toast.success("Draft saved"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const close = () => (dirty && (d.to || d.text.trim() || d.subject) ? saveDraft.mutate() : onClose());

  return (
    <div role="dialog" aria-label="New message" className={cn(
      "fixed z-50 flex flex-col border border-line-strong bg-elevated shadow-pop animate-pop-in",
      "inset-0 sm:inset-auto sm:bottom-0 sm:right-6 sm:w-[560px] sm:rounded-t-xl",
      minimized ? "sm:h-12" : "sm:h-[min(620px,85dvh)]",
    )}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send.mutate(); }
        if (e.key === "Escape") { e.stopPropagation(); close(); }
      }}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
        <span className="truncate text-sm font-medium">{d.subject || (d.inReplyToId ? "Reply" : "New message")}</span>
        <div className="flex items-center">
          <button className="hidden rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg sm:block" onClick={() => setMinimized((m) => !m)} aria-label={minimized ? "Expand" : "Minimize"}><Minus className="h-4 w-4" /></button>
          <button className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg" onClick={close} aria-label="Close and save draft"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {!minimized && (
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
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
          <Row label="Subject"><input value={d.subject} onChange={set("subject")} className="h-9 w-full bg-transparent text-sm font-medium outline-none" aria-label="Subject" /></Row>
          <textarea ref={bodyRef} value={d.text} onChange={set("text")} aria-label="Message" className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-[14.5px] leading-relaxed outline-none placeholder:text-subtle" placeholder="Write your message…" />
          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <Button type="submit" loading={send.isPending} disabled={!d.to.trim()}><Send className="h-4 w-4" />Send</Button>
              <span className="hidden items-center gap-1 text-[11px] text-subtle sm:flex"><Kbd>⌘</Kbd><Kbd>↵</Kbd></span>
            </div>
            <button type="button" onClick={onClose} className="rounded-md p-2 text-muted hover:bg-hover hover:text-bad" aria-label="Discard"><Trash2 className="h-4 w-4" /></button>
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

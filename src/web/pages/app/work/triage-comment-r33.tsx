/**
 * Round 33: the one line comment under a Triage item. A or D opens it; Enter (or Cmd+Enter)
 * accepts or declines with the comment in one request, Esc closes it. An empty comment is a plain
 * accept or decline. The toast's Undo puts the item back and removes the comment in one request.
 */
import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { Kbd } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";

export type CommentMode = "accept" | "decline";
export const TRIAGE_COMMENT_MAX = 280;

export function TriageCommentBar({ mode, busy, onSubmit, onCancel, onMore }: {
  mode: CommentMode; busy: boolean; onSubmit: (comment: string) => void; onCancel: () => void; onMore?: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, [mode]);
  const accept = mode === "accept";
  return (
    <form data-testid="triage-comment" data-mode={mode}
      className="flex flex-wrap items-center gap-2 border-t border-line bg-hover/40 px-5 py-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      onSubmit={(e) => { e.preventDefault(); if (!busy) onSubmit(text.trim()); }}>
      <span className={cn("inline-flex items-center gap-1 text-[13px] font-medium", accept ? "text-[#0071E3]" : "text-bad")}>
        {accept ? <Check className="h-4 w-4" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}{accept ? "Accept" : "Decline"}
      </span>
      <input ref={ref} value={text} maxLength={TRIAGE_COMMENT_MAX} onChange={(e) => setText(e.target.value)} disabled={busy}
        aria-label={accept ? "Comment for accepting (optional)" : "Comment for declining (optional)"} data-testid="triage-comment-input"
        placeholder={accept ? "Add a comment (optional)" : "Why not? (optional, your team sees it)"}
        className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-[14px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3]"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!busy) onSubmit(text.trim()); }
        }} />
      <span className="hidden items-center gap-1 text-xs text-subtle sm:inline-flex"><Kbd>Enter</Kbd> {accept ? "accept" : "decline"} <Kbd>Esc</Kbd> cancel</span>
      {!accept && onMore && <button type="button" onClick={onMore} className="rounded text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3]">Reply options</button>}
    </form>
  );
}

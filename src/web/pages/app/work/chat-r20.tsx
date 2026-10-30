/**
 * Round 20 chat polish in the web app: emoji reactions with a picker (no dependency), search inside
 * chat, the Call button and its join card, and jump to the first unread message. The emoji are the
 * user's content; the controls around them use Lucide icons.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { IconArrowDown, IconClose, IconReaction, IconSearch, IconVideo } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { mailDate } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { useConfig } from "@/web/lib/queries";
import { LiveCallCard, openCallDock } from "./call-r23";

export interface Reaction { emoji: string; count: number; reactors: { id: string; name: string }[] }

export const QUICK_EMOJI = ["\u{1F44D}", "\u{2764}\uFE0F", "\u{1F602}", "\u{1F389}", "\u{1F440}", "\u{2705}"];
export const EMOJI_GRID = ["\u{1F600}", "\u{1F604}", "\u{1F601}", "\u{1F605}", "\u{1F923}", "\u{1F642}", "\u{1F609}", "\u{1F60A}", "\u{1F60D}", "\u{1F618}", "\u{1F60E}", "\u{1F914}", "\u{1F928}", "\u{1F610}", "\u{1F644}", "\u{1F62E}", "\u{1F622}", "\u{1F62D}", "\u{1F621}", "\u{1F631}", "\u{1F973}", "\u{1F634}", "\u{1F92F}", "\u{1F92D}", "\u{1F64F}", "\u{1F44F}", "\u{1F64C}", "\u{1F44B}", "\u{1F44C}", "\u{270C}\uFE0F", "\u{1F91D}", "\u{1F4AA}", "\u{1F44E}", "\u{1F446}", "\u{1F447}", "\u{1F449}", "\u{1F525}", "\u{2728}", "\u{1F4AF}", "\u{2B50}", "\u{1F680}", "\u{1F3AF}", "\u{1F4A1}", "\u{1F4CC}", "\u{1F4C8}", "\u{1F4B0}", "\u{23F0}", "\u{1F381}", "\u{2757}", "\u{2753}", "\u{274C}", "\u{1F7E2}", "\u{1F7E1}", "\u{1F534}", "\u{1F49C}", "\u{1F499}", "\u{1F49A}", "\u{1F9E1}", "\u{1F30D}"];

/** Closes a popover on a click outside it or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, close]);
  return ref;
}

/** The add reaction button: a quick row and a plain grid. */
export function ReactionPicker({ onPick, className }: { onPick: (emoji: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const pick = (e: string) => { setOpen(false); onPick(e); };
  return (
    <div ref={ref} className={cn("relative", className)}>
      <Button variant="ghost" size="sm" aria-label="Add reaction" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="reaction-add"><IconReaction className="h-4 w-4" /></Button>
      {open && (
        <div role="dialog" aria-label="Pick a reaction" className="absolute right-0 z-50 mt-1.5 w-72 animate-pop-in rounded-xl border border-line bg-elevated p-2 shadow-pop" data-testid="reaction-picker">
          <div className="flex justify-between border-b border-line pb-2">
            {QUICK_EMOJI.map((e) => <button key={e} type="button" onClick={() => pick(e)} className="flex h-9 w-9 items-center justify-center rounded-lg text-[20px] hover:bg-hover" aria-label={`React with ${e}`}>{e}</button>)}
          </div>
          <div className="mt-2 grid max-h-48 grid-cols-8 gap-0.5 overflow-y-auto">
            {EMOJI_GRID.map((e) => <button key={e} type="button" onClick={() => pick(e)} className="flex h-8 w-8 items-center justify-center rounded-md text-[18px] hover:bg-hover" aria-label={`React with ${e}`}>{e}</button>)}
          </div>
        </div>
      )}
    </div>
  );
}

const whoReacted = (r: Reaction, myKey: string) => {
  const names = r.reactors.map((x) => (x.id === myKey ? "You" : x.name));
  const more = r.count - names.length;
  return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
};

/** Counts per emoji under a message; mine are highlighted, and hovering shows who reacted. */
export function Reactions({ reactions, myId, onToggle }: { reactions: Reaction[] | undefined; myId: string | undefined; onToggle: (emoji: string) => void }) {
  if (!reactions?.length) return null;
  const myKey = `member:${myId ?? ""}`;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="reactions">
      {reactions.map((r) => {
        const mine = r.reactors.some((x) => x.id === myKey);
        return (
          <button key={r.emoji} type="button" onClick={() => onToggle(r.emoji)} title={whoReacted(r, myKey)} aria-pressed={mine}
            aria-label={`${r.emoji} ${r.count}: ${whoReacted(r, myKey)}`} data-testid="reaction"
            className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12.5px] transition-colors",
              mine ? "border-brand/60 bg-brand/10 text-brand-hover" : "border-line bg-surface hover:border-line-strong")}>
            <span className="text-[14px] leading-none">{r.emoji}</span><span className="font-medium tabular-nums">{r.count}</span>
          </button>
        );
      })}
      <ReactionPicker onPick={onToggle} />
    </div>
  );
}

// ---------------------------------------------------------------- calls

const CALL_RE = /^Started a call\. Join: (\S*?(\/app\/meetings\/[A-Za-z0-9_-]+))/;
/** The meeting page of a call card message, or null for any other message. */
export const callPath = (body: string) => CALL_RE.exec(body)?.[2] ?? null;

/** The call card; round 23 adds live presence and the docked window (call-r23.tsx). */
export function CallCard({ path, by, at, channelId }: { path: string; by: string; at: string; channelId?: string }) {
  return <LiveCallCard path={path} by={by} at={at} channelId={channelId} />;
}

/** One tap: makes the meeting, posts the join card, and takes the caller into the call. */
export function CallButton({ channelId, onStarted }: { channelId: string; onStarted: () => Promise<unknown> | void }) {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const config = useConfig();
  const start = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ meeting: { id: string; title: string; videoEnabled?: boolean } }>(`/chat/channels/${channelId}/call`, {});
      await onStarted();
      // Round 23: with video on, the call docks over the app so chat stays readable; otherwise the meeting page.
      if (r.meeting.videoEnabled && (config.data as { meetings?: boolean } | undefined)?.meetings) openCallDock({ meetingId: r.meeting.id, title: r.meeting.title, path: `/app/meetings/${r.meeting.id}` });
      else navigate(`/app/meetings/${r.meeting.id}`);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return <Button variant="ghost" size="icon" aria-label="Start a call" title="Start a call" loading={busy} onClick={() => void start()} data-testid="chat-call"><IconVideo className="h-4 w-4" /></Button>;
}

// ---------------------------------------------------------------- search

export interface ChatSearchResult { id: string; channelId: string; parentId: string | null; authorName: string; channel: string; preview: string; createdAt: string }

/** The search box in the chat header: this channel or every chat you can read. */
export function ChatSearch({ channelId, onOpen }: { channelId: string; onOpen: (r: ChatSearchResult) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [everywhere, setEverywhere] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  useEffect(() => { const t = window.setTimeout(() => setQ(text.trim()), 250); return () => window.clearTimeout(t); }, [text]);
  const results = useQuery({
    queryKey: ["chat", "search", everywhere ? "" : channelId, q], enabled: open && q.length >= 2, staleTime: 10_000,
    queryFn: async () => (await api.get<{ results: ChatSearchResult[] }>(`/chat/search?q=${encodeURIComponent(q)}&limit=30${everywhere ? "" : `&channelId=${channelId}`}`)).results,
  });
  if (!open) return <Button variant="ghost" size="icon" aria-label="Search messages" title="Search messages" onClick={() => setOpen(true)} data-testid="chat-search-open"><IconSearch className="h-4 w-4" /></Button>;
  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 focus-within:border-brand/70 focus-within:ring-4 focus-within:ring-brand/15">
        <IconSearch className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={everywhere ? "Search all chats" : "Search this chat"} aria-label="Search messages"
          className="h-8 w-40 bg-transparent text-[13px] focus:outline-none sm:w-56" data-testid="chat-search" />
        <button type="button" aria-label="Close search" onClick={() => { setOpen(false); setText(""); }} className="text-subtle hover:text-fg"><IconClose className="h-3.5 w-3.5" /></button>
      </div>
      <div className="absolute right-0 z-50 mt-1.5 w-80 rounded-xl border border-line bg-elevated p-1 shadow-pop" data-testid="chat-search-results">
        <div className="flex gap-1 p-1 text-[12px]" role="group" aria-label="Where to search">
          <button type="button" aria-pressed={!everywhere} onClick={() => setEverywhere(false)} className={cn("rounded-md px-2 py-1", !everywhere ? "bg-fill font-medium" : "text-muted hover:bg-hover")}>This chat</button>
          <button type="button" aria-pressed={everywhere} onClick={() => setEverywhere(true)} className={cn("rounded-md px-2 py-1", everywhere ? "bg-fill font-medium" : "text-muted hover:bg-hover")}>All chats</button>
        </div>
        {q.length < 2 ? <p className="px-3 py-2 text-[12.5px] text-subtle">Type at least 2 letters.</p>
          : results.isPending ? <p className="px-3 py-2 text-[12.5px] text-subtle">Searching</p>
          : !results.data?.length ? <p className="px-3 py-2 text-[12.5px] text-subtle">No messages match.</p>
          : (
            <ul className="max-h-80 overflow-y-auto">
              {results.data.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => { setOpen(false); onOpen(r); }} className="w-full rounded-lg px-3 py-2 text-left hover:bg-hover" data-testid="chat-search-result">
                    <span className="flex items-baseline gap-2 text-[12px] text-subtle"><span className="font-medium text-fg">{r.authorName}</span>{everywhere && <span>{r.channel}</span>}{r.parentId && <span>in a thread</span>}<span className="ml-auto">{mailDate(r.createdAt)}</span></span>
                    <span className="line-clamp-2 text-[13px]">{r.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}

/** Scrolls to a message on screen and flashes it. False when it isn't loaded. */
export function flashMessage(id: string) {
  const el = document.getElementById(`m-${id}`);
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.classList.add("bg-hover");
  window.setTimeout(() => el.classList.remove("bg-hover"), 1500);
  return true;
}

// ---------------------------------------------------------------- first unread

/** The first unread message when the channel opened, read once before the channel is marked read. */
export function useFirstUnread(channelId: string | undefined) {
  return useQuery({
    queryKey: ["chat", "first-unread", channelId], enabled: !!channelId, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, retry: false,
    queryFn: () => api.get<{ messageId: string | null; unread: number }>(`/chat/channels/${channelId}/first-unread`),
  });
}

export function JumpToUnread({ first, onJump }: { first: { messageId: string | null; unread: number } | undefined; onJump: (id: string) => void }) {
  const [hidden, setHidden] = useState(false);
  if (!first?.messageId || !first.unread || hidden) return null;
  return (
    <div className="sticky top-0 z-10 flex justify-center py-1">
      <button type="button" onClick={() => { onJump(first.messageId!); setHidden(true); }} data-testid="jump-unread"
        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-elevated px-3 py-1 text-[12.5px] font-medium shadow-pop hover:border-line-strong">
        <IconArrowDown className="h-3.5 w-3.5" aria-hidden />{first.unread === 1 ? "1 new message" : `${first.unread} new messages`}, jump to first
      </button>
    </div>
  );
}

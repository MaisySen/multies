/**
 * Round 32: the line above the chat composer. "Maya is typing" while someone types, and a quiet
 * "Reconnecting" only when the live connection dropped (chat keeps working by polling meanwhile).
 */
import { IconRefresh } from "@/web/components/ui/icon";
import { typingText, useTyping, type TypingStore } from "@/web/lib/live-chat";

export function ChatLiveLine({ store, channelId, degraded }: { store: TypingStore; channelId: string; degraded: boolean }) {
  const typers = useTyping(store, channelId);
  const text = typingText(typers.map((t) => t.name));
  return (
    <div className="flex h-5 items-center gap-3 px-4 text-[12px] text-subtle" data-testid="chat-live-line">
      <span aria-live="polite" data-testid="chat-typing" className="min-w-0 truncate motion-safe:transition-opacity motion-safe:duration-150">
        {text && <><span className="mr-1 inline-flex gap-0.5 align-middle" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className="h-1 w-1 rounded-full bg-current motion-safe:animate-pulse" style={{ animationDelay: `${i * 150}ms` }} />)}</span>{text}</>}
      </span>
      {degraded && (
        <span role="status" data-testid="chat-reconnecting" className="ml-auto inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[11.5px] text-muted">
          <IconRefresh className="h-3 w-3 motion-safe:animate-spin" aria-hidden />Reconnecting
        </span>
      )}
    </div>
  );
}

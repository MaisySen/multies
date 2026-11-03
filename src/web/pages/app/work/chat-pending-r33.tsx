/**
 * Round 33: the sender's own bubbles that the server has not acknowledged yet. "Sending" while
 * the outbox holds or sends them; "Not sent, tap to retry" once it gave up (same client id, so a
 * retry can never post twice). They sit under the list until the server's message replaces them.
 */
import { IconAlertCircle, IconClock } from "@/web/components/ui/icon";
import { pendingFor, type ChatOutbox } from "@/web/lib/chat-outbox";
import { useOutbox } from "@/web/lib/live-chat";

export function PendingBubbles({ outbox, channelId, parentId, authorName }: { outbox: ChatOutbox; channelId: string; parentId: string | null; authorName?: string }) {
  const items = pendingFor(useOutbox(outbox), channelId, parentId);
  if (!items.length) return null;
  return (
    <ul aria-label="Messages being sent" data-testid="chat-pending">
      {items.map((i) => (
        <li key={i.clientMsgId} data-testid="chat-pending-item" data-state={i.state} data-client-id={i.clientMsgId}
          className="group flex gap-3 px-4 py-1.5 motion-safe:transition-opacity motion-safe:duration-150">
          <div className="h-8 w-8 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            {authorName && <div className="text-[13px] font-semibold text-ink">{authorName}</div>}
            <div className={`whitespace-pre-wrap break-words text-[14px] ${i.state === "failed" ? "text-ink" : "text-muted"}`}>{i.body}</div>
            {i.state === "failed" ? (
              <div className="mt-0.5 flex items-center gap-2 text-[12px]">
                <button type="button" onClick={() => outbox.retry(i.clientMsgId)} data-testid="chat-pending-retry"
                  className="inline-flex items-center gap-1 rounded text-red-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-red-400">
                  <IconAlertCircle className="h-3.5 w-3.5" aria-hidden />Not sent, tap to retry
                </button>
                <button type="button" onClick={() => outbox.discard(i.clientMsgId)} className="rounded text-subtle hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">Delete</button>
              </div>
            ) : (
              <div className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-subtle" role="status">
                <IconClock className="h-3 w-3" aria-hidden />Sending
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

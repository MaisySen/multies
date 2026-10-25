/**
 * The actions of one chat message as a sheet (R25 wave 2): phones and touch screens open it from the
 * message's More button or a long press, instead of an inline row of icons beside every message.
 * The Dialog is a bottom sheet under 640 px and a centred card on a touch tablet.
 */
import { useState } from "react";
import { CheckSquare, Copy, Inbox, MessageSquare, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog } from "@/web/components/ui/dialog";
import { cn } from "@/web/lib/cn";
import type { MessageAction, MessageActionId } from "@/web/lib/message-actions";
import { EMOJI_GRID, QUICK_EMOJI } from "./chat-r20";

const ICONS: Partial<Record<MessageActionId, typeof Copy>> = { thread: MessageSquare, copy: Copy, triage: Inbox, task: CheckSquare, pin: Pin, unpin: PinOff, edit: Pencil, delete: Trash2 };

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Couldn't copy on this device.");
  }
}

export function MessageActionSheet({ open, onClose, author, excerpt, actions, onAction, onReact }: {
  open: boolean; onClose: () => void; author: string; excerpt: string; actions: MessageAction[];
  onAction: (id: Exclude<MessageActionId, "react">) => void; onReact: (emoji: string) => void;
}) {
  const [allEmoji, setAllEmoji] = useState(false);
  const close = () => { setAllEmoji(false); onClose(); };
  const run = (id: Exclude<MessageActionId, "react">) => { close(); onAction(id); };
  const react = (e: string) => { close(); onReact(e); };
  const canReact = actions.some((a) => a.id === "react");
  return (
    <Dialog open={open} onClose={close} title="Message actions" description={<span className="line-clamp-2 break-words"><span className="font-medium text-fg">{author}:</span> {excerpt || "(no text)"}</span>} className="[&>div>div:nth-child(2)]:px-3 [&>div>div:nth-child(2)]:pt-3 [&>div>div:nth-child(2)]:pb-3">
      <div data-testid="message-action-sheet">
        {canReact && (
          <div className="border-b border-line px-1 pb-3">
            <div className="flex justify-between" role="group" aria-label="Quick reactions">
              {QUICK_EMOJI.map((e) => <button key={e} type="button" onClick={() => react(e)} className="flex h-11 w-11 items-center justify-center rounded-xl text-[22px] hover:bg-hover active:bg-hover" aria-label={`React with ${e}`}>{e}</button>)}
            </div>
            {allEmoji ? (
              <div className="mt-2 grid max-h-44 grid-cols-8 gap-0.5 overflow-y-auto" role="group" aria-label="All reactions">
                {EMOJI_GRID.map((e) => <button key={e} type="button" onClick={() => react(e)} className="flex h-10 w-full items-center justify-center rounded-lg text-[20px] hover:bg-hover active:bg-hover" aria-label={`React with ${e}`}>{e}</button>)}
              </div>
            ) : (
              <button type="button" onClick={() => setAllEmoji(true)} className="mt-1 h-10 w-full rounded-lg text-[13px] font-medium text-muted hover:bg-hover">More reactions</button>
            )}
          </div>
        )}
        <ul className="pt-2">
          {actions.filter((a): a is MessageAction & { id: Exclude<MessageActionId, "react"> } => a.id !== "react").map((a) => {
            const Icon = ICONS[a.id];
            return (
              <li key={a.id}>
                <button type="button" onClick={() => run(a.id)} className={cn("flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] hover:bg-hover active:bg-hover", a.danger ? "text-bad" : "text-fg")}>
                  {Icon && <Icon className={cn("h-5 w-5 shrink-0", a.danger ? "text-bad" : "text-muted")} aria-hidden />}{a.label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}

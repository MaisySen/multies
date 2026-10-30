import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconDocs, IconEye, IconPenLine, IconUserRoundCheck } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { useMailboxes } from "@/web/lib/queries";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { toast } from "sonner";
import { Avatar, Card } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { firstName, initials, useThreadPresence, type PresencePerson, type PresenceView } from "@/web/lib/thread-presence";
import { Compose, type ComposeDraft } from "./mail/compose";

/**
 * Round 22 (R22.3, R22.4) in the shared inbox: who else has this thread open (viewing, or replying
 * in amber), and draft replies teammates saved in it, which anyone who can open the mailbox can take over.
 */
export function ThreadCollab({ threadId }: { threadId: string }) {
  const presence = useThreadPresence(threadId, "viewing");
  return (
    <>
      <PresenceBar view={presence} />
      <ThreadDrafts threadId={threadId} />
    </>
  );
}

/** The same bar in webmail's reader, for the thread being read. */
export function ThreadPresenceLine({ threadId }: { threadId: string }) {
  const presence = useThreadPresence(threadId, "viewing");
  return <div className="mt-3"><PresenceBar view={presence} /></div>;
}

function sentence(people: PresencePerson[], state: "viewing" | "replying") {
  const names = people.filter((p) => p.state === state).map((p) => firstName(p.name));
  if (!names.length) return null;
  const who = names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return `${who} ${names.length === 1 ? "is" : "are"} ${state}`;
}

/** Avatars and one line: "Maya is replying" (amber) beats "Maya is viewing". */
export function PresenceBar({ view }: { view: PresenceView }) {
  const { people, notes } = view;
  if (!people.length && !notes.length) return null;
  const replying = sentence(people, "replying");
  const viewing = sentence(people, "viewing");
  return (
    <div className="space-y-2">
      {people.length > 0 && (
        <div data-testid="thread-presence" className={cn(
          "flex items-center gap-3 rounded-xl border px-3 py-2 text-[13px]",
          replying ? "border-warn/25 bg-warn-soft text-warn" : "border-line bg-surface text-muted",
        )}>
          <div className="flex -space-x-1.5">
            {people.slice(0, 4).map((p) => (
              <span key={p.userId} title={`${p.name}: ${p.state}`} className="relative">
                <Avatar label={initials(p.name)} className="h-6 w-6 text-[10px] ring-2 ring-surface" />
                {p.state === "replying" && <span className="absolute -bottom-0.5 -right-0.5 grid h-3 w-3 place-items-center rounded-full bg-warn text-white ring-1 ring-surface"><IconPenLine className="h-2 w-2" aria-hidden /></span>}
              </span>
            ))}
          </div>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
            {replying && <span className="inline-flex items-center gap-1 font-medium"><IconPenLine className="h-3.5 w-3.5" aria-hidden />{replying}</span>}
            {viewing && <span className={cn("inline-flex items-center gap-1", replying && "text-muted")}><IconEye className="h-3.5 w-3.5" aria-hidden />{viewing}</span>}
          </span>
        </div>
      )}
      {notes.map((n) => (
        <div key={n.draftId} role="status" data-testid="presence-note" className="flex items-center gap-2 rounded-xl border border-brand/25 bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
          <IconUserRoundCheck className="h-4 w-4 shrink-0" aria-hidden />
          <span>{firstName(n.byName)} took over your draft on {n.subject}</span>
        </div>
      ))}
    </div>
  );
}

interface ThreadDraft {
  id: string; threadId: string; mailboxId: string; subject: string; snippet: string; to: string[];
  author: { userId: string; name: string } | null; mine: boolean; updatedAt: string;
}
interface TakenDraft { draft: { id: string; threadId: string; mailboxId: string; subject: string; text: string; inReplyToId: string | null; to: string[]; cc: string[]; bcc: string[] } }

/** "Draft by Maya, edited 3 min ago" with a preview; Take over opens it in Compose as yours. */
function ThreadDrafts({ threadId }: { threadId: string }) {
  const qc = useQueryClient();
  const mailboxes = useMailboxes();
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const drafts = useQuery({ queryKey: ["thread-drafts", threadId], queryFn: () => api.get<{ drafts: ThreadDraft[] }>(`/threads/${threadId}/drafts`), refetchInterval: 30_000 });
  const take = useMutation({
    mutationFn: (id: string) => api.post<TakenDraft>(`/threads/drafts/${id}/take-over`),
    onSuccess: (r, id) => {
      const was = drafts.data?.drafts.find((x) => x.id === id);
      if (was && !was.mine && was.author) toast.success(`You have ${firstName(was.author.name)}'s draft now`);
      const d = r.draft;
      setCompose({ mailboxId: d.mailboxId, to: d.to.join(", "), cc: d.cc.join(", ") || undefined, bcc: d.bcc.join(", ") || undefined, subject: d.subject, text: d.text, draftId: d.id, threadId: d.threadId, inReplyToId: d.inReplyToId ?? undefined });
      void qc.invalidateQueries({ queryKey: ["thread-drafts", threadId] });
    },
    onError: (e) => { toast.error(e instanceof ApiError ? e.message : "Couldn't take over the draft."); void qc.invalidateQueries({ queryKey: ["thread-drafts", threadId] }); },
  });
  const list = drafts.data?.drafts ?? [];
  return (
    <>
      {list.length > 0 && (
        <Card className="divide-y divide-line" data-testid="thread-drafts">
          {list.map((d) => (
            <div key={d.id} data-testid="thread-draft" className="flex items-start gap-3 px-4 py-3">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-fill text-muted"><IconDocs className="h-3.5 w-3.5" aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">
                  {d.mine ? "Your draft" : `Draft by ${d.author ? firstName(d.author.name) : "a teammate"}`}
                  <span className="font-normal text-subtle">, edited {timeAgo(d.updatedAt)}</span>
                </p>
                <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted">{d.snippet.trim() || "(empty)"}</p>
              </div>
              <Button size="sm" variant={d.mine ? "secondary" : "outline"} onClick={() => take.mutate(d.id)} disabled={take.isPending || !mailboxes.data}>
                {d.mine ? "Open" : "Take over"}
              </Button>
            </div>
          ))}
        </Card>
      )}
      {compose && mailboxes.data && (
        <Compose initial={compose} mailboxes={mailboxes.data} onClose={() => { setCompose(null); void qc.invalidateQueries({ queryKey: ["thread-drafts", threadId] }); void qc.invalidateQueries({ queryKey: ["team-inbox", threadId] }); }} />
      )}
    </>
  );
}

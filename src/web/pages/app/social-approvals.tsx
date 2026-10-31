/**
 * R117: Home, Approvals, Social posts. Members' posts wait here; owners and admins approve (it goes out at its time,
 * or now if that has passed), ask for changes with a note, or reject with a note. Members see their own waiting posts.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { Badge, Card, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Textarea } from "@/web/components/ui/input";
import { IconCheck, IconClose, IconEdit, IconMegaphone } from "@/web/components/ui/icon";
import type { SocialPostView } from "@/shared/integrations";
import { networkLabel } from "@/shared/social-p2";
import { useConfig, useMe } from "@/web/lib/queries";
import { postsKey, whenText } from "./apps-social";

export const socialApprovalsKey = ["social", "approvals"] as const;
export const useSocialApprovals = (enabled = true) => useQuery({ queryKey: socialApprovalsKey, queryFn: () => api.get<{ posts: SocialPostView[] }>("/social/approvals").then((r) => r.posts), enabled, refetchInterval: 30_000 });

export function SocialApprovals() {
  const config = useConfig();
  const me = useMe();
  const on = !!config.data?.socialP2;
  const q = useSocialApprovals(on);
  const qc = useQueryClient();
  const role = me.data?.organization?.role;
  const approver = role === "owner" || role === "admin";
  const [noteFor, setNoteFor] = useState<{ post: SocialPostView; kind: "changes" | "reject" } | null>(null);
  const [note, setNote] = useState("");
  const done = (msg: string) => { toast.success(msg); void qc.invalidateQueries({ queryKey: socialApprovalsKey }); void qc.invalidateQueries({ queryKey: postsKey }); };
  const approve = useMutation({
    mutationFn: (id: string) => api.post<{ post: SocialPostView }>(`/social/posts/${id}/approve`),
    onSuccess: (r) => done(Date.parse(r.post.runAt) > Date.now() + 60_000 ? `Approved. It goes out ${whenText(r.post.runAt)}.` : "Approved. Sending now."),
    onError: (e) => toast.error(errorMessage(e, "Couldn't approve it. Try again.")),
  });
  const decide = useMutation({
    mutationFn: ({ id, kind, note }: { id: string; kind: "changes" | "reject"; note: string }) => api.post(`/social/posts/${id}/${kind}`, { note }),
    onSuccess: (_r, v) => { done(v.kind === "changes" ? "Changes asked. The author sees your note." : "Rejected. The author sees your note."); setNoteFor(null); setNote(""); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't save that. Try again.")),
  });
  if (!on) return null;
  if (q.isPending) return <Skeleton className="mb-6 h-24 rounded-xl" />;
  const posts = q.data ?? [];
  if (q.error || (!posts.length && !approver)) return null;
  return (
    <section aria-labelledby="social-approvals-title" className="mb-8" data-testid="social-approvals">
      <h2 id="social-approvals-title" className="mb-2 flex items-center gap-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">
        <IconMegaphone className="h-4 w-4" aria-hidden />Social posts{posts.length > 0 && <span className="tabular-nums">({posts.length})</span>}
      </h2>
      {!posts.length ? <Card className="px-4 py-5 text-[13px] text-muted" data-testid="social-approvals-empty">No social posts are waiting. When a member sends one for approval, it shows here.</Card> : (
        <ul className="space-y-3">
          {posts.map((p) => (
            <li key={p.id}>
              <Card className="p-4 md:p-5" data-testid="social-approval" data-id={p.id}>
                <div className="flex items-start gap-3.5">
                  {p.images?.[0] && <img src={p.images[0].url} alt="" className="h-20 w-20 shrink-0 rounded-lg border border-line object-cover" loading="lazy" />}
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                      <Badge tone="brand" dot>Waiting for approval</Badge>
                      <span>{Date.parse(p.runAt) > Date.now() ? `Set for ${whenText(p.runAt)}` : "Goes out when approved"}</span>
                      {p.campaign && <Badge tone="neutral">{p.campaign}</Badge>}
                    </p>
                    <p className="mt-2 line-clamp-5 whitespace-pre-line break-words text-sm leading-relaxed">{p.text}</p>
                    <p className="mt-2 text-[12.5px] text-muted">To {[...new Set(p.targets.map((t) => t.label ?? networkLabel(t.app)))].join(", ")}{p.images && p.images.length > 1 ? `, ${p.images.length} images` : ""}</p>
                  </div>
                </div>
                {approver ? (
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" size="sm" className="text-bad hover:text-bad max-sm:flex-1" onClick={() => setNoteFor({ post: p, kind: "reject" })} data-testid="approval-reject"><IconClose className="h-4 w-4" aria-hidden />Reject</Button>
                    <Button variant="outline" size="sm" className="max-sm:flex-1" onClick={() => setNoteFor({ post: p, kind: "changes" })} data-testid="approval-changes"><IconEdit className="h-4 w-4" aria-hidden />Request changes</Button>
                    <Button size="sm" className="max-sm:flex-1" loading={approve.isPending && approve.variables === p.id} onClick={() => approve.mutate(p.id)} data-testid="approval-approve"><IconCheck className="h-4 w-4" aria-hidden />Approve</Button>
                  </div>
                ) : <p className="mt-3 text-right text-[12.5px] text-muted">An owner or admin will look at it. <Link to="/app/social/posts?status=waiting" className="font-medium text-fg underline underline-offset-2">See it in Posts</Link></p>}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!noteFor} onClose={() => { setNoteFor(null); setNote(""); }} title={noteFor?.kind === "reject" ? "Reject this post?" : "Request changes"}
        description={noteFor?.kind === "reject" ? "It won't go out. The author sees your note." : "It goes back to the author as a draft with your note."}
        footer={<><Button variant="ghost" onClick={() => { setNoteFor(null); setNote(""); }}>Cancel</Button>
          <Button variant={noteFor?.kind === "reject" ? "danger" : "primary"} disabled={!note.trim()} loading={decide.isPending} data-testid="approval-note-save"
            onClick={() => noteFor && decide.mutate({ id: noteFor.post.id, kind: noteFor.kind, note: note.trim() })}>{noteFor?.kind === "reject" ? "Reject post" : "Send back"}</Button></>}>
        <label htmlFor="approval-note" className="mb-1.5 block text-[13px] font-medium">{noteFor?.kind === "reject" ? "Why" : "What should change"}</label>
        <Textarea id="approval-note" rows={4} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} data-testid="approval-note" autoFocus />
      </Dialog>
    </section>
  );
}

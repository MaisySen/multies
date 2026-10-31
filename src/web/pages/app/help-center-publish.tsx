/**
 * R122: Publish as answer, on a solved ticket in the shared inbox. Shows the public question and answer with the
 * customer's email, name, phone numbers, quoted history and private notes already taken out, for the agent to edit.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Skeleton } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { IconShieldCheck } from "@/web/components/ui/icon";
import { useCenter } from "./help-center";

interface Preview {
  ticketId: string; number: number; title: string; question: string; answer: string; canPublish: boolean;
  removed: { emails: number; phones: number; names: number; quoted: number }; alreadyPublished: { id: string; status: string } | null;
}

function removedLine(r: Preview["removed"]) {
  const parts = [r.names && "their name", r.emails && "email addresses", r.phones && "phone numbers", r.quoted && "quoted earlier mail"].filter(Boolean) as string[];
  return parts.length ? `We took out ${parts.join(", ")} and private notes. Check the text before you publish.` : "Private notes are never included. Check the text before you publish.";
}

export function PublishAnswerDialog({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const center = useCenter();
  const p = useQuery({ queryKey: ["help-center", "preview", ticketId], retry: false, queryFn: () => api.get<{ preview: Preview }>(`/help-center/tickets/${ticketId}/preview`) });
  const cats = useQuery({ queryKey: ["help-center", "categories"], enabled: !!center.data?.settings, queryFn: () => api.get<{ categories: { id: string; name: string }[] }>("/help-center/categories") });
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [keep, setKeep] = useState(false);
  useEffect(() => { if (p.data) { setTitle(p.data.preview.title); setQuestion(p.data.preview.question); setAnswer(p.data.preview.answer); } }, [p.data]);
  const pub = useMutation({
    mutationFn: () => api.post<{ question: { status: string } }>("/help-center/tickets/publish", { ticketId, title, question, answer, categoryId: categoryId || null, keepPrivate: keep }),
    onSuccess: (d) => { toast.success(d.question.status === "published" ? "Published to the help center" : "Sent to an admin to approve"); qc.invalidateQueries({ queryKey: ["help-center"] }); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const noCenter = center.data && !center.data.settings;
  const pv = p.data?.preview;
  return (
    <Dialog open onClose={onClose} title="Publish as answer" className="sm:max-w-2xl"
      description="Turn this solved ticket into a public question and answer in your help center."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>{pv && !pv.alreadyPublished && !noCenter && <Button onClick={() => pub.mutate()} disabled={!title.trim() || answer.trim().length < 2} loading={pub.isPending}>{pv.canPublish ? "Publish" : "Send for approval"}</Button>}</>}>
      {noCenter ? <p className="text-sm text-muted">Set up the help center first, in Docs, Help center.</p>
        : p.isPending ? <div className="space-y-2"><Skeleton className="h-9 w-full" /><Skeleton className="h-24 w-full" /></div>
        : p.isError ? <p className="text-sm text-bad" role="alert">{errorMessage(p.error)}</p>
        : pv?.alreadyPublished ? <p className="text-sm text-muted">This ticket is already in the help center.</p>
        : pv && <div className="grid gap-3">
          <p className="flex items-start gap-2 rounded-lg bg-fill p-3 text-[13px] text-muted"><IconShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />{removedLine(pv.removed)}</p>
          <label className="block text-sm font-medium">Question title<Input className="mt-1" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="block text-sm font-medium">Question<Textarea className="mt-1" rows={3} maxLength={4000} value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
          <label className="block text-sm font-medium">Answer<Textarea className="mt-1" rows={5} maxLength={8000} value={answer} onChange={(e) => setAnswer(e.target.value)} /></label>
          {(cats.data?.categories.length ?? 0) > 0 && <label className="block text-sm font-medium">Category<Select className="mt-1 w-full" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">None</option>{cats.data!.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></label>}
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={keep} onChange={(e) => setKeep(e.target.checked)} />Keep the customer's details on purpose</label>
          {!pv.canPublish && <p className="text-xs text-subtle">An owner or admin approves it before it shows.</p>}
        </div>}
    </Dialog>
  );
}

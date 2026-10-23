import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, ClipboardCheck, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Textarea } from "@/web/components/ui/input";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { useAgents } from "./agents";

export interface Approval {
  id: string; agentId: string; mailboxId: string; threadId: string | null; status: "pending" | "sent" | "rejected" | "failed" | "expired";
  to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; html: string | null; inReplyToId: string | null;
  decidedBy: string | null; decidedAt: string | null; note: string | null; messageId: string | null; error: string | null; expiresAt: string; createdAt: string;
}

export const usePendingApprovals = () => useQuery({ queryKey: ["approvals", "pending"], queryFn: async () => (await api.get<{ approvals: Approval[] }>("/approvals?status=pending")).approvals, refetchInterval: 30_000 });

const STATUS: Record<Approval["status"], { label: string; tone: "ok" | "warn" | "bad" | "neutral" | "brand" }> = {
  pending: { label: "Waiting", tone: "brand" }, sent: { label: "Approved and sent", tone: "ok" }, rejected: { label: "Rejected", tone: "neutral" },
  failed: { label: "Failed to send", tone: "bad" }, expired: { label: "Expired", tone: "neutral" },
};

export function ApprovalsPage() {
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const pending = usePendingApprovals();
  const all = useQuery({ queryKey: ["approvals", "all"], queryFn: async () => (await api.get<{ approvals: Approval[] }>("/approvals")).approvals, enabled: tab === "decided" });
  const list = tab === "pending" ? pending : all;
  const rows = tab === "pending" ? list.data : list.data?.filter((a) => a.status !== "pending");
  return (
    <>
      <PageHeader title="Approvals" description="Messages your agents want to send. Nothing leaves until someone approves it. Edit before you approve if it needs a better word." />
      <div className="mb-4 flex gap-1 rounded-lg border border-line p-1 text-sm sm:w-fit" role="tablist" aria-label="Approvals">
        {(["pending", "decided"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("flex-1 rounded-md px-3 py-1.5 sm:flex-none", tab === t ? "bg-white/[0.07] font-medium text-fg" : "text-muted hover:text-fg")}>
            {t === "pending" ? `Waiting${pending.data?.length ? ` (${pending.data.length})` : ""}` : "Decided"}
          </button>
        ))}
      </div>
      {list.isPending ? <Card className="p-5"><Skeleton className="h-24" /></Card>
        : list.error ? <Card className="p-6 text-sm text-bad">{list.error.message}</Card>
        : !rows?.length ? (
          <Card><EmptyState icon={<ClipboardCheck />} title={tab === "pending" ? "Nothing waiting" : "No decisions yet"}
            body={tab === "pending" ? "When an agent asks to send, the message shows up here for you to approve or reject." : "Approved and rejected messages show up here."} /></Card>
        ) : <div className="space-y-4">{rows.map((a) => <ApprovalCard key={a.id} a={a} />)}</div>}
    </>
  );
}

export function ApprovalCard({ a, compact }: { a: Approval; compact?: boolean }) {
  const qc = useQueryClient();
  const agents = useAgents();
  const agent = agents.data?.find((x) => x.id === a.agentId);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(a.subject);
  const [text, setText] = useState(a.text);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const done = (msg: string) => { qc.invalidateQueries({ queryKey: ["approvals"] }); qc.invalidateQueries({ queryKey: ["agents"] }); qc.invalidateQueries({ queryKey: ["team-inbox"] }); toast.success(msg); };
  const approve = useMutation({
    mutationFn: () => api.post(`/approvals/${a.id}/approve`, editing ? { subject, text } : {}),
    onSuccess: () => done("Approved and sent"), onError: (e) => showError(e),
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/approvals/${a.id}/reject`, { note: note.trim() || undefined }),
    onSuccess: () => { setRejecting(false); done("Rejected. The agent is told by webhook and event."); }, onError: (e) => showError(e),
  });
  const s = STATUS[a.status];
  return (
    <Card role="article" aria-label={`${agent?.name ?? "Agent"}: ${a.subject || "(no subject)"}`} className={cn("p-4 sm:p-5", compact && "border-brand/40")}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="brand"><Bot className="h-3 w-3" aria-hidden />{agent?.name ?? "Agent"}</Badge>
        <span className="text-muted">wants to send to</span>
        <span className="min-w-0 break-all font-medium">{[...a.to, ...a.cc].join(", ")}</span>
        <span className="ml-auto flex items-center gap-2 text-xs text-subtle"><Badge tone={s.tone}>{s.label}</Badge>{timeAgo(a.createdAt)}</span>
      </div>
      {editing ? (
        <div className="mt-3 space-y-3">
          <Field label="Subject">{(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
          <Field label="Message">{(p) => <Textarea {...p} rows={8} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        </div>
      ) : (
        <div className="mt-3">
          <div className="font-medium">{a.subject || "(no subject)"}</div>
          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-fg/85">{a.text}</p>
        </div>
      )}
      {a.status !== "pending" && (a.decidedBy || a.error || a.note) && (
        <p className="mt-3 text-xs text-subtle">{a.error ? `Error: ${a.error}` : `${s.label} by ${a.decidedBy}${a.note ? `: "${a.note}"` : ""}`}</p>
      )}
      {a.status === "pending" && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate()}><Check className="h-4 w-4" />{editing ? "Approve edited" : "Approve and send"}</Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(!editing)}><Pencil className="h-4 w-4" />{editing ? "Cancel edit" : "Edit"}</Button>
          <Button size="sm" variant="ghost" onClick={() => setRejecting(true)}><X className="h-4 w-4" />Reject</Button>
          {a.threadId && !compact && <Link to={`/app/inbox?thread=${a.threadId}`} className="ml-auto text-xs text-brand-hover hover:underline">See the thread</Link>}
        </div>
      )}
      <Dialog open={rejecting} onClose={() => setRejecting(false)} title="Reject this message?" description="The agent gets your note with the decision."
        footer={<><Button variant="secondary" onClick={() => setRejecting(false)}>Cancel</Button><Button variant="danger" loading={reject.isPending} onClick={() => reject.mutate()}>Reject</Button></>}>
        <Field label="Note for the agent (optional)">{(p) => <Textarea {...p} rows={3} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Too formal. Mention the 30 day terms." />}</Field>
      </Dialog>
    </Card>
  );
}

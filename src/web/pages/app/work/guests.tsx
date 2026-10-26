/** Invite clients to a project as guests: free, no seat, and they see only this project. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconAssign, IconTeam, IconTrash } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Input } from "@/web/components/ui/input";
import { Avatar, Badge, CopyButton } from "@/web/components/ui/misc";
import { ConfirmButton } from "@/web/components/ui/confirm";
import { timeAgo } from "@/web/lib/format";
import type { Project } from "./data";

interface Guest { id: string; email: string; name: string; status: "pending" | "active" | "revoked"; lastSeenAt: string | null; approvalId: string | null; approvalStatus: "pending" | "sent" | "rejected" | "failed" | "expired" | null; createdAt: string }
interface InviteResult { guest: Guest; delivery: { status: "sent" | "pending_approval" | "not_sent"; detail?: string }; inviteUrl?: string }

export function GuestsDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const q = useQuery({ queryKey: ["guests", project.id], queryFn: async () => (await api.get<{ guests: Guest[] }>(`/guests?projectId=${project.id}`)).guests });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<InviteResult | null>(null);
  const invite = async () => {
    if (!email.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<InviteResult>("/guests", { projectId: project.id, email, name: name || undefined });
      setLast(r); setEmail(""); setName(""); await q.refetch();
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const remove = async (g: Guest) => {
    try { await api.del(`/guests/${g.id}`); await q.refetch(); } catch (e) { showError(e as Error); }
  };
  return (
    <Dialog open onClose={onClose} title={`Guests on ${project.name}`} description="Invite a client by email. Guests are free on every plan and take no seat. They see this project's tasks, comments and docs, and can comment and upload files. Nothing else.">
      <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); void invite(); }}>
        <Input type="email" aria-label="Guest email" placeholder="client@company.com.au" value={email} onChange={(e) => setEmail(e.target.value)} className="h-9 text-[13px]" required />
        <Input aria-label="Guest name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} className="h-9 text-[13px]" />
        <Button type="submit" loading={busy}><IconAssign className="h-4 w-4" />Invite</Button>
      </form>
      {last && (
        <p className="mt-3 rounded-lg border border-line bg-elevated/60 p-2.5 text-[12.5px] text-muted" role="status">
          {last.delivery.status === "sent" ? <>Invite sent to {last.guest.email}.</>
            : last.delivery.status === "pending_approval" ? <>The invite to {last.guest.email} is waiting for approval.</>
              : <>Email isn't connected here, so nothing was sent. Share this link with {last.guest.email} yourself: {last.inviteUrl && <CopyButton value={last.inviteUrl} label="Copy invite link" />}</>}
        </p>
      )}
      <ul className="mt-4 divide-y divide-line" aria-label="Guests">
        {(q.data ?? []).map((g) => (
          <li key={g.id} className="flex items-center gap-3 py-2.5 text-[13px]">
            <Avatar label={initials(g.name || g.email)} className="h-8 w-8" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{g.name || g.email}</span>
              {g.name && <span className="block truncate text-[12px] text-muted">{g.email}</span>}
            </span>
            <Badge tone={g.status === "active" ? "ok" : g.approvalStatus === "rejected" || g.approvalStatus === "failed" || g.approvalStatus === "expired" ? "bad" : "neutral"}>
              {g.status === "active" ? "Joined" : g.approvalStatus === "pending" ? "Waiting for approval" : g.approvalStatus && g.approvalStatus !== "sent" ? "Invite not sent" : "Invited"}
            </Badge>
            {g.lastSeenAt && <span className="hidden text-[11.5px] text-subtle sm:inline">seen {timeAgo(g.lastSeenAt)}</span>}
            <ConfirmButton armedLabel="Remove?" aria-label={`Remove ${g.email}`} title="They lose access straight away" onConfirm={() => void remove(g)}><IconTrash className="h-4 w-4" /></ConfirmButton>
          </li>
        ))}
        {q.data && !q.data.length && (
          <li className="flex items-center gap-3 py-4 text-[13px] text-muted">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-fill" aria-hidden><IconTeam className="h-4 w-4" /></span>
            No guests yet. Invite a client above and they'll see only this project.
          </li>
        )}
      </ul>
    </Dialog>
  );
}

function initials(s: string) {
  const parts = s.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, ShieldCheck, User } from "lucide-react";
import { authClient } from "@/web/lib/auth-client";
import { api, ApiError } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { Badge, Skeleton } from "@/web/components/ui/misc";
import { LOCALE } from "@/shared/locale";

interface InviteView {
  email: string; role: "admin" | "member"; state: "pending" | "accepted" | "expired" | "revoked";
  hasAccount: boolean; organization: { name: string }; invitedBy: string | null; expiresAt: string;
}

export function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const invite = useQuery({ queryKey: ["invite", token], queryFn: async () => (await api.get<{ invite: InviteView }>(`/invites/${token}`)).invite, retry: false });
  const accept = useMutation({
    mutationFn: () => api.post(`/invites/${token}/accept`),
    onSuccess: () => { qc.clear(); navigate("/app/my-work"); },
  });
  const next = encodeURIComponent(`/invite/${token}`);

  const card = "rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur";
  if (invite.isPending || me.isPending) return <div className={card} aria-busy><Skeleton className="h-12 w-12 rounded-2xl" /><Skeleton className="mt-4 h-6 w-2/3" /><Skeleton className="mt-3 h-4" /><Skeleton className="mt-6 h-11" /></div>;
  if (invite.error || !invite.data) {
    return (
      <div className={card}>
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-warn-soft text-warn" aria-hidden><AlertTriangle className="h-5 w-5" /></span>
        <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.02em]">This invitation link isn't valid</h1>
        <p className="mt-1 text-sm text-muted">Check that you copied the whole link, or ask for a new one.</p>
        <ButtonLink to="/" variant="secondary" className="mt-6 w-full">Go to Multies</ButtonLink>
      </div>
    );
  }
  const inv = invite.data;
  const signedInAs = me.data?.user.email?.toLowerCase();
  const dead = inv.state !== "pending";

  return (
    <div className={card}>
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-[#0071E3] to-[#5E5CE6] text-lg font-semibold text-white shadow-[0_6px_16px_-6px_rgb(0_113_227/0.6)]" aria-hidden>{workspaceInitial(inv.organization.name)}</div>
      <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.02em]">Join {inv.organization.name}</h1>
      <p className="mt-1 text-sm text-muted">{inv.invitedBy ? `${inv.invitedBy} invited you to work together in Multies.` : "You've been invited to work together in Multies."}</p>
      <ul className="mt-5 divide-y divide-line rounded-xl border border-line bg-elevated/60 text-[13px]">
        <li className="flex items-center gap-2.5 px-3.5 py-2.5"><User className="h-4 w-4 shrink-0 text-subtle" aria-hidden /><span className="min-w-0 flex-1 truncate">{inv.email}</span></li>
        <li className="flex items-center gap-2.5 px-3.5 py-2.5"><ShieldCheck className="h-4 w-4 shrink-0 text-subtle" aria-hidden /><span className="flex-1">Role</span><Badge tone={inv.role === "admin" ? "brand" : "neutral"}>{inv.role === "admin" ? "Admin" : "Member"}</Badge></li>
        {!dead && <li className="flex items-center gap-2.5 px-3.5 py-2.5"><CalendarClock className="h-4 w-4 shrink-0 text-subtle" aria-hidden /><span className="flex-1">Link works until</span><span className="text-muted">{new Date(inv.expiresAt).toLocaleDateString(LOCALE, { day: "numeric", month: "short" })}</span></li>}
      </ul>
      {dead ? (
        <p className="mt-6 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn">
          {inv.state === "expired" ? "This invitation has expired. Ask for a new one." : inv.state === "accepted" ? "This invitation has already been used." : "This invitation was withdrawn."}
        </p>
      ) : signedInAs === inv.email ? (
        <>
          {accept.error && <p className="mt-6 rounded-lg border border-bad/25 bg-bad-soft px-3 py-2 text-sm text-bad">{accept.error instanceof ApiError ? accept.error.message : "Couldn't accept."}</p>}
          <Button size="lg" className="mt-6 w-full" loading={accept.isPending} onClick={() => accept.mutate()}>Accept and open workspace</Button>
        </>
      ) : signedInAs ? (
        <>
          <p className="mt-6 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn">You're signed in as {signedInAs}. This invitation is for {inv.email}.</p>
          <Button size="lg" variant="secondary" className="mt-3 w-full" onClick={async () => { await authClient.signOut().catch(() => {}); qc.clear(); navigate(`/login?email=${encodeURIComponent(inv.email)}&next=${next}`); }}>Sign in as {inv.email}</Button>
        </>
      ) : inv.hasAccount ? (
        <ButtonLink size="lg" className="mt-6 w-full" to={`/login?email=${encodeURIComponent(inv.email)}&next=${next}`}>Sign in to accept</ButtonLink>
      ) : (
        <>
          <ButtonLink size="lg" className="mt-6 w-full" to={`/signup?email=${encodeURIComponent(inv.email)}&next=${next}&invited=1`}>Create your account</ButtonLink>
          <p className="mt-4 text-center text-sm text-muted">Already have one? <Link className="font-medium text-fg hover:underline" to={`/login?email=${encodeURIComponent(inv.email)}&next=${next}`}>Sign in</Link></p>
        </>
      )}
    </div>
  );
}

function workspaceInitial(name: string) {
  return (name.trim()[0] ?? "M").toUpperCase();
}

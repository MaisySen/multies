import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Users } from "lucide-react";
import { api, ApiError } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { Skeleton } from "@/web/components/ui/misc";

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
    onSuccess: () => { qc.clear(); navigate("/app"); },
  });
  const next = encodeURIComponent(`/invite/${token}`);

  const card = "rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur";
  if (invite.isPending || me.isPending) return <div className={card}><Skeleton className="h-6 w-2/3" /><Skeleton className="mt-3 h-4" /><Skeleton className="mt-6 h-10" /></div>;
  if (invite.error || !invite.data) {
    return (
      <div className={card}>
        <AlertTriangle className="h-6 w-6 text-warn" />
        <h1 className="mt-3 text-xl font-semibold tracking-tight">This invitation link isn't valid</h1>
        <p className="mt-1 text-sm text-muted">Check that you copied the whole link, or ask for a new one.</p>
        <ButtonLink to="/" variant="secondary" className="mt-6 w-full">Go to MyMail</ButtonLink>
      </div>
    );
  }
  const inv = invite.data;
  const signedInAs = me.data?.user.email?.toLowerCase();
  const dead = inv.state !== "pending";

  return (
    <div className={card}>
      <div className="grid h-11 w-11 place-items-center rounded-xl border border-line-strong bg-elevated text-brand-hover"><Users className="h-5 w-5" /></div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Join {inv.organization.name}</h1>
      <p className="mt-1 text-sm text-muted">
        {inv.invitedBy ? `${inv.invitedBy} invited ` : "You've been invited as "}<b className="font-medium text-fg">{inv.email}</b>{inv.invitedBy ? ` to join as ${inv.role === "admin" ? "an admin" : "a member"}.` : ` ${inv.role}.`}
      </p>
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
          <Button size="lg" variant="secondary" className="mt-3 w-full" onClick={async () => { await api.post("/auth/logout").catch(() => {}); qc.clear(); navigate(`/login?email=${encodeURIComponent(inv.email)}&next=${next}`); }}>Sign in as {inv.email}</Button>
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

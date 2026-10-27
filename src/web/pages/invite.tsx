import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCalendarClock, IconShieldCheck, IconUser, IconWarning } from "@/web/components/ui/icon";
import { authClient } from "@/web/lib/auth-client";
import { api, errorMessage, isTransientError } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { isSignedOut } from "@/web/lib/me-cache";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { Badge, Skeleton } from "@/web/components/ui/misc";
import { LOCALE } from "@/shared/locale";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { forgetInvite, rememberInvite, settleAfterJoin } from "@/web/lib/pending-invite";
import { startIdentitySignIn, useAuthProviders } from "@/web/pages/auth";

interface InviteView {
  email: string; role: "admin" | "member"; state: "pending" | "accepted" | "expired" | "revoked";
  hasAccount: boolean; organization: { name: string }; invitedBy: string | null; expiresAt: string;
}

export function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  // R41: read the invite after the session check, which joins a confirmed newcomer on first sign in, so the
  // state shown is the state after that join.
  const invite = useQuery({ queryKey: ["invite", token], queryFn: async () => (await api.get<{ invite: InviteView }>(`/invites/${token}`)).invite, retry: false, enabled: !me.isPending });
  const providers = useAuthProviders();
  const idp = !!providers.data?.idp;
  const [going, setGoing] = useState<"signup" | "signin" | null>(null);
  const joined = async (name: string) => {
    await settleAfterJoin();
    qc.clear();
    navigate("/app/my-work");
    toast.success(`You joined ${name}`, { id: "joined", description: "Your tasks, projects and team are here." });
  };
  const accept = useMutation({
    mutationFn: () => api.post(`/invites/${token}/accept`),
    onSuccess: () => void joined(invite.data?.organization.name ?? "the workspace"),
  });
  const next = encodeURIComponent(`/invite/${token}`);
  // R41 (MB-221): the invite is remembered through sign up and the confirmation email (lib/pending-invite.ts).
  const inviteState = invite.data?.state;
  const inviteEmail = invite.data?.email;
  const meEmail = me.data?.user.email?.toLowerCase();
  useEffect(() => {
    if (inviteState === "pending") rememberInvite(token);
    else if (inviteState) forgetInvite();
  }, [inviteState, token]);
  // Signed in with the invited address and already joined (on first sign in the server joins a confirmed
  // newcomer straight away): open the workspace instead of a "used" notice.
  const alreadyJoined = inviteState === "accepted" && !!meEmail && meEmail === inviteEmail;
  useEffect(() => { if (alreadyJoined && invite.data) void joined(invite.data.organization.name); }, [alreadyJoined]); // eslint-disable-line react-hooks/exhaustive-deps
  const startIdp = async (which: "signup" | "signin") => {
    setGoing(which);
    try { await startIdentitySignIn(which, { next: `/invite/${token}`, email: invite.data?.email }); } catch { setGoing(null); }
  };

  const card = "rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur";
  if (invite.isPending || me.isPending || alreadyJoined) return <div className={card} aria-busy><Skeleton className="h-12 w-12 rounded-2xl" /><Skeleton className="mt-4 h-6 w-2/3" /><Skeleton className="mt-3 h-4" /><Skeleton className="mt-6 h-11" /></div>;
  if (invite.error || !invite.data) {
    return (
      <div className={card}>
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-warn-soft text-warn" aria-hidden><IconWarning className="h-5 w-5" /></span>
        <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.02em]">This invitation link isn't valid</h1>
        <p className="mt-1 text-sm text-muted">Check that you copied the whole link, or ask for a new one.</p>
        <ButtonLink to="/" variant="secondary" className="mt-6 w-full">Go to Multies</ButtonLink>
      </div>
    );
  }
  const inv = invite.data;
  // R40 (MB-200): a failed session check is "reconnecting", never "signed out".
  const signedInAs = isSignedOut(me.error) ? undefined : me.data?.user.email?.toLowerCase();
  const meDown = !me.data && !!me.error && isTransientError(me.error);
  const dead = inv.state !== "pending";

  return (
    <div className={card}>
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-[#0071E3] to-[#5E5CE6] text-lg font-semibold text-white shadow-[0_6px_16px_-6px_rgb(0_113_227/0.6)]" aria-hidden>{workspaceInitial(inv.organization.name)}</div>
      <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.02em]">Join {inv.organization.name}</h1>
      <p className="mt-1 text-sm text-muted">{inv.invitedBy ? `${inv.invitedBy} invited you to work together in Multies.` : "You've been invited to work together in Multies."}</p>
      <ul className="mt-5 divide-y divide-line rounded-xl border border-line bg-elevated/60 text-[13px]">
        <li className="flex items-center gap-2.5 px-3.5 py-2.5"><IconUser className="h-4 w-4 shrink-0 text-subtle" aria-hidden /><span className="min-w-0 flex-1 truncate">{inv.email}</span></li>
        <li className="flex items-center gap-2.5 px-3.5 py-2.5"><IconShieldCheck className="h-4 w-4 shrink-0 text-subtle" aria-hidden /><span className="flex-1">Role</span><Badge tone={inv.role === "admin" ? "brand" : "neutral"}>{inv.role === "admin" ? "Admin" : "Member"}</Badge></li>
        {!dead && <li className="flex items-center gap-2.5 px-3.5 py-2.5"><IconCalendarClock className="h-4 w-4 shrink-0 text-subtle" aria-hidden /><span className="flex-1">Link works until</span><span className="text-muted">{new Date(inv.expiresAt).toLocaleDateString(LOCALE, { day: "numeric", month: "short" })}</span></li>}
      </ul>
      {dead ? (
        <p className="mt-6 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn">
          {inv.state === "expired" ? "This invitation has expired. Ask for a new one." : inv.state === "accepted" ? "This invitation has already been used." : "This invitation was withdrawn."}
        </p>
      ) : signedInAs === inv.email ? (
        <>
          {accept.error && <p className="mt-6 rounded-lg border border-bad/25 bg-bad-soft px-3 py-2 text-sm text-bad">{errorMessage(accept.error, "Couldn't accept.")}</p>}
          <Button size="lg" className="mt-6 w-full" loading={accept.isPending} onClick={() => accept.mutate()}>Accept and open workspace</Button>
        </>
      ) : meDown ? (
        <>
          <p role="status" className="mt-6 rounded-lg border border-line bg-elevated/60 px-3 py-2 text-sm text-muted">Couldn't reach Multies to check your sign in. Trying again.</p>
          <Button size="lg" variant="secondary" className="mt-3 w-full" loading={me.isFetching} onClick={() => void me.refetch()}>Retry</Button>
        </>
      ) : signedInAs ? (
        <>
          <p className="mt-6 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn">You're signed in as {signedInAs}. This invitation is for {inv.email}.</p>
          <Button size="lg" variant="secondary" className="mt-3 w-full" onClick={async () => { await authClient.signOut().catch(() => {}); qc.clear(); navigate(`/login?email=${encodeURIComponent(inv.email)}&next=${next}`); }}>Sign in as {inv.email}</Button>
        </>
      ) : idp ? (
        // R41 (MB-221): straight to the sign in service with the invited email filled in, and back here joined.
        <>
          <Button size="lg" className="mt-6 w-full" loading={going === (inv.hasAccount ? "signin" : "signup")} onClick={() => startIdp(inv.hasAccount ? "signin" : "signup")} data-testid="invite-primary">
            {inv.hasAccount ? `Sign in and join ${inv.organization.name}` : `Sign up and join ${inv.organization.name}`}
          </Button>
          <p className="mt-4 text-center text-sm text-muted">
            {inv.hasAccount ? "New to Multies? " : "Already have an account? "}
            <button type="button" className="font-medium text-fg hover:underline" onClick={() => startIdp(inv.hasAccount ? "signup" : "signin")} data-testid="invite-secondary">{inv.hasAccount ? "Create an account" : "Sign in"}</button>
          </p>
          <p className="mt-3 text-center text-xs text-subtle">You'll land in {inv.organization.name} as soon as you're in. No setup needed.</p>
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

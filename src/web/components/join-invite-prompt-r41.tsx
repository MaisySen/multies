/**
 * R41 (MB-221, MB-202): someone who signed up and still has a pending invite (for example they were not
 * confirmed yet on first sign in, so they got a personal workspace) is not walked through setting up that
 * workspace. Before onboarding they see the invite first: one tap joins it and opens My Work there.
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconUserCheck } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { api, errorMessage } from "@/web/lib/api";
import { settleAfterJoin } from "@/web/lib/pending-invite";
import type { Me } from "@/web/lib/types";

type Invite = NonNullable<Me["pendingInvites"]>[number];

export function JoinInvitePrompt({ invite, onSkip }: { invite: Invite; onSkip: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [skipping, setSkipping] = useState(false);
  const join = useMutation({
    mutationFn: () => api.post(`/invites/${invite.token}/accept`),
    onSuccess: async () => {
      await settleAfterJoin();
      qc.clear();
      navigate("/app/my-work");
      toast.success(`You joined ${invite.organization.name}`, { id: "joined", description: "Your tasks, projects and team are here." });
    },
  });
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas p-5" data-testid="join-invite-prompt">
      <div className="w-full max-w-[420px] rounded-2xl border border-line bg-surface/90 p-7 shadow-pop backdrop-blur">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand to-[#5E5CE6] text-lg font-semibold text-white shadow-[0_6px_16px_-6px_rgb(0_113_227/0.6)]" aria-hidden>
          {(invite.organization.name.trim()[0] ?? "M").toUpperCase()}
        </div>
        <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.02em]">Join {invite.organization.name}</h1>
        <p className="mt-1 text-sm text-muted">{invite.invitedBy ? `${invite.invitedBy} invited you to work together.` : "You're invited to work together."} You'll be a {invite.role === "admin" ? "admin" : "member"}.</p>
        <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-line bg-elevated/60 px-3.5 py-2.5 text-[13px] text-muted">
          <IconUserCheck className="h-4 w-4 shrink-0 text-brand" aria-hidden />
          <span>No setup needed. Your tasks, projects and team are waiting there.</span>
        </div>
        {join.error && <p className="mt-4 rounded-lg border border-bad/25 bg-bad-soft px-3 py-2 text-sm text-bad">{errorMessage(join.error, "Couldn't join. Try again.")}</p>}
        <Button size="lg" className="mt-6 w-full" loading={join.isPending} onClick={() => join.mutate()} data-testid="join-invite-accept">Join {invite.organization.name}</Button>
        <button type="button" className="mt-3 min-h-11 w-full rounded-lg text-sm font-medium text-muted transition-colors duration-150 hover:text-fg motion-reduce:transition-none" disabled={skipping}
          onClick={() => { setSkipping(true); onSkip(); }}>Set up my own workspace instead</button>
      </div>
    </div>
  );
}

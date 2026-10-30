/**
 * R39 (MB-202): a teammate who signed up from an invite link can land in their own new workspace while the
 * invitation waits. This strip names the workspace that invited them and takes them back to the invite to join.
 */
import { Link } from "react-router";
import { IconUserCheck } from "@/web/components/ui/icon";
import { useMe } from "@/web/lib/queries";

export function PendingInviteBanner() {
  const invite = useMe().data?.pendingInvites?.[0];
  if (!invite) return null;
  return (
    <div role="status" data-testid="pending-invite-banner" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-line bg-brand-soft px-4 py-2 text-[13px] text-fg">
      <IconUserCheck className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
      <span>{invite.invitedBy ? `${invite.invitedBy} invited you to join ${invite.organization.name}.` : `You're invited to join ${invite.organization.name}.`}</span>
      <Link to={`/invite/${invite.token}`} className="rounded-md bg-brand px-2.5 py-1 text-[12.5px] font-medium text-white transition-colors duration-150 hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">Join {invite.organization.name}</Link>
    </div>
  );
}

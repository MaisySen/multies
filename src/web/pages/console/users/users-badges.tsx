/** OPS1: the Users section's state badges, shared by the list and the detail page. Built on ../components/format. */
import { Badge } from "@/web/components/ui/misc";
import { OperatorRoleBadge, StatusBadge, TwoStepBadge, formatDay } from "../components/format";

export interface UserStateLike {
  banned: boolean; banExpires: string | null; emailVerified: boolean; operator: boolean; role: string | null; twoFactorEnabled?: boolean;
  kind?: "person" | "agent";
}

/**
 * Banned (red), email not confirmed (amber), operator role, AI agent (grey); nothing for a plain healthy account.
 * `showTwoFactor` adds "Two-step on" or "Two-step off" (the detail page header).
 */
export function UserStateBadges({ u, showTwoFactor = false }: { u: UserStateLike; showTwoFactor?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {u.banned && <StatusBadge state="banned" label={u.banExpires ? `Banned until ${formatDay(u.banExpires)}` : "Banned"} />}
      {!u.emailVerified && u.kind !== "agent" && <StatusBadge state="pending" label="Email not confirmed" />}
      {u.operator && <OperatorRoleBadge role={u.role} />}
      {u.kind === "agent" && <Badge className="whitespace-nowrap">AI agent</Badge>}
      {showTwoFactor && <TwoStepBadge on={!!u.twoFactorEnabled} long />}
    </span>
  );
}

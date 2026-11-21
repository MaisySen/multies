/** OPS1: the Users section's state badges and dates, shared by the list and the detail page. */
import { Badge } from "@/web/components/ui/misc";
import { fullDate, timeAgo } from "@/web/lib/format";
import { operatorRoleLabel } from "@/shared/operator-permissions";

/** Relative time with the exact time on hover. */
export function When({ at, empty = "Never" }: { at: string | null | undefined; empty?: string }) {
  if (!at) return <span className="text-subtle">{empty}</span>;
  return <time dateTime={at} title={fullDate(at)} className="whitespace-nowrap">{timeAgo(at)}</time>;
}

export interface UserStateLike {
  banned: boolean; banExpires: string | null; emailVerified: boolean; operator: boolean; role: string | null; twoFactorEnabled?: boolean;
  kind?: "person" | "agent";
}

/** Banned (red), unverified (amber), operator role (brand), AI agent (grey); nothing for a plain healthy account. */
export function UserStateBadges({ u, showTwoFactor = false }: { u: UserStateLike; showTwoFactor?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {u.banned && <Badge tone="bad" dot>{u.banExpires ? `Banned until ${new Date(u.banExpires).toLocaleDateString()}` : "Banned"}</Badge>}
      {!u.emailVerified && <Badge tone="warn" dot>Unverified</Badge>}
      {u.operator && <Badge tone="brand">{operatorRoleLabel(u.role)}</Badge>}
      {u.kind === "agent" && <Badge>AI agent</Badge>}
      {showTwoFactor && (u.twoFactorEnabled ? <Badge tone="ok" dot>Two-step on</Badge> : <Badge>Two-step off</Badge>)}
    </span>
  );
}

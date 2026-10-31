/**
 * R118: account health where it matters: a broken account's planned posts say so, with one tap to fix it.
 */
import { Link } from "react-router";
import { IconWarning } from "@/web/components/ui/icon";
import { networkLabel } from "@/shared/social-p2";
import type { SocialPostView } from "@/shared/integrations";
import { useAccountHealth } from "./apps-social";
import { useConfig } from "@/web/lib/queries";

export function useBrokenTargets(p: SocialPostView) {
  const c = useConfig().data;
  const on = !!c?.socialP2 && c?.socialP2b !== false;
  const health = useAccountHealth();
  if (!on || !health.data || !["scheduled", "review", "changes", "draft"].includes(p.status)) return [];
  return p.targets.filter((t) => t.status === "pending" || p.status !== "scheduled").filter((t) => { const h = health.data!.get(t.accountId); return h && !h.ok && h.code !== "check_failed"; });
}

/** "Facebook needs a new sign in. This post won't go out until you reconnect." under a planned post. */
export function PlannedHealthNote({ post, compact = false }: { post: SocialPostView; compact?: boolean }) {
  const bad = useBrokenTargets(post);
  if (!bad.length) return null;
  const names = [...new Set(bad.map((t) => (t.app === "testnet" ? "Test network" : networkLabel(t.app))))].join(" and ");
  if (compact) return <span className="inline-flex items-center gap-1 text-[12px] font-medium text-warn" data-testid="post-health-warning" title={`${names} needs a new sign in`}><IconWarning className="h-3.5 w-3.5" aria-hidden />Sign in needed</span>;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-warn" data-testid="post-health-warning">
      <IconWarning className="h-4 w-4 shrink-0" aria-hidden />
      <span>{names} needs a new sign in. This post won't go out to it until you reconnect.</span>
      <Link to="/app/social/accounts" className="font-medium underline underline-offset-2">Fix it</Link>
    </p>
  );
}

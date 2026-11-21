/**
 * OPS1: /console/moderation, Moderation and abuse. Four tabs, the tab in the address (?tab=): Reports (default, open
 * first), Abuse signals, Suspended workspaces and Sign-in lockouts. Switching tab starts that tab's filters afresh.
 * (/app/admin/reports redirects here.)
 */
import { useSearchParams } from "react-router";
import { Badge, PageHeader } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { AbuseTab } from "./moderation-abuse";
import { ReportsTab, useReportCounts } from "./moderation-reports";
import { LockoutsTab, SuspendedTab } from "./moderation-suspended";

const TABS = [
  { id: "reports", label: "Reports" },
  { id: "abuse", label: "Abuse signals" },
  { id: "suspended", label: "Suspended workspaces" },
  { id: "lockouts", label: "Sign-in lockouts" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function ConsoleModerationPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get("tab");
  const tab: TabId = TABS.find((t) => t.id === asked)?.id ?? "reports";
  const counts = useReportCounts();
  const open = counts.data?.open ?? 0;
  const go = (id: TabId) => setParams(id === "reports" ? {} : { tab: id }, { replace: true });
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Platform" title="Moderation"
        description="Reports of chat messages and people, the spam filter's signals, suspended workspaces and locked sign-ins. Act on each report within 24 hours." />
      <nav aria-label="Moderation sections" className="overflow-x-auto border-b border-line">
        <ul className="flex min-w-max gap-1" role="tablist">
          {TABS.map((t) => (
            <li key={t.id} role="presentation">
              <button type="button" role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)} data-testid={`console-moderation-tab-${t.id}`}
                className={cn("-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors",
                  tab === t.id ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>
                {t.label}
                {t.id === "reports" && open > 0 && <Badge tone={(counts.data?.olderThan24h ?? 0) > 0 ? "bad" : (counts.data?.olderThan12h ?? 0) > 0 ? "warn" : "neutral"}>{open}</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label}>
        {tab === "reports" && <ReportsTab />}
        {tab === "abuse" && <AbuseTab />}
        {tab === "suspended" && <SuspendedTab />}
        {tab === "lockouts" && <LockoutsTab />}
      </div>
    </div>
  );
}

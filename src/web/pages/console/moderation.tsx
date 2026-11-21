/**
 * OPS1: /console/moderation, Moderation and abuse. Four tabs, the tab in the address (?tab=): Reports (default, open
 * first), Abuse signals, Suspended workspaces and Sign-in lockouts. Switching tab starts that tab's filters afresh.
 * (/app/admin/reports redirects here.)
 */
import { PageHeader } from "@/web/components/ui/misc";
import { QueryTabs, TabPanel, useQueryTab } from "./components/detail-tabs";
import { TabCount } from "./components/format";
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
  const tab: TabId = useQueryTab(TABS);
  const counts = useReportCounts();
  const open = counts.data?.open ?? 0;
  const tabs = TABS.map((t) => t.id === "reports" && open > 0
    ? { ...t, badge: <TabCount n={open} tone={(counts.data?.olderThan24h ?? 0) > 0 ? "bad" : (counts.data?.olderThan12h ?? 0) > 0 ? "warn" : "neutral"} /> }
    : t);
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Platform" title="Moderation"
        description="Reports of chat messages and people, the spam filter's signals, suspended workspaces and locked sign-ins. Act on each report within 24 hours." />
      <QueryTabs tabs={tabs} label="Moderation sections" testIdPrefix="console-moderation-tab" />
      <TabPanel testIdPrefix="console-moderation-tab" current={tab}>
        {tab === "reports" && <ReportsTab />}
        {tab === "abuse" && <AbuseTab />}
        {tab === "suspended" && <SuspendedTab />}
        {tab === "lockouts" && <LockoutsTab />}
      </TabPanel>
    </div>
  );
}

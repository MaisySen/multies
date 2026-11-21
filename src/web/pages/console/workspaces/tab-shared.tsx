/**
 * OPS1: shared pieces for the Workspaces section of the console: the wire types of /api/console/workspaces, the
 * workspace query, state badges, relative times, simple section frames and the limit actions (send cap, sending
 * switch, call minutes cap) used by both the page header and the Overview tab.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "@/web/lib/api";
import { fullDate, timeAgo } from "@/web/lib/format";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import { IconWarning } from "@/web/components/ui/icon";
import { useOperatorAction } from "../components/reason-dialog";

// ---------------------------------------------------------------- wire types

export type PlanId = "starter" | "pro" | "business";

export interface WorkspaceRow {
  id: string; name: string; slug: string | null; plan: PlanId; effectivePlan: PlanId; compPlan: boolean; isDemo: boolean;
  subscriptionStatus: string | null; pastDueSince: string | null; graceEndsAt: string | null; suspendedAt: string | null;
  suspendedReason: string | null; sendCapDaily: number | null; createdAt: string; ownerEmail: string | null;
  members: number; agentMembers: number; domains: number;
}

export interface PlanLimits {
  domains: number; mailboxes: number; aliases: number; storagePerMailboxMb: number; storageMb: number; dailySends: number;
  seats: number; agentInboxes: number; agentMessagesMonthly: number; agentDailySends: number; automationRunsMonthly: number;
  agentMembers: number; [key: string]: number;
}

export interface UsageTotals { domains: number; mailboxes: number; agentInboxes: number; aliases: number; seats: number; storageMb: number; agentMessages: number }

export interface WorkspaceOverview {
  org: {
    id: string; name: string; slug: string | null; plan: PlanId; effectivePlan: PlanId; compPlan: boolean; isDemo: boolean;
    timezone: string; country: string; createdAt: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null;
    subscriptionStatus: string | null; billingInterval: "month" | "year" | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean;
    pastDueSince: string | null; graceEndsAt: string | null; requireSso: boolean; suspendedAt: string | null; suspendedReason: string | null;
    sendCapDaily: number | null; meetingMinutesCap: number | null; channelsEnabled: boolean; legacyStorageMb: number | null;
  };
  limits: PlanLimits;
  addons: Record<string, number>;
  usage: UsageTotals;
  counts: {
    members: number; agentMembers: number; pendingInvites: number; agents: number; apiKeys: number; webhookEndpoints: number;
    webhookEndpointsDisabled: number; activeOauthGrants: number; sendsToday: number; meetingMinutesThisMonth: number;
  };
  writeBudget: { used: number; budget: number; level: string; resetAt: string };
}

export const PLAN_LABEL: Record<PlanId, string> = { starter: "Starter", pro: "Pro", business: "Business" };

export const workspaceKey = (id: string) => ["console", "workspace", id] as const;
export const wsPath = (id: string) => `/console/workspaces/${encodeURIComponent(id)}`;
export const apiPath = (id: string, rest = "") => `/console/workspaces/${encodeURIComponent(id)}${rest}`;

export function useWorkspace(id: string) {
  return useQuery({ queryKey: workspaceKey(id), queryFn: () => api.get<WorkspaceOverview>(apiPath(id)) });
}

/** A detail read of one tab, keyed under the workspace so a change refreshes it. */
export function useWorkspacePart<T>(id: string, part: string, rest = `/${part}`) {
  return useQuery({ queryKey: [...workspaceKey(id), part, rest], queryFn: () => api.get<T>(apiPath(id, rest)) });
}

// ---------------------------------------------------------------- small pieces

const isPastDue = (w: { pastDueSince: string | null; subscriptionStatus: string | null }) => !!w.pastDueSince || w.subscriptionStatus === "past_due";

/** Suspended (red), past due (amber), comp and demo (grey). Nothing when the workspace is in good standing. */
export function StateBadges({ w, showActive }: { w: { suspendedAt: string | null; pastDueSince: string | null; subscriptionStatus: string | null; compPlan: boolean; isDemo: boolean }; showActive?: boolean }) {
  const any = !!w.suspendedAt || isPastDue(w) || w.compPlan || w.isDemo;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="console-workspaces-state">
      {w.suspendedAt && <Badge tone="bad" dot>Suspended</Badge>}
      {isPastDue(w) && <Badge tone="warn" dot>Past due</Badge>}
      {w.compPlan && <Badge>Comp</Badge>}
      {w.isDemo && <Badge>Demo</Badge>}
      {!any && showActive && <Badge tone="ok" dot>Active</Badge>}
    </span>
  );
}

/** Relative time with the exact time on hover. */
export function When({ at, empty = "Never" }: { at: string | null | undefined; empty?: string }) {
  if (!at) return <span className="text-subtle">{empty}</span>;
  return <span className="whitespace-nowrap" title={fullDate(at)}>{timeAgo(at)}</span>;
}

export function Section({ title, description, actions, children, testId }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="text-[13px] text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
    </div>
  );
}

export function ErrorBlock({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <Card className="p-0">
      <EmptyState icon={<IconWarning />} title="Couldn't load this" body={errorMessage(error as Error)} action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
    </Card>
  );
}

export function EmptyBlock({ title, body, icon }: { title: string; body: ReactNode; icon?: ReactNode }) {
  return <Card className="p-0"><EmptyState icon={icon} title={title} body={body} /></Card>;
}

/** "Plan default" for null, the number otherwise. */
export const capText = (cap: number | null, unit: string) => (cap === null ? "Plan default" : cap === 0 ? "Off" : `${cap.toLocaleString()} ${unit}`);

// ---------------------------------------------------------------- limit actions

type Target = { id: string; name: string };

function CapField({ label, hint, value, onChange, testId }: { label: string; hint: string; value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <Field label={label} hint={hint}>
      {(p) => <Input {...p} type="number" inputMode="numeric" min={0} value={value} placeholder="Plan default" onChange={(e) => onChange(e.target.value)} data-testid={testId} />}
    </Field>
  );
}

const parseCap = (v: string): number | null | undefined => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

/** The three limit changes, each through the reason dialog. Render `dialogs` once. */
export function useLimitActions() {
  const [sendCap, setSendCap] = useState("");
  const [meetingCap, setMeetingCap] = useState("");
  const sendCapValue = parseCap(sendCap);
  const meetingCapValue = parseCap(meetingCap);

  const sendCapAction = useOperatorAction<Target>({
    title: (w) => `Change the daily send cap for ${w.name}?`,
    description: "The most messages to outside recipients this workspace can send a day. Leave it empty to use the plan's cap.",
    confirmLabel: "Save send cap",
    fields: <CapField label="Messages a day" hint="Empty uses the plan's cap. 0 stops sending." value={sendCap} onChange={setSendCap} testId="console-workspaces-send-cap-input" />,
    canSubmit: sendCapValue !== undefined,
    run: (w, reason) => api.put(apiPath(w.id, "/send-cap"), { cap: sendCapValue, reason }),
    success: "Send cap saved",
  });
  const meetingCapAction = useOperatorAction<Target>({
    title: (w) => `Change the call minutes cap for ${w.name}?`,
    description: "The most call minutes this workspace can use a month. Leave it empty to use the plan's rule. 0 blocks new calls.",
    confirmLabel: "Save call minutes cap",
    fields: <CapField label="Call minutes a month" hint="Empty uses the plan's rule. 0 blocks new calls." value={meetingCap} onChange={setMeetingCap} testId="console-workspaces-meeting-cap-input" />,
    canSubmit: meetingCapValue !== undefined,
    run: (w, reason) => api.put(apiPath(w.id, "/meeting-cap"), { cap: meetingCapValue, reason }),
    success: "Call minutes cap saved",
  });
  const sendingAction = useOperatorAction<Target & { enabled: boolean }>({
    title: (w) => (w.enabled ? `Turn sending back on for ${w.name}?` : `Turn sending off for ${w.name}?`),
    description: (w) => (w.enabled
      ? "The workspace goes back to its plan's daily send cap."
      : "Every send from this workspace is refused with a clear message until sending is turned back on. Mail still arrives."),
    confirmLabel: "Confirm",
    tone: "primary",
    run: (w, reason) => api.put(apiPath(w.id, "/sending"), { enabled: w.enabled, reason }),
    success: (w) => (w.enabled ? "Sending turned on" : "Sending turned off"),
  });

  return {
    openSendCap: (w: Target & { current: number | null }) => { setSendCap(w.current === null ? "" : String(w.current)); sendCapAction.open(w); },
    openMeetingCap: (w: Target & { current: number | null }) => { setMeetingCap(w.current === null ? "" : String(w.current)); meetingCapAction.open(w); },
    openSending: (w: Target & { enabled: boolean }) => sendingAction.open(w),
    dialogs: <>{sendCapAction.dialog}{meetingCapAction.dialog}{sendingAction.dialog}</>,
  };
}

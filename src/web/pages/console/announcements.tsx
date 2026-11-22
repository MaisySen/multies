/**
 * OPS1: Announcements in the operator console (GET/PUT/DELETE /api/console/announcements). One banner at a time:
 * the current one with its status (live, scheduled, ended) and a Remove button, then the form with a live preview
 * (announcements-form.tsx). Roles without announcements.manage see the current one only.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { consoleGet, consoleKeys } from "@/web/lib/console-api";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconMegaphone } from "@/web/components/ui/icon";
import { Empty, LoadError, PersonLink, RelTime, formatDateTime } from "./components/format";
import { KvList } from "./components/kv-list";
import { useOperatorAction } from "./components/reason-dialog";
import { PermissionGate } from "./guard";
import { AnnouncementForm, AUDIENCES, TONES, type AnnouncementState } from "./announcements-form";

const annKey = [...consoleKeys.all, "announcements"] as const;

const STATUS: Record<NonNullable<AnnouncementState["status"]>, { label: string; tone: "ok" | "brand" | "neutral"; body: string }> = {
  live: { label: "Showing now", tone: "ok", body: "People see this banner now." },
  scheduled: { label: "Scheduled", tone: "brand", body: "Not showing yet. It starts at the time below." },
  ended: { label: "Ended", tone: "neutral", body: "No longer showing. Remove it to tidy up, or publish a new one." },
};

const When = ({ iso, empty }: { iso: string | null; empty: string }) => (iso ? <span className="whitespace-nowrap">{formatDateTime(iso)}</span> : <Empty>{empty}</Empty>);

function Current({ state }: { state: AnnouncementState }) {
  const remove = useOperatorAction<void>({
    title: "Remove the announcement?",
    description: "The banner stops showing. Open sessions may take a few minutes to drop it.",
    confirmLabel: "Remove announcement", tone: "danger",
    run: (_v, reason) => api.del<AnnouncementState>("/console/announcements", { reason }),
    success: "Announcement removed",
  });
  const a = state.announcement;
  if (!a) {
    return (
      <Card className="p-0" data-testid="console-announcements-empty">
        <EmptyState icon={<IconMegaphone />} title="No announcement" body="Nobody sees a banner right now. Write one below to show it at the top of the web app (the phone app does not show it yet)." />
      </Card>
    );
  }
  const s = STATUS[state.status ?? "live"];
  return (
    <Card className="space-y-4 p-4 sm:p-5" data-testid="console-announcements-current">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold">Current announcement</h2>
            <Badge tone={s.tone} dot className="whitespace-nowrap">{s.label}</Badge>
          </div>
          <p className="text-sm text-muted">{s.body}</p>
        </div>
        <PermissionGate permission="announcements.manage">
          <Button variant="danger" onClick={() => remove.open()} data-testid="console-announcements-remove">Remove announcement</Button>
        </PermissionGate>
      </div>
      <KvList items={[
        { label: "Text", value: a.text },
        { label: "Tone", value: TONES.find((t) => t.value === a.tone)?.label ?? a.tone },
        { label: "Who sees it", value: AUDIENCES.find((x) => x.value === a.audience)?.label ?? a.audience },
        { label: "Link", value: a.linkUrl ? <a href={a.linkUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-brand">{a.linkLabel ?? a.linkUrl}</a> : null },
        { label: "Starts", value: <When iso={a.startsAt} empty="When it was published" /> },
        { label: "Ends", value: <When iso={a.endsAt} empty="When someone removes it" /> },
        { label: "People can dismiss it", value: a.dismissible ? "Yes" : "No" },
        { label: "Published", value: a.updatedAt ? (
          <span className="inline-flex flex-wrap items-baseline gap-x-1">
            <RelTime at={a.updatedAt} />
            {state.updatedByEmail && <>by <PersonLink id={null} email={state.updatedByEmail} /></>}
          </span>
        ) : null },
      ]} />
      {remove.dialog}
    </Card>
  );
}

export function ConsoleAnnouncementsPage() {
  const q = useQuery({ queryKey: annKey, queryFn: () => consoleGet<AnnouncementState>("/console/announcements") });
  const header = <PageHeader eyebrow="Product" title="Announcements" description="One banner at the top of the web app, for everyone or only for workspace owners and admins. The phone app does not show it yet." />;
  if (q.isPending) return (
    <div className="space-y-4" aria-busy="true">
      {header}
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
  if (q.error) return (
    <div className="space-y-4">
      {header}
      <LoadError error={q.error} what="the announcement" retry={() => void q.refetch()} />
    </div>
  );
  return (
    <div className="space-y-4">
      {header}
      <Current state={q.data} />
      <PermissionGate permission="announcements.manage">
        {/* A fresh form after each publish or removal, starting from what is stored. */}
        <AnnouncementForm key={q.data.announcement?.id ?? "none"} current={q.data.announcement} />
      </PermissionGate>
    </div>
  );
}

/**
 * R35 (Apple 1.2): the operator moderation queue at /app/admin/reports. Platform admins only (the API is guarded the
 * same way). Open reports newest first; the age turns amber past 12 hours and red past 24 (Apple's window).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { IconBack, IconFlag, IconShieldCheck } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { timeAgo } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { PromptDialog, useDialogs } from "@/web/components/ui/confirm";
import { REPORT_REASONS } from "./work/report-sheet-r35";

export interface ModerationReport {
  id: string; status: "open" | "resolved" | "dismissed"; action: string; targetType: "message" | "user"; context: string | null; reason: string; note: string | null;
  workspaceId: string | null; messageId: string | null; snapshotText: string | null;
  reporter: { id: string; name: string | null; email: string | null }; target: { id: string; name: string | null; email: string | null; suspended: boolean } | null;
  createdAt: string; ageHours: number; resolvedAt: string | null; resolutionNote: string | null;
}

const REASON = Object.fromEntries(REPORT_REASONS.map((r) => [r.id, r.label])) as Record<string, string>;
const CONTEXT: Record<string, string> = { chat: "Channel", dm: "Direct message", meeting: "Meeting chat" };

/** Amber past 12 hours, red past 24: the operator acts within 24 hours. */
export function ageTone(hours: number): "ok" | "warn" | "bad" { return hours >= 24 ? "bad" : hours >= 12 ? "warn" : "ok"; }

export { useOpenReportCount } from "@/web/lib/open-report-count"; // R45: moved so the app frame does not load this page

export function ModerationPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"open" | "all">("open");
  const q = useQuery({ queryKey: ["admin", "reports", status], queryFn: async () => (await api.get<{ reports: ModerationReport[] }>(`/admin/reports?status=${status}`)).reports });
  const { confirm, dialogs } = useDialogs();
  const [resolving, setResolving] = useState<ModerationReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (r: ModerationReport, action: "dismiss" | "resolve" | "remove_message" | "suspend_user", note?: string) => {
    if (action === "suspend_user" && !(await confirm({ title: `Suspend ${r.target?.name ?? "this person"}?`, description: "They are signed out everywhere and can't sign in until an operator lifts it.", confirmLabel: "Suspend", tone: "danger" }))) return;
    if (action === "remove_message" && !(await confirm({ title: "Remove this message?", description: "It is deleted for everyone in the conversation.", confirmLabel: "Remove", tone: "danger" }))) return;
    setBusy(r.id + action);
    try {
      await api.post(`/admin/reports/${r.id}/action`, { action, note });
      toast.success(action === "dismiss" ? "Report dismissed" : action === "remove_message" ? "Message removed" : action === "suspend_user" ? "Account suspended" : "Report resolved");
      await qc.invalidateQueries({ queryKey: ["admin", "reports"] });
    } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  return (
    <div className="space-y-6">
      {dialogs}
      <Link to="/app/admin" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg"><IconBack className="h-4 w-4" aria-hidden />Operator console</Link>
      <PageHeader eyebrow="Platform" title="Moderation" description="Reports of chat messages and people. Act on each within 24 hours: remove the message, suspend the account, or dismiss it." />
      <div className="inline-flex rounded-lg bg-fill p-0.5" role="tablist" aria-label="Which reports">
        {(["open", "all"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={status === s} onClick={() => setStatus(s)}
            className={cn("rounded-md px-3 py-1 text-[13px] font-medium transition-colors duration-150", status === s ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}>{s === "open" ? "Open" : "All"}</button>
        ))}
      </div>
      {q.isPending ? <Skeleton className="h-40 rounded-xl" /> : q.error ? <Card className="p-6 text-sm text-muted">{q.error.message}</Card> : !q.data.length ? (
        <EmptyState icon={<IconShieldCheck />} title={status === "open" ? "Nothing to review" : "No reports yet"} body="New reports show here and are mailed to the support inbox." />
      ) : (
        <ul className="space-y-3" data-testid="moderation-queue">
          {q.data.map((r) => (
            <li key={r.id}>
              <Card className="space-y-3 p-4" data-testid="moderation-report">
                <div className="flex flex-wrap items-center gap-2">
                  <IconFlag className="h-4 w-4 text-bad" aria-hidden />
                  <span className="text-[14px] font-semibold">{REASON[r.reason] ?? r.reason}</span>
                  <Badge tone="neutral">{r.targetType === "message" ? (CONTEXT[r.context ?? "chat"] ?? "Message") : "Person"}</Badge>
                  {r.status === "open" ? <Badge tone={ageTone(r.ageHours)}>{r.ageHours < 1 ? "Under an hour" : `${r.ageHours} h`}</Badge>
                    : <Badge tone="neutral">{r.status === "dismissed" ? "Dismissed" : r.action === "message_removed" ? "Message removed" : r.action === "user_suspended" ? "Suspended" : "Resolved"}</Badge>}
                  <time className="ml-auto text-[12px] text-subtle" dateTime={r.createdAt}>{timeAgo(r.createdAt)}</time>
                </div>
                {r.snapshotText !== null && <blockquote className="whitespace-pre-wrap break-words rounded-lg border-l-2 border-line-strong bg-fill px-3 py-2 text-[13.5px]">{r.snapshotText || "(no text)"}</blockquote>}
                {r.note && <p className="text-[13px] text-muted"><span className="font-medium text-fg">Reporter's note:</span> {r.note}</p>}
                <dl className="grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2">
                  <div><dt className="inline text-subtle">Reported: </dt><dd className="inline">{r.target ? `${r.target.name ?? "Unknown"} (${r.target.email ?? "no email"})${r.target.suspended ? ", suspended" : ""}` : "Unknown"}</dd></div>
                  <div><dt className="inline text-subtle">By: </dt><dd className="inline">{r.reporter.name ?? "Unknown"} ({r.reporter.email ?? "no email"})</dd></div>
                </dl>
                {r.resolutionNote && <p className="text-[12.5px] text-muted">Note: {r.resolutionNote}</p>}
                {r.status === "open" && (
                  <div className="flex flex-wrap gap-2">
                    {r.messageId && <Button size="sm" variant="danger" loading={busy === r.id + "remove_message"} onClick={() => void act(r, "remove_message")}>Remove message</Button>}
                    {r.target && !r.target.suspended && <Button size="sm" variant="danger" loading={busy === r.id + "suspend_user"} onClick={() => void act(r, "suspend_user")}>Suspend user</Button>}
                    <Button size="sm" variant="secondary" onClick={() => setResolving(r)}>Resolve with a note</Button>
                    <Button size="sm" variant="ghost" loading={busy === r.id + "dismiss"} onClick={() => void act(r, "dismiss")} data-testid="report-dismiss">Dismiss</Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <PromptDialog open={!!resolving} onClose={() => setResolving(null)} title="Resolve report" label="What did you do?" multiline confirmLabel="Resolve"
        onSubmit={(note: string) => { const r = resolving; setResolving(null); if (r) void act(r, "resolve", note); }} />
    </div>
  );
}

/** The operator console's link to the queue, with the open count. */
export function ModerationLink() {
  const n = useOpenReportCount(true);
  const open = n.data ?? 0;
  return (
    <Link to="/app/admin/reports" data-testid="moderation-link" className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card transition-colors duration-150 hover:bg-hover">
      <IconFlag className={cn("h-5 w-5", open ? "text-bad" : "text-muted")} aria-hidden />
      <span className="flex-1"><span className="block text-[14px] font-semibold">Moderation</span><span className="block text-[12.5px] text-muted">{open ? `${open} report${open === 1 ? "" : "s"} to review within 24 hours` : "No open reports"}</span></span>
      {open > 0 && <span className="rounded-full bg-bad px-2 text-[12px] font-semibold tabular-nums text-white">{open}</span>}
    </Link>
  );
}

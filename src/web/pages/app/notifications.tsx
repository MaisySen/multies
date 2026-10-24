/** The notifications inbox: mentions, assignments, comments, approvals and due-soon items in one place. */
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Card, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";

export type NotificationCategory = "mention" | "assignment" | "comment" | "approval" | "due_soon" | "chat" | "email" | "status";
export interface InboxItem { id: string; type: string; category: NotificationCategory; entityType: string; entityId: string; title: string; actor: { name: string } | null; read: boolean; createdAt: string; link: string }
interface InboxPage { notifications: InboxItem[]; unread: number; counts: Record<NotificationCategory, number>; hasMore: boolean }

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  mention: "Mentions", assignment: "Assigned to me", comment: "Comments and replies", approval: "Approvals", due_soon: "Due soon", chat: "Direct messages", email: "Mail on tasks", status: "Status changes",
};
const FILTERS: (NotificationCategory | "all")[] = ["all", "mention", "assignment", "comment", "approval", "due_soon", "chat", "email", "status"];

export function useUnreadNotifications(enabled: boolean) {
  return useQuery({ queryKey: ["notifications", "count"], enabled, refetchInterval: 30_000, queryFn: async () => (await api.get<InboxPage>("/notifications?limit=1")).unread });
}

export function NotificationsPage() {
  const [filter, setFilter] = useState<NotificationCategory | "all">("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["notifications", filter, unreadOnly], refetchInterval: 30_000,
    queryFn: () => api.get<InboxPage>(`/notifications?limit=100${filter !== "all" ? `&category=${filter}` : ""}${unreadOnly ? "&unread=1" : ""}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["notifications"] });
  const markAll = async () => { try { await api.post("/notifications/read", filter === "all" ? {} : { category: filter }); await refresh(); } catch (e) { showError(e as Error); } };
  const open = async (n: InboxItem) => {
    if (!n.read) { try { await api.post("/notifications/read", { ids: [n.id] }); void refresh(); } catch { /* opening still works */ } }
    navigate(n.link);
  };
  const toggle = async (n: InboxItem) => {
    try { await (n.read ? api.post(`/notifications/${n.id}/unread`, {}) : api.post("/notifications/read", { ids: [n.id] })); await refresh(); } catch (e) { showError(e as Error); }
  };
  const counts = q.data?.counts;
  return (
    <div>
      <PageHeader title="Notifications" description="Mentions, work assigned to you, comments, approvals and anything due soon, in one place."
        actions={<div className="flex gap-2"><Link to="/app/settings/notifications" className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] text-muted hover:bg-elevated hover:text-fg">Settings</Link>
          <Button size="sm" variant="secondary" onClick={markAll} disabled={!q.data?.unread}><CheckCheck className="h-4 w-4" />Mark all read</Button></div>} />
      <div className="mb-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter notifications">
        {FILTERS.map((f) => (
          <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
            className={cn("rounded-full border px-3 py-1 text-[12.5px]", filter === f ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-line-strong hover:text-fg")}>
            {f === "all" ? "All" : CATEGORY_LABELS[f]}{f === "all" ? (q.data?.unread ? ` ${q.data.unread}` : "") : counts?.[f] ? ` ${counts[f]}` : ""}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-[13px] text-muted"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />Unread only</label>
      </div>
      {q.isPending ? <Skeleton className="h-64" /> : !q.data?.notifications.length ? (
        <EmptyState icon={<Bell />} title="You're all caught up" body="When someone mentions you, assigns you work or needs an approval, it shows here." />
      ) : (
        <Card className="p-0">
          <ul data-testid="notifications-list">
            {q.data.notifications.map((n) => (
              <li key={n.id} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-0">
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-brand")} aria-hidden />
                <button onClick={() => void open(n)} className="min-w-0 flex-1 text-left">
                  <span className={cn("block text-[14px]", !n.read && "font-semibold")}>{n.title}</span>
                  <span className="text-[12px] text-subtle">{CATEGORY_LABELS[n.category]} · {timeAgo(n.createdAt)}{n.read ? "" : " · unread"}</span>
                </button>
                <Button variant="ghost" size="sm" onClick={() => void toggle(n)}>{n.read ? "Mark unread" : "Mark read"}</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Settings, Notifications: per category, show in the inbox and push to my phone. */
export function NotificationSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["notifications", "settings"], queryFn: async () => (await api.get<{ settings: Record<NotificationCategory, { inApp: boolean; push: boolean }> }>("/notifications/settings")).settings });
  const save = async (c: NotificationCategory, patch: { inApp?: boolean; push?: boolean }) => {
    try { const r = await api.put<{ settings: Record<NotificationCategory, { inApp: boolean; push: boolean }> }>("/notifications/settings", { settings: { [c]: patch } }); qc.setQueryData(["notifications", "settings"], r.settings); }
    catch (e) { showError(e as Error); }
  };
  return (
    <div className="space-y-4">
      <div><h2 className="text-[15px] font-semibold">Notifications</h2><p className="text-[13.5px] text-muted">Choose what shows in your inbox and what buzzes your phone. Phone alerts carry no message text, only what to open.</p></div>
      {q.isPending ? <Skeleton className="h-64" /> : (
        <Card className="p-0">
          <table className="w-full text-[13.5px]" data-testid="notification-settings">
            <thead className="border-b border-line text-left text-[12px] text-subtle"><tr><th className="px-4 py-2 font-medium">Category</th><th className="px-4 py-2 font-medium">In the inbox</th><th className="px-4 py-2 font-medium">Phone</th></tr></thead>
            <tbody>
              {(Object.keys(CATEGORY_LABELS) as NotificationCategory[]).map((c) => (
                <tr key={c} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">{CATEGORY_LABELS[c]}</td>
                  <td className="px-4 py-2.5"><Switch label={`${CATEGORY_LABELS[c]} in the inbox`} checked={q.data?.[c]?.inApp ?? true} onChange={(v) => void save(c, { inApp: v })} /></td>
                  <td className="px-4 py-2.5"><Switch label={`${CATEGORY_LABELS[c]} on my phone`} checked={q.data?.[c]?.push ?? true} onChange={(v) => void save(c, { push: v })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

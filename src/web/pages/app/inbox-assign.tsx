/**
 * Round 22 (R22.1 and R22.5) in the shared inbox: list views (All, Mine, Unassigned, Assigned to a
 * person, Done), the assignee on each row, the Assign menu and Mark done in the thread header, and the
 * Reply times card. inbox.tsx only mounts these; the data comes from /api/agents/threads?view= and /api/threads.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAssign, IconChart, IconCheck, IconCheckCircle, IconCircleDot, IconHourglass, IconUserMinus, IconUserRound } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { useMe, useTeam } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { Avatar, Card } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";

export type InboxView = "open" | "mine" | "unassigned" | "assigned" | "waiting" | "done";
export type ThreadStatus = "open" | "waiting" | "done";
export interface ThreadAssignee { id: string; name: string }
interface ThreadStateOut { threadId: string; status: ThreadStatus; assignee: ThreadAssignee | null; assignedAt: string | null; doneAt: string | null }
interface StatsRow { key: string; label: string | null; type: string; threads: number; replied: number; medianFirstResponseMs: number | null; medianResolutionMs: number | null; resolved: number }
interface Stats { from: string; to: string; sampled: boolean; threadsScanned: number; rows: StatsRow[]; total: StatsRow | null }

const KEY = "multies.inbox.view";
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/** "2h 15m", "45m", "3d 4h". Calendar time. */
export function formatDuration(ms: number | null | undefined) {
  if (ms == null) return "None yet";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "Under 1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Which view the list shows, kept for the session; query is the string to append to /agents/threads. */
export function useInboxView() {
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { view: InboxView; assignee: string | null } | null; } catch { return null; } })();
  const [state, setState] = useState<{ view: InboxView; assignee: string | null }>(saved ?? { view: "open", assignee: null });
  const [stats, setStats] = useState(false);
  const set = (view: InboxView, assignee: string | null = null) => {
    const next = { view, assignee };
    setState(next);
    try { sessionStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };
  const query = `?view=${state.view}${state.view === "assigned" && state.assignee ? `&assignee=${encodeURIComponent(state.assignee)}` : ""}`;
  return { ...state, set, query, stats, setStats };
}

/** The segmented control above the thread list, plus the Reply times toggle and card. */
export function InboxViewBar({ view, assignee, set, stats, setStats }: ReturnType<typeof useInboxView>) {
  const team = useTeam();
  const people = (team.data?.members ?? []).filter((m) => m.kind === "human");
  const seg = (v: InboxView, label: string) => (
    <button type="button" onClick={() => set(v)} aria-pressed={view === v}
      className={cn("h-7 rounded-md px-3 text-[13px] font-medium transition-colors", view === v ? "bg-elevated text-fg shadow-sm" : "text-muted hover:text-fg")}>{label}</button>
  );
  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Thread view" className="inline-flex items-center gap-0.5 rounded-lg bg-fill p-0.5" data-testid="inbox-views">
          {seg("open", "All")}
          {seg("mine", "Mine")}
          {seg("unassigned", "Unassigned")}
          <select aria-label="Assigned to" value={view === "assigned" && assignee ? assignee : ""} onChange={(e) => e.target.value ? set("assigned", e.target.value) : set("open")}
            className={cn("h-7 rounded-md bg-transparent px-2 text-[13px] font-medium outline-none", view === "assigned" ? "bg-elevated text-fg shadow-sm" : "text-muted hover:text-fg")}>
            <option value="">Assigned to...</option>
            {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
          </select>
          {seg("waiting", "Waiting")}
          {seg("done", "Done")}
        </div>
        <Button variant={stats ? "secondary" : "ghost"} size="sm" className="ml-auto" onClick={() => setStats(!stats)} aria-pressed={stats}>
          <IconChart className="h-4 w-4" aria-hidden />Reply times
        </Button>
      </div>
      {stats && <ReplyTimesCard />}
    </div>
  );
}

/** R22.5: how long the customer has waited since their last message: "45m", "2h", "3d". */
export function formatAge(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * The assignee on a thread row: initials in a circle, or nothing when unassigned. Open rows also show the
 * age since the last inbound message (amber after 24 hours); waiting rows an hourglass. Worked out on read.
 */
export function AssigneeChip({ assignee, status, lastInboundAt }: { assignee?: ThreadAssignee | null; status?: ThreadStatus; lastInboundAt?: string | null }) {
  const ageMs = (status ?? "open") === "open" && lastInboundAt ? Date.now() - new Date(lastInboundAt).getTime() : null;
  const chip = !!assignee || status === "done" || status === "waiting";
  if (!chip && ageMs == null) return null;
  return (
    <span className="ml-auto inline-flex items-center gap-1.5">
      {ageMs != null && <span data-testid="thread-age" title="Since the customer last wrote" className={cn("text-[11px] font-medium tabular-nums", ageMs >= 86_400_000 ? "text-[#B25000]" : "text-subtle")}>{formatAge(ageMs)}</span>}
      {chip && (
        <span className="inline-flex items-center gap-1.5" data-testid="thread-assignee">
          {status === "waiting" && <IconHourglass className="h-3.5 w-3.5 text-subtle" aria-label="Waiting on the customer" />}
          {status === "done" && <IconCheckCircle className="h-3.5 w-3.5 text-ok" aria-label="Done" />}
          {assignee && <span title={`Assigned to ${assignee.name}`}><Avatar label={initials(assignee.name)} className="h-5 w-5 text-[9px]" /><span className="sr-only">Assigned to {assignee.name}</span></span>}
        </span>
      )}
    </span>
  );
}

/** The thread header controls: the Assign menu and Mark done or Reopen. */
export function ThreadAssignControls({ threadId }: { threadId: string }) {
  const qc = useQueryClient();
  const me = useMe();
  const q = useQuery({ queryKey: ["thread-state", threadId], queryFn: () => api.get<{ state: ThreadStateOut; members: { id: string; name: string; email: string; agent: boolean }[] }>(`/threads/${threadId}/state`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["thread-state", threadId] });
    qc.invalidateQueries({ queryKey: ["team-inbox"] });
    qc.invalidateQueries({ queryKey: ["my-work"] });
  };
  const assign = useMutation({
    mutationFn: (userId: string | null) => api.post<{ state: ThreadStateOut }>(`/threads/${threadId}/assign`, { userId }),
    onSuccess: (r) => { refresh(); toast.success(r.state.assignee ? `Assigned to ${r.state.assignee.name}` : "Unassigned"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const status = useMutation({
    mutationFn: (s: ThreadStatus) => api.post<{ state: ThreadStateOut }>(`/threads/${threadId}/status`, { status: s }),
    onSuccess: (r) => { refresh(); toast.success(r.state.status === "done" ? "Marked done" : r.state.status === "waiting" ? "Waiting on the customer" : "Reopened"); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!q.data) return null;
  const { state, members } = q.data;
  const myId = me.data?.user.id;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5" data-testid="thread-assign">
      <Menu trigger={
        <Button variant="outline" size="sm" loading={assign.isPending} aria-label={state.assignee ? `Assigned to ${state.assignee.name}. Change` : "Assign"}>
          {state.assignee ? <><Avatar label={initials(state.assignee.name)} className="h-5 w-5 text-[9px]" />{state.assignee.name}</> : <><IconAssign className="h-4 w-4" aria-hidden />Assign</>}
        </Button>
      }>
        {myId && state.assignee?.id !== myId && members.some((m) => m.id === myId) && <MenuItem icon={<IconUserRound />} onSelect={() => assign.mutate(myId)}>Assign to me</MenuItem>}
        <MenuLabel>People who can open this thread</MenuLabel>
        {members.map((m) => (
          <MenuItem key={m.id} icon={state.assignee?.id === m.id ? <IconCheck /> : <Avatar label={initials(m.name)} className="h-4 w-4 text-[8px]" />} onSelect={() => assign.mutate(m.id)}>{m.name}</MenuItem>
        ))}
        {state.assignee && <MenuItem icon={<IconUserMinus />} onSelect={() => assign.mutate(null)}>Unassign</MenuItem>}
      </Menu>
      {state.status === "open"
        ? <Button variant="ghost" size="sm" disabled={status.isPending} onClick={() => status.mutate("waiting")} title="We replied; the customer has the ball. New mail from them reopens it."><IconHourglass className="h-4 w-4" aria-hidden />Waiting</Button>
        : <Button variant="ghost" size="sm" disabled={status.isPending} onClick={() => status.mutate("open")}><IconCircleDot className="h-4 w-4" aria-hidden />Reopen</Button>}
      {state.status !== "done" && <Button variant="secondary" size="sm" loading={status.isPending} onClick={() => status.mutate("done")}><IconCheckCircle className="h-4 w-4" aria-hidden />Mark done</Button>}
    </div>
  );
}

/** Reply times over the last 30 days, per mailbox or per person. Worked out on read. */
export function ReplyTimesCard() {
  const [groupBy, setGroupBy] = useState<"mailbox" | "person">("mailbox");
  const q = useQuery({ queryKey: ["reply-stats", groupBy], queryFn: () => api.get<Stats>(`/threads/stats/replies?groupBy=${groupBy}`) });
  const rows = q.data?.rows ?? [];
  return (
    <Card className="p-0" data-testid="reply-times">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold text-fg">Reply times</h2>
        <span className="text-xs text-subtle">Last 30 days, calendar hours{q.data?.sampled ? `, newest ${q.data.threadsScanned} threads` : ""}</span>
        <div role="group" aria-label="Group by" className="ml-auto inline-flex rounded-lg bg-fill p-0.5">
          {(["mailbox", "person"] as const).map((g) => (
            <button key={g} type="button" onClick={() => setGroupBy(g)} aria-pressed={groupBy === g}
              className={cn("h-6 rounded-md px-2.5 text-xs font-medium", groupBy === g ? "bg-elevated text-fg shadow-sm" : "text-muted hover:text-fg")}>{g === "mailbox" ? "By mailbox" : "By person"}</button>
          ))}
        </div>
      </div>
      {q.isPending ? <p className="px-4 py-3 text-[13px] text-muted">Working it out...</p>
        : q.error ? <p className="px-4 py-3 text-[13px] text-bad">{q.error.message}</p>
        : !rows.length ? <p className="px-4 py-3 text-[13px] text-muted">No mail came in over the last 30 days.</p>
        : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-xs text-subtle">
                <th className="px-4 py-2 font-medium">{groupBy === "mailbox" ? "Mailbox" : "Person"}</th>
                <th className="px-2 py-2 text-right font-medium">Threads</th>
                <th className="px-2 py-2 text-right font-medium">Median first reply</th>
                <th className="px-4 py-2 text-right font-medium">Median to done</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...rows, ...(q.data?.total && rows.length > 1 ? [q.data.total] : [])].map((r) => (
                <tr key={r.key} className={cn(r.key === "all" && "font-semibold")}>
                  <td className="max-w-[16rem] truncate px-4 py-2 text-fg">{r.label ?? "Unknown"}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{r.threads}</td>
                  <td className="px-2 py-2 text-right tabular-nums" data-testid="median-first">{formatDuration(r.medianFirstResponseMs)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatDuration(r.medianResolutionMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Card>
  );
}

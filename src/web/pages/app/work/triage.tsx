/**
 * Triage (round 21, R21.3): new work from mail rules, public forms, incoming hooks and the API waits
 * here until someone accepts it as a task, declines it or merges it into an existing task.
 * Keys: j and k move, a accepts, d declines, h snoozes, m marks a duplicate, o opens, x selects for bulk.
 * R32: snooze (Queue and Snoozed views), a status pick on accept, a project filter, optimistic actions with Undo.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconAgent, IconCheck, IconClipboardList, IconClock, IconClose, IconCode, IconCopy, IconExternalLink, IconInbox, IconMail, IconMessageCircle, IconSearch, IconTodo } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Card, EmptyState, Kbd, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { timeAgo } from "@/web/lib/format";
import { showError } from "@/web/lib/show-error";
import { useAssignees, useProjects, type Task } from "./data";
import { TriageCommentBar, type CommentMode } from "./triage-comment-r33";
import { LoadError } from "@/web/components/load-error-t1g";

type TriageSource = "mail" | "form" | "api" | "chat" | "agent";
type TriageItem = Task & { triage: { state: "pending"; source: TriageSource | null; from: string | null; snoozedUntil?: string | null } | null };
type View = "pending" | "snoozed";

const SOURCE = {
  mail: { label: "Mail", icon: IconMail },
  form: { label: "Form", icon: IconClipboardList },
  api: { label: "API", icon: IconCode },
  chat: { label: "Chat", icon: IconMessageCircle },
  agent: { label: "Agent", icon: IconAgent },
} as const;

const fromName = (from: string | null | undefined) => (from ? from.replace(/\s*<[^>]+>\s*$/, "").trim() || from : "");
const listKey = (view: View, projectId: string) => ["triage", "list", view, projectId] as const;

function useTriage(view: View, projectId: string) {
  const qs = new URLSearchParams({ ...(view === "snoozed" ? { view } : {}), ...(projectId ? { projectId } : {}) }).toString();
  return useQuery({ queryKey: listKey(view, projectId), queryFn: () => api.get<{ items: TriageItem[]; count: number }>(`/triage${qs ? `?${qs}` : ""}`), refetchInterval: 30_000 });
}

/** R32: the first open status of a project (the default when accepting). */
export function firstOpenStatus(statuses: { id: string; category: string; position: number }[] | undefined) {
  const sorted = [...(statuses ?? [])].sort((a, b) => a.position - b.position);
  return (sorted.find((s) => s.category === "todo") ?? sorted[0])?.id ?? "";
}

export function TriagePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "snoozed" ? "snoozed" : "pending";
  const filterProject = params.get("project") ?? "";
  const q = useTriage(view, filterProject);
  const projects = useProjects();
  const assignees = useAssignees();
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [projectId, setProjectId] = useState("");
  const [statusId, setStatusId] = useState("");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [merging, setMerging] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  // R33: A / D open a one line comment under the item; Enter confirms, Esc cancels.
  const [commenting, setCommenting] = useState<CommentMode | null>(null);
  const current = items[Math.min(cursor, Math.max(items.length - 1, 0))] as TriageItem | undefined;
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "";
  const statuses = projects.data?.find((p) => p.id === projectId)?.statuses ?? [];

  useEffect(() => { if (current) { setProjectId(current.projectId); setAssignee(current.assigneeId ?? ""); } }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setStatusId(firstOpenStatus(projects.data?.find((p) => p.id === projectId)?.statuses)); }, [projectId, projects.data]);

  const setParam = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ["triage"] }), qc.invalidateQueries({ queryKey: ["tasks"] }), qc.invalidateQueries({ queryKey: ["projects"] })]);
  };
  /** Optimistic: the item leaves the list at once; it comes back if the server says no. */
  const drop = (id: string) => {
    const key = listKey(view, filterProject);
    const prev = qc.getQueryData<{ items: TriageItem[]; count: number }>(key);
    if (prev) qc.setQueryData(key, { ...prev, items: prev.items.filter((t) => t.id !== id), count: Math.max(0, prev.count - (view === "pending" ? 1 : 0)) });
    return () => { if (prev) qc.setQueryData(key, prev); };
  };
  const undo = async (it: TriageItem, kind: "restore" | "unsnooze", commentId?: string) => {
    try { await api.post(`/triage/${it.id}/action`, { action: kind, ...(commentId ? { commentId } : {}) }); toast.success(`${it.ref} is back in Triage`); await refresh(); } catch (e) { showError(e as Error); }
  };
  const act = async (it: TriageItem, body: Record<string, unknown>, done: string, undoKind: "restore" | "unsnooze") => {
    const rollback = drop(it.id);
    setBusy(true);
    try {
      const r = await api.post<{ comment?: { id: string } }>(`/triage/${it.id}/action`, body);
      // R33: one Undo takes back the status change and the comment written with it.
      const commentId = r?.comment?.id;
      toast.success(done, { id: "triage-undo", action: { label: "Undo", onClick: () => void undo(it, undoKind, commentId) } });
      await refresh();
    } catch (e) { rollback(); showError(e as Error); } finally { setBusy(false); }
  };
  const accept = (it: TriageItem, comment?: string) => act(it, {
    action: "accept",
    ...(comment ? { comment } : {}),
    accept: {
      ...(projectId && projectId !== it.projectId ? { projectId } : {}),
      ...(statusId ? { statusId } : {}),
      ...(assignee !== (it.assigneeId ?? "") ? { assignee: assignee || null } : {}),
    },
  }, comment ? `${it.ref} is now a task, with your comment` : `${it.ref} is now a task`, "restore");
  const declineWith = (it: TriageItem, comment: string) => act(it, { action: "decline", ...(comment ? { comment } : {}) }, comment ? `${it.ref} declined, with your comment` : `${it.ref} declined`, "restore");
  const submitComment = (comment: string) => {
    if (!current || !commenting) return;
    const mode = commenting;
    setCommenting(null);
    void (mode === "accept" ? accept(current, comment) : declineWith(current, comment));
  };
  const snooze = (it: TriageItem, until: string) => act(it, { action: "snooze", until }, `Snoozed until ${new Date(until).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`, "unsnooze");
  const bulk = async (action: "accept" | "decline") => {
    setBusy(true);
    try {
      const r = await api.post<{ done: number; failed: number }>("/triage/bulk", { ids: [...selected], action });
      setSelected(new Set());
      if (r.failed) toast.error(`${r.failed} could not be changed.`);
      toast.success(action === "accept" ? "Accepted" : "Declined");
      await refresh();
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const open = (it: TriageItem) => navigate(`/app/tasks?task=${it.id}`);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || declining || merging || snoozing || busy || commenting) return;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === "j") { e.preventDefault(); setCursor((c) => Math.min(c + 1, items.length - 1)); }
      else if (k === "k") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
      else if (!current) return;
      else if (k === "a") { e.preventDefault(); setCommenting("accept"); }
      else if (k === "d" && e.shiftKey) { e.preventDefault(); setDeclining(true); }
      else if (k === "d") { e.preventDefault(); setCommenting("decline"); }
      else if (k === "h") { e.preventDefault(); if (view === "snoozed") void act(current, { action: "unsnooze" }, `${current.ref} is back in Triage`, "unsnooze"); else setSnoozing(true); }
      else if (k === "m") { e.preventDefault(); setMerging(true); }
      else if (k === "o" || e.key === "Enter") { e.preventDefault(); open(current); }
      else if (k === "x") { e.preventDefault(); setSelected((s) => { const n = new Set(s); if (n.has(current.id)) n.delete(current.id); else n.add(current.id); return n; }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div>
      <PageHeader title="Triage" description="New tasks from mail, forms, the API and agents wait here until you accept, decline, snooze or mark them as a duplicate."
        actions={<span className="hidden items-center gap-1.5 text-xs text-subtle md:inline-flex"><Kbd>J</Kbd><Kbd>K</Kbd> move <Kbd>A</Kbd> accept <Kbd>D</Kbd> decline <Kbd>H</Kbd> snooze <Kbd>M</Kbd> duplicate <Kbd>O</Kbd> open</span>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Triage views" className="inline-flex rounded-lg bg-fill p-0.5">
          {(["pending", "snoozed"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => { setParam("view", v === "pending" ? "" : v); setCursor(0); }}
              className={cn("rounded-md px-3 py-1 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand", view === v ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}>
              {v === "pending" ? "Queue" : "Snoozed"}
            </button>
          ))}
        </div>
        <Select className="w-auto min-w-[10rem]" value={filterProject} onChange={(e) => { setParam("project", e.target.value); setCursor(0); }} aria-label="Filter by project">
          <option value="">All projects</option>
          {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>
      {q.isPending ? <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"><Skeleton className="h-72" /><Skeleton className="h-72" /></div> : q.isError ? (
        <LoadError onRetry={() => q.refetch()} />
      ) : !items.length ? (
        view === "snoozed"
          ? <EmptyState icon={<IconClock />} title="Nothing snoozed" body="Items you snooze wait here and come back to the queue on the day you pick." />
          : <EmptyState icon={<IconTodo />} title="Triage is clear" body={<>New tasks from mail, forms, the API and agents land here when a project uses Triage. Turn it on in a project's settings, or with Send to triage on a <Link to="/app/forms" className="text-brand-hover hover:underline">form</Link>.</>} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Card className="p-0">
            <div className="flex h-11 items-center gap-2 border-b border-line px-4">
              <span className="text-[13px] font-semibold text-fg">{items.length} {view === "snoozed" ? "snoozed" : "waiting"}</span>
              {selected.size > 0 && (
                <div className="ml-auto flex items-center gap-1.5" data-testid="triage-bulk">
                  <span className="text-xs text-muted">{selected.size} selected</span>
                  <Button size="sm" variant="secondary" onClick={() => bulk("accept")} disabled={busy}>Accept</Button>
                  <Button size="sm" variant="secondary" onClick={() => bulk("decline")} disabled={busy}>Decline</Button>
                </div>
              )}
            </div>
            <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto" aria-label="Triage items" data-testid="triage-list">
              {items.map((it, i) => {
                const S = SOURCE[it.triage?.source ?? "api"] ?? SOURCE.api;
                const active = current?.id === it.id;
                return (
                  <li key={it.id} aria-current={active ? "true" : undefined} data-testid="triage-row"
                    className={cn("flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors duration-150 motion-reduce:transition-none", active ? "bg-brand/[0.07]" : "hover:bg-hover")}
                    onClick={() => setCursor(i)}>
                    <input type="checkbox" aria-label={`Select ${it.title}`} className="mt-1 h-4 w-4 accent-[var(--color-brand)]" checked={selected.has(it.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(it.id); else n.delete(it.id); return n; })} />
                    <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full", active ? "bg-brand text-white" : "bg-fill text-muted")} title={S.label}><S.icon className="h-3.5 w-3.5" aria-hidden /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-[13.5px] font-medium text-fg">{fromName(it.triage?.from) || S.label}</span>
                        <span className="ml-auto shrink-0 text-[11.5px] text-subtle">{view === "snoozed" && it.triage?.snoozedUntil ? `Back ${new Date(it.triage.snoozedUntil).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : timeAgo(it.createdAt)}</span>
                      </span>
                      <span className="block truncate text-[13px] text-fg/90">{it.title}</span>
                      <span className="block truncate text-xs text-subtle">{projectName(it.projectId)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>

          {current && (
            <Card className="p-0" data-testid="triage-preview">
              <div className="border-b border-line px-5 py-4">
                <div className="flex items-center gap-2 text-xs text-subtle">
                  <span>{current.ref}</span><span aria-hidden>·</span><span>{(SOURCE[current.triage?.source ?? "api"] ?? SOURCE.api).label}</span><span aria-hidden>·</span><span>{timeAgo(current.createdAt)}</span>
                </div>
                <h2 className="mt-1 text-[19px] font-semibold leading-snug text-fg">{current.title}</h2>
                {current.triage?.from && <p className="mt-1 text-[13px] text-muted">From {current.triage.from}</p>}
              </div>
              <div className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap px-5 py-4 text-[14px] leading-relaxed text-fg/90">{current.notes || <span className="text-muted">No details.</span>}</div>
              <div className="grid gap-3 border-t border-line px-5 py-4 sm:grid-cols-3">
                <label className="text-xs font-medium text-muted">Project
                  <Select className="mt-1" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
                    {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </label>
                <label className="text-xs font-medium text-muted">Status
                  <Select className="mt-1" value={statusId} onChange={(e) => setStatusId(e.target.value)} aria-label="Status">
                    {[...statuses].sort((a, b) => a.position - b.position).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </label>
                <label className="text-xs font-medium text-muted">Assignee
                  <Select className="mt-1" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
                    <option value="">Nobody yet</option>
                    {(assignees.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}{a.type === "agent" ? " (agent)" : ""}</option>)}
                  </Select>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4">
                <Button onClick={() => accept(current)} disabled={busy}><IconCheck className="h-4 w-4" />{assignee && assignee !== (current.assigneeId ?? "") ? "Accept and assign" : "Accept"}</Button>
                {view === "snoozed"
                  ? <Button variant="secondary" onClick={() => act(current, { action: "unsnooze" }, `${current.ref} is back in Triage`, "unsnooze")} disabled={busy}><IconInbox className="h-4 w-4" />Back to queue</Button>
                  : <Button variant="secondary" onClick={() => setSnoozing(true)} disabled={busy}><IconClock className="h-4 w-4" />Snooze</Button>}
                <Button variant="secondary" onClick={() => setMerging(true)} disabled={busy}><IconCopy className="h-4 w-4" />Duplicate</Button>
                <Button variant="ghost" onClick={() => open(current)} disabled={busy}><IconExternalLink className="h-4 w-4" />Open</Button>
                <Button variant="ghost" className="ml-auto text-bad" onClick={() => setDeclining(true)} disabled={busy}><IconClose className="h-4 w-4" />Decline</Button>
              </div>
              {commenting && <TriageCommentBar key={`${current.id}-${commenting}`} mode={commenting} busy={busy} onSubmit={submitComment} onCancel={() => setCommenting(null)} onMore={() => { setCommenting(null); setDeclining(true); }} />}
            </Card>
          )}
        </div>
      )}
      {current && <DeclineDialog key={`d-${current.id}`} open={declining} item={current} onClose={() => setDeclining(false)} onDone={async () => { setDeclining(false); drop(current.id); await refresh(); }} onUndo={() => void undo(current, "restore")} />}
      {current && <MergeDialog key={`m-${current.id}`} open={merging} item={current} onClose={() => setMerging(false)} onDone={async () => { setMerging(false); drop(current.id); await refresh(); }} onUndo={() => void undo(current, "restore")} />}
      {current && <SnoozeDialog key={`s-${current.id}`} open={snoozing} item={current} onClose={() => setSnoozing(false)} onPick={(until) => { setSnoozing(false); void snooze(current, until); }} />}
    </div>
  );
}

/** R32: snooze presets, worked out from now (tomorrow and next Monday at 8 in the morning, local time). */
export function snoozePresets(now: Date) {
  const at8 = (d: Date) => { const x = new Date(d); x.setHours(8, 0, 0, 0); return x; };
  const tomorrow = at8(new Date(now.getTime() + 86400_000));
  const monday = at8(new Date(now)); monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  const week = at8(new Date(now.getTime() + 7 * 86400_000));
  return [{ label: "Tomorrow", until: tomorrow }, { label: "Next Monday", until: monday }, { label: "In a week", until: week }];
}

function SnoozeDialog({ open, item, onClose, onPick }: { open: boolean; item: TriageItem; onClose: () => void; onPick: (until: string) => void }) {
  const [date, setDate] = useState("");
  const presets = useMemo(() => snoozePresets(new Date()), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const min = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  return (
    <Dialog open={open} onClose={onClose} title="Snooze until" description={item.title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => date && onPick(new Date(`${date}T08:00:00`).toISOString())} disabled={!date}>Snooze</Button></>}>
      <div className="grid gap-2 sm:grid-cols-3">
        {presets.map((p) => (
          <button key={p.label} type="button" onClick={() => onPick(p.until.toISOString())}
            className="rounded-xl border border-line px-3 py-2.5 text-left transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
            <span className="block text-[13.5px] font-medium text-fg">{p.label}</span>
            <span className="block text-xs text-subtle">{p.until.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>
          </button>
        ))}
      </div>
      <label className="mt-3 block text-xs font-medium text-muted">Or pick a day
        <Input type="date" className="mt-1" min={min} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Snooze until date" />
      </label>
    </Dialog>
  );
}

function DeclineDialog({ open, item, onClose, onDone, onUndo }: { open: boolean; item: TriageItem; onClose: () => void; onDone: () => Promise<void>; onUndo: () => void }) {
  const [reason, setReason] = useState("");
  const [reply, setReply] = useState(false);
  const [busy, setBusy] = useState(false);
  const canReply = !!item.triage?.from && /@/.test(item.triage.from);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ reply: { sent: boolean; attempted?: boolean; skipped?: string } }>(`/triage/${item.id}/decline`, { reason, reply: reply && canReply });
      toast.success(r.reply.skipped === "no_reply_address" ? "Declined. No reply sent to a no-reply address." : r.reply.attempted ? "Declined and replied" : "Declined", { action: { label: "Undo", onClick: onUndo } });
      await onDone();
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Decline this item?" description={item.title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" onClick={submit} loading={busy}>Decline</Button></>}>
      <label className="block text-xs font-medium text-muted">Reason (only your team sees it)
        <Textarea className="mt-1" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Not a fit for us right now" />
      </label>
      <label className={cn("mt-3 flex items-center gap-2 text-[13px]", canReply ? "text-fg" : "text-subtle")}>
        <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={reply && canReply} disabled={!canReply} onChange={(e) => setReply(e.target.checked)} />
        {canReply ? `Send ${fromName(item.triage?.from)} a short, polite reply` : "No address to reply to"}
      </label>
    </Dialog>
  );
}

function MergeDialog({ open, item, onClose, onDone, onUndo }: { open: boolean; item: TriageItem; onClose: () => void; onDone: () => Promise<void>; onUndo: () => void }) {
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const found = useQuery({
    queryKey: ["triage", "merge-search", term], enabled: open && term.trim().length >= 2,
    // AIS1 review: search also finds items waiting in Triage; a duplicate goes into a task that isn't, and never itself.
    queryFn: async () => (await api.get<{ tasks: TriageItem[] }>(`/tasks?q=${encodeURIComponent(term.trim())}&limit=8&includeSubtasks=true`)).tasks.filter((t) => !t.triage && t.id !== item.id),
  });
  const merge = async (target: Task) => {
    setBusy(true);
    try { await api.post(`/triage/${item.id}/action`, { action: "duplicate", duplicateOf: target.id }); toast.success(`Marked a duplicate of ${target.ref}`, { action: { label: "Undo", onClick: onUndo } }); await onDone(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Duplicate of" description="Pick the task this repeats. The details become a comment there, and any mail thread moves with them.">
      <div className="relative">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input autoFocus className="pl-9" placeholder="Search tasks by title" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search tasks" />
      </div>
      <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line" data-testid="merge-results">
        {term.trim().length < 2 ? <li className="px-3 py-2.5 text-[13px] text-muted">Type at least two letters.</li>
          : found.isPending ? <li className="px-3 py-2.5 text-[13px] text-muted">Searching</li>
          : !found.data?.length ? <li className="px-3 py-2.5 text-[13px] text-muted">No tasks match.</li>
          : found.data.map((t) => (
            <li key={t.id}>
              <button type="button" disabled={busy} onClick={() => merge(t)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-hover disabled:opacity-50">
                <span className="shrink-0 text-xs text-subtle">{t.ref}</span><span className="truncate text-[13.5px] text-fg">{t.title}</span>
              </button>
            </li>
          ))}
      </ul>
    </Dialog>
  );
}

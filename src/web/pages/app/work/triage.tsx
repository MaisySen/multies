/**
 * Triage (round 21, R21.3): new work from mail rules, public forms, incoming hooks and the API waits
 * here until someone accepts it as a task, declines it or merges it into an existing task.
 * Keys: j and k move, a accepts, d declines, m merges, x selects for bulk.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ClipboardList, Code2, GitMerge, Inbox, ListTodo, Mail, MessageCircle, Search, X } from "lucide-react";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Card, EmptyState, Kbd, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { timeAgo } from "@/web/lib/format";
import { showError } from "@/web/lib/show-error";
import { useAssignees, useProjects, type Task } from "./data";

type TriageItem = Task & { triage: { state: "pending"; source: "mail" | "form" | "api" | "chat" | null; from: string | null } | null };

const SOURCE = {
  mail: { label: "Mail", icon: Mail },
  form: { label: "Form", icon: ClipboardList },
  api: { label: "API", icon: Code2 },
  chat: { label: "Chat", icon: MessageCircle },
} as const;

const fromName = (from: string | null | undefined) => (from ? from.replace(/\s*<[^>]+>\s*$/, "").trim() || from : "");

function useTriage() {
  return useQuery({ queryKey: ["triage", "list"], queryFn: () => api.get<{ items: TriageItem[]; count: number }>("/triage"), refetchInterval: 30_000 });
}

export function TriagePage() {
  const qc = useQueryClient();
  const q = useTriage();
  const projects = useProjects();
  const assignees = useAssignees();
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [projectId, setProjectId] = useState("");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [merging, setMerging] = useState(false);
  const current = items[Math.min(cursor, Math.max(items.length - 1, 0))] as TriageItem | undefined;
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "";

  useEffect(() => { if (current) { setProjectId(current.projectId); setAssignee(current.assigneeId ?? ""); } }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ["triage"] }), qc.invalidateQueries({ queryKey: ["tasks"] }), qc.invalidateQueries({ queryKey: ["projects"] })]);
  };
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); toast.success(done); await refresh(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const accept = (it: TriageItem) => run(() => api.post(`/triage/${it.id}/accept`, {
    ...(projectId && projectId !== it.projectId ? { projectId } : {}),
    ...(assignee !== (it.assigneeId ?? "") ? { assignee: assignee || null } : {}),
  }), `${it.ref} is now a task`);
  const bulk = (action: "accept" | "decline") => run(async () => {
    const r = await api.post<{ done: number; failed: number }>("/triage/bulk", { ids: [...selected], action });
    setSelected(new Set());
    if (r.failed) toast.error(`${r.failed} could not be changed.`);
  }, action === "accept" ? "Accepted" : "Declined");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || declining || merging || busy) return;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.key === "j") { e.preventDefault(); setCursor((c) => Math.min(c + 1, items.length - 1)); }
      else if (e.key === "k") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
      else if (e.key === "a" && current) { e.preventDefault(); void accept(current); }
      else if (e.key === "d" && current) { e.preventDefault(); setDeclining(true); }
      else if (e.key === "m" && current) { e.preventDefault(); setMerging(true); }
      else if (e.key === "x" && current) { e.preventDefault(); setSelected((s) => { const n = new Set(s); if (n.has(current.id)) n.delete(current.id); else n.add(current.id); return n; }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div>
      <PageHeader title="Triage" description="New work from mail, forms and the API waits here until you accept, decline or merge it."
        actions={<span className="hidden items-center gap-1.5 text-xs text-subtle md:inline-flex"><Kbd>J</Kbd><Kbd>K</Kbd> move <Kbd>A</Kbd> accept <Kbd>D</Kbd> decline <Kbd>M</Kbd> merge</span>} />
      {q.isPending ? <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"><Skeleton className="h-72" /><Skeleton className="h-72" /></div> : q.isError ? (
        <EmptyState icon={<Inbox />} title="Triage didn't load" body="Check your connection and try again in a moment." />
      ) : !items.length ? (
        <EmptyState icon={<ListTodo />} title="Nothing to triage" body={<>New mail and form tasks land here when a project has Triage on. Turn it on in a project's settings, or with Send to triage on a <Link to="/app/forms" className="text-brand-hover hover:underline">form</Link>.</>} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Card className="p-0">
            <div className="flex h-11 items-center gap-2 border-b border-line px-4">
              <span className="text-[13px] font-semibold text-fg">{items.length} waiting</span>
              {selected.size > 0 && (
                <div className="ml-auto flex items-center gap-1.5" data-testid="triage-bulk">
                  <span className="text-xs text-muted">{selected.size} selected</span>
                  <Button size="sm" variant="secondary" onClick={() => bulk("accept")} disabled={busy}>Accept</Button>
                  <Button size="sm" variant="secondary" onClick={() => bulk("decline")} disabled={busy}>Decline</Button>
                </div>
              )}
            </div>
            <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto" role="listbox" aria-label="Triage items" data-testid="triage-list">
              {items.map((it, i) => {
                const S = SOURCE[it.triage?.source ?? "api"];
                const active = current?.id === it.id;
                return (
                  <li key={it.id} role="option" aria-selected={active}
                    className={cn("flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors", active ? "bg-[#0071E3]/[0.07]" : "hover:bg-hover")}
                    onClick={() => setCursor(i)}>
                    <input type="checkbox" aria-label={`Select ${it.title}`} className="mt-1 h-4 w-4 accent-[#0071E3]" checked={selected.has(it.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(it.id); else n.delete(it.id); return n; })} />
                    <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full", active ? "bg-[#0071E3] text-white" : "bg-fill text-muted")} title={S.label}><S.icon className="h-3.5 w-3.5" aria-hidden /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-[13.5px] font-medium text-fg">{fromName(it.triage?.from) || S.label}</span>
                        <span className="ml-auto shrink-0 text-[11.5px] text-subtle">{timeAgo(it.createdAt)}</span>
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
                  <span>{current.ref}</span><span aria-hidden>·</span><span>{SOURCE[current.triage?.source ?? "api"].label}</span><span aria-hidden>·</span><span>{timeAgo(current.createdAt)}</span>
                </div>
                <h2 className="mt-1 text-[19px] font-semibold leading-snug text-fg">{current.title}</h2>
                {current.triage?.from && <p className="mt-1 text-[13px] text-muted">From {current.triage.from}</p>}
              </div>
              <div className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap px-5 py-4 text-[14px] leading-relaxed text-fg/90">{current.notes || <span className="text-muted">No details.</span>}</div>
              <div className="grid gap-3 border-t border-line px-5 py-4 sm:grid-cols-2">
                <label className="text-xs font-medium text-muted">Project
                  <Select className="mt-1" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
                    {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
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
                <Button onClick={() => accept(current)} disabled={busy}><Check className="h-4 w-4" />{assignee && assignee !== (current.assigneeId ?? "") ? "Accept and assign" : "Accept"}</Button>
                <Button variant="secondary" onClick={() => setMerging(true)} disabled={busy}><GitMerge className="h-4 w-4" />Merge</Button>
                <Button variant="ghost" className="ml-auto text-bad" onClick={() => setDeclining(true)} disabled={busy}><X className="h-4 w-4" />Decline</Button>
              </div>
            </Card>
          )}
        </div>
      )}
      {current && <DeclineDialog key={`d-${current.id}`} open={declining} item={current} onClose={() => setDeclining(false)} onDone={async () => { setDeclining(false); await refresh(); }} />}
      {current && <MergeDialog key={`m-${current.id}`} open={merging} item={current} onClose={() => setMerging(false)} onDone={async () => { setMerging(false); await refresh(); }} />}
    </div>
  );
}

function DeclineDialog({ open, item, onClose, onDone }: { open: boolean; item: TriageItem; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [reply, setReply] = useState(false);
  const [busy, setBusy] = useState(false);
  const canReply = !!item.triage?.from && /@/.test(item.triage.from);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ reply: { sent: boolean; attempted?: boolean; skipped?: string } }>(`/triage/${item.id}/decline`, { reason, reply: reply && canReply });
      toast.success(r.reply.skipped === "no_reply_address" ? "Declined. No reply sent to a no-reply address." : r.reply.attempted ? "Declined and replied" : "Declined");
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
        <input type="checkbox" className="h-4 w-4 accent-[#0071E3]" checked={reply && canReply} disabled={!canReply} onChange={(e) => setReply(e.target.checked)} />
        {canReply ? `Send ${fromName(item.triage?.from)} a short, polite reply` : "No address to reply to"}
      </label>
    </Dialog>
  );
}

function MergeDialog({ open, item, onClose, onDone }: { open: boolean; item: TriageItem; onClose: () => void; onDone: () => Promise<void> }) {
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const found = useQuery({
    queryKey: ["triage", "merge-search", term], enabled: open && term.trim().length >= 2,
    queryFn: async () => (await api.get<{ tasks: Task[] }>(`/tasks?q=${encodeURIComponent(term.trim())}&limit=8&includeSubtasks=true`)).tasks,
  });
  const merge = async (target: Task) => {
    setBusy(true);
    try { await api.post(`/triage/${item.id}/merge`, { targetId: target.id }); toast.success(`Merged into ${target.ref}`); await onDone(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Merge into a task" description="The details become a comment on the task you pick, and any mail thread moves with them.">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
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

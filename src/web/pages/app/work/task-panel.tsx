import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Bot, Calendar, CheckCircle2, Circle, FileText, Mail, MoreHorizontal, Trash2, User, X } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Avatar, Badge, Skeleton } from "@/web/components/ui/misc";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { initials, mailDate, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { PRIORITY_LABEL, useAssignees, useProjects, useTaskDetail, useTaskMutations, type ActivityEntry, type Priority, type Task } from "./data";

const VERBS: Record<string, string> = {
  created: "created the task", created_from_email: "made this task from an email", updated: "updated it", moved: "moved it", assigned: "changed the assignee",
  commented: "commented", email_received: "replied on the thread", email_sent: "replied on the thread", doc_linked: "linked a doc", deleted: "deleted it",
};
const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export function describeActivity(a: ActivityEntry) {
  if (a.verb === "moved" && a.data.status && typeof a.data.status === "object") return `moved it to ${(a.data.status as { name: string }).name}`;
  return VERBS[a.verb] ?? a.verb.replace(/_/g, " ");
}

export function TaskPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useTaskDetail(id);
  const projects = useProjects();
  const people = useAssignees();
  const { update, create, remove, refresh } = useTaskMutations();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [labels, setLabels] = useState("");
  const [comment, setComment] = useState("");
  const [sub, setSub] = useState("");
  const t = q.data?.task;
  useEffect(() => {
    if (!t) return;
    setTitle(t.title); setNotes(t.notes); setLabels(t.labels.join(", "));
  }, [t?.id, t?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  const save = (patch: Record<string, unknown>) => t && update.mutate({ id: t.id, patch }, { onSuccess: () => void q.refetch() });
  const project = projects.data?.find((p) => p.id === t?.projectId);

  const addComment = async () => {
    if (!comment.trim() || !t) return;
    try { await api.post(`/tasks/${t.id}/comments`, { body: comment }); setComment(""); await q.refetch(); refresh(); } catch (e) { showError(e as Error); }
  };
  const addSub = async () => {
    if (!sub.trim() || !t) return;
    await create.mutateAsync({ title: sub, parentId: t.id });
    setSub(""); await q.refetch();
  };
  const newDoc = async () => {
    if (!t) return;
    try {
      const r = await api.post<{ doc: { id: string } }>("/docs", { title: `${t.ref} notes`, text: "", links: [{ type: "task", id: t.id }], projectId: t.projectId });
      navigate(`/app/docs/${r.doc.id}`);
    } catch (e) { showError(e as Error); }
  };

  return (
    <aside role="dialog" aria-label="Task" className="fixed inset-0 z-40 flex flex-col bg-surface sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[520px] sm:border-l sm:border-line sm:shadow-pop">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        {t ? <span className="font-mono text-[12px] text-subtle">{t.ref}</span> : <Skeleton className="w-16" />}
        {project && <span className="truncate text-[12.5px] text-muted">in {project.name}</span>}
        <div className="ml-auto flex items-center gap-1">
          {t && (
            <Menu trigger={<button className="rounded-md p-1.5 text-muted hover:bg-elevated hover:text-fg" aria-label="More"><MoreHorizontal className="h-4 w-4" /></button>}>
              <MenuItem icon={<FileText />} onSelect={newDoc}>New doc for this task</MenuItem>
              <MenuItem icon={<Trash2 />} danger onSelect={() => remove.mutate(t.id, { onSuccess: onClose })}>Delete task</MenuItem>
            </Menu>
          )}
          <button onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-elevated hover:text-fg" aria-label="Close task"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {!t ? (
        <div className="space-y-3 p-5">{q.error ? <p className="text-sm text-muted">{(q.error as Error).message}</p> : <><Skeleton className="h-7 w-3/4" /><Skeleton className="w-1/2" /><Skeleton className="h-24" /></>}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10">
          <div className="flex items-start gap-2 pt-4">
            <button className="mt-1.5 text-muted hover:text-ok" aria-label={t.status === "done" ? "Mark as not done" : "Mark as done"} onClick={() => save({ status: t.status === "done" ? "todo" : "done" })}>
              {t.status === "done" ? <CheckCircle2 className="h-5 w-5 text-ok" /> : <Circle className="h-5 w-5" />}
            </button>
            <textarea aria-label="Title" rows={1} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== t.title && save({ title })}
              className="w-full resize-none bg-transparent text-lg font-semibold leading-snug outline-none [field-sizing:content]" />
          </div>

          <dl className="mt-4 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5 text-[13px]">
            <dt className="text-subtle">Status</dt>
            <dd><Select aria-label="Status" value={t.statusId} onChange={(e) => save({ statusId: e.target.value })} className="h-8 text-[13px]">
              {project?.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select></dd>
            <dt className="text-subtle">Assignee</dt>
            <dd><Select aria-label="Assignee" value={t.assigneeId ?? ""} onChange={(e) => save({ assignee: e.target.value || null })} className="h-8 text-[13px]">
              <option value="">Nobody</option>
              <optgroup label="People">{people.data?.filter((p) => p.type === "member").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
              <optgroup label="Agents">{people.data?.filter((p) => p.type === "agent").map((p) => <option key={p.id} value={p.id}>{p.name} (agent)</option>)}</optgroup>
            </Select></dd>
            <dt className="text-subtle">Priority</dt>
            <dd><Select aria-label="Priority" value={t.priority} onChange={(e) => save({ priority: e.target.value as Priority })} className="h-8 text-[13px]">
              {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </Select></dd>
            <dt className="text-subtle">Start</dt>
            <dd><Input type="date" aria-label="Start date" value={dateInput(t.start)} onChange={(e) => save({ start: e.target.value || null })} className="h-8 text-[13px]" /></dd>
            <dt className="text-subtle">Due</dt>
            <dd><Input type="date" aria-label="Due date" value={dateInput(t.due)} onChange={(e) => save({ due: e.target.value || null })} className="h-8 text-[13px]" /></dd>
            <dt className="text-subtle">Labels</dt>
            <dd><Input aria-label="Labels" placeholder="ops, client" value={labels} onChange={(e) => setLabels(e.target.value)}
              onBlur={() => { const next = labels.split(",").map((x) => x.trim()).filter(Boolean); if (next.join(",") !== t.labels.join(",")) save({ labels: next }); }} className="h-8 text-[13px]" /></dd>
          </dl>

          <Textarea aria-label="Notes" placeholder="Add notes" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== t.notes && save({ notes })} className="mt-4 min-h-24 text-[13.5px]" />

          {t.source && (
            <section className="mt-6" aria-label="Email thread">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle"><Mail className="h-3.5 w-3.5" />From email</h3>
                {t.source.messageId && <Link to={`/app/mail?m=${t.source.messageId}`} className="text-[12.5px] text-brand-hover hover:underline">Open thread</Link>}
              </div>
              <p className="mt-1.5 text-[13px] text-muted">{t.source.subject || "(no subject)"} · {t.source.from}</p>
              <ol className="mt-3 space-y-2">
                {q.data!.thread.map((m) => (
                  <li key={m.id} className={cn("rounded-lg border border-line p-3", m.direction === "outbound" ? "bg-white/[0.02]" : "bg-elevated/60")}>
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="font-medium text-fg">{m.from.name || m.from.address}</span>
                      {m.byAgent && <Badge tone="brand"><Bot className="h-3 w-3" />Agent</Badge>}
                      <span className="ml-auto text-subtle">{mailDate(m.date)}</span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{m.latestText.slice(0, 600) || "(no text)"}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="mt-6" aria-label="Subtasks">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Subtasks {t.subtasks.total > 0 && <span className="font-normal normal-case">{t.subtasks.done} of {t.subtasks.total}</span>}</h3>
            <ul className="mt-2 space-y-1">
              {q.data!.subtasks.map((s: Task) => (
                <li key={s.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-white/[0.03]">
                  <button aria-label={s.status === "done" ? `Mark ${s.title} as not done` : `Mark ${s.title} as done`} onClick={() => update.mutate({ id: s.id, patch: { status: s.status === "done" ? "todo" : "done" } }, { onSuccess: () => void q.refetch() })}>
                    {s.status === "done" ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <Circle className="h-4 w-4 text-muted" />}
                  </button>
                  <span className={cn("text-[13px]", s.status === "done" && "text-subtle line-through")}>{s.title}</span>
                  {s.assignee && <span className="ml-auto text-[11.5px] text-subtle">{s.assignee.name}</span>}
                </li>
              ))}
            </ul>
            <form className="mt-1.5" onSubmit={(e) => { e.preventDefault(); void addSub(); }}>
              <Input aria-label="New subtask" placeholder="Add a subtask and press Enter" value={sub} onChange={(e) => setSub(e.target.value)} className="h-8 text-[13px]" />
            </form>
          </section>

          {q.data!.docs.length > 0 && (
            <section className="mt-6" aria-label="Docs">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Docs</h3>
              <ul className="mt-2 space-y-1">{q.data!.docs.map((d) => <li key={d.id}><Link to={`/app/docs/${d.id}`} className="flex items-center gap-2 text-[13px] text-fg hover:underline"><FileText className="h-3.5 w-3.5 text-muted" />{d.title}</Link></li>)}</ul>
            </section>
          )}

          {q.data!.contacts.length > 0 && (
            <section className="mt-6" aria-label="Contacts">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Contact</h3>
              <ul className="mt-2 space-y-1">{q.data!.contacts.map((c) => <li key={c.id}><Link to={`/app/contacts/${c.id}`} className="flex items-center gap-2 text-[13px] hover:underline"><User className="h-3.5 w-3.5 text-muted" />{c.name || c.email}{c.company && <span className="text-subtle">· {c.company.name}</span>}</Link></li>)}</ul>
            </section>
          )}

          <section className="mt-6" aria-label="Comments">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Comments</h3>
            <ul className="mt-2 space-y-3">
              {q.data!.comments.map((c) => (
                <li key={c.id} className="flex gap-2.5">
                  <Avatar label={initials(c.author.name)} className="h-6 w-6 text-[10px]" />
                  <div className="min-w-0">
                    <div className="text-[12px]"><span className="font-medium">{c.author.name}</span>{c.author.type === "agent" && <span className="text-subtle"> (agent)</span>} <span className="text-subtle">{timeAgo(c.createdAt)}</span></div>
                    <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-muted">{c.body}</p>
                  </div>
                </li>
              ))}
            </ul>
            <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void addComment(); }}>
              <Input aria-label="Write a comment" placeholder="Write a comment" value={comment} onChange={(e) => setComment(e.target.value)} className="h-9 text-[13px]" />
              <Button type="submit" variant="secondary" disabled={!comment.trim()}>Send</Button>
            </form>
          </section>

          <section className="mt-6" aria-label="History">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">History</h3>
            <ul className="mt-2 space-y-1.5">
              {q.data!.activity.slice(0, 20).map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-[12.5px] text-muted">
                  {a.actor.type === "agent" ? <Bot className="h-3.5 w-3.5 text-brand-hover" /> : a.actor.type === "system" ? <Calendar className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                  <span><span className="text-fg">{a.actor.name ?? "Someone"}</span> {describeActivity(a)}</span>
                  <span className="ml-auto shrink-0 text-subtle">{timeAgo(a.at)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </aside>
  );
}

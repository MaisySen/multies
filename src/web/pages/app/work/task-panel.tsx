import { createPortal } from "react-dom";
import { useInspector } from "@/web/lib/inspector"; // R79
import { Fragment, useEffect, useRef, useState } from "react";
import { FieldInput } from "./fields";
import { taskFields } from "./computed-fields";
import { TaskFiles } from "./task-files";
import { TaskDocBacklinks } from "./doc-tree";
import { Link, useNavigate } from "react-router";
import { CatchupCard } from "@/web/components/catchup-card"; // R31
import { IconAgent, IconCalendar, IconCheckCircle, IconCircle, IconClose, IconCopy, IconDocs, IconLink, IconMail, IconMore, IconTrash, IconUser, IconVideo, IconWarning, IconMaximize, IconSidebar } from "@/web/components/ui/icon";
import { AssigneePicker, CommentBox, DescriptionEditor, TagPicker } from "./tasks-r84"; // R84
import { CommentText, ReferencesPanel } from "@/web/components/mentions-td5"; // TD5
import { TaskTime } from "./time";
import { RepeatPlus } from "./repeat-plus-r95"; // R95
import { AddToMyDay } from "./my-day-r95"; // R95
import { useConfig } from "@/web/lib/queries";
import { EpicSection, TaskTypeRows } from "./task-type";
import { SprintFields } from "./sprint-fields";
import { TaskChecklist } from "./task-checklist"; // R26 (MB-85)
import { TaskRuns } from "./task-runs"; // R27 (DF-3 slice 2)
import { useDuplicateTask, WatchButton } from "./task-watch-r27"; // R27 teardown
import { startMeeting } from "./meeting-start";
import { api, ApiError } from "@/web/lib/api";
import { announceTaskChange, mayAdopt, useTaskChanges } from "@/web/lib/task-sync-r40"; // R40 (MB-204)
import { showError } from "@/web/lib/show-error";
import { toast } from "sonner";
import { Button } from "@/web/components/ui/button";
import { Input, Select } from "@/web/components/ui/input";
import { Avatar, Badge, Skeleton } from "@/web/components/ui/misc";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { initials, mailDate, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { PRIORITY_LABEL, useAssignees, useProjects, useTaskDetail, useTaskMutations, useTasks, type ActivityEntry, type Priority, type Task } from "./data";
import { recordRecent } from "@/web/lib/palette-recents"; // R36
import { LagChip } from "./schedule-r38"; // R38: lead and lag per link
import { AskAboutButton } from "@/web/components/ask-about-td1"; // TD1

const VERBS: Record<string, string> = {
  created: "created the task", created_from_email: "made this task from an email", updated: "updated it", moved: "moved it", assigned: "changed the assignee",
  commented: "commented", email_received: "replied on the thread", email_sent: "replied on the thread", doc_linked: "linked a doc", deleted: "deleted it",
};
const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export function describeActivity(a: ActivityEntry) {
  if (a.verb === "moved" && a.data.status && typeof a.data.status === "object") return `moved it to ${(a.data.status as { name: string }).name}`;
  return VERBS[a.verb] ?? a.verb.replace(/_/g, " ");
}

/** R79: docked shows the task in the shell's resizable side panel (desktop, the person's View choice), else over the page. */
export function TaskPanel({ id, onClose, docked = false, page = false }: { id: string; onClose: () => void; docked?: boolean; /** R84: the full task page (/app/tasks/:ref), two columns. */ page?: boolean }) {
  const slot = useInspector(docked);
  const q = useTaskDetail(id);
  const projects = useProjects();
  const people = useAssignees();
  const { update, create, remove, refresh } = useTaskMutations();
  const navigate = useNavigate();
  const duplicate = useDuplicateTask(); // R27
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [sub, setSub] = useState("");
  const t = q.data?.task;
  // R36: a task you open anywhere joins "Recently opened" in the command menu (device only, no server write).
  useEffect(() => { if (t) recordRecent({ kind: "item", id: `/app/tasks?task=${t.id}`, label: `${t.ref} ${t.title}`, url: `/app/tasks?task=${t.id}`, hint: "Task" }); }, [t?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // R40 (MB-204): what the fields last showed from the server. A newer server copy replaces a field only if the
  // person has not typed in it since; otherwise their text stays and saving it reports the conflict.
  const shown = useRef<{ id: string; title: string; notes: string; titleVersion: number; notesVersion: number } | null>(null);
  const [conflict, setConflict] = useState<{ patch: { title?: string; notes?: string }; theirs: Task } | null>(null);
  useEffect(() => {
    if (!t) return;
    const prev = shown.current?.id === t.id ? shown.current : null;
    const takeTitle = !prev || mayAdopt(title, prev.title, t.title);
    const takeNotes = !prev || mayAdopt(notes, prev.notes, t.notes);
    if (takeTitle) setTitle(t.title);
    if (takeNotes) setNotes(t.notes);
    // Each field remembers the version its text is based on; a kept edit still saves against the old one.
    shown.current = {
      id: t.id, title: takeTitle ? t.title : prev!.title, notes: takeNotes ? t.notes : prev!.notes,
      titleVersion: takeTitle ? t.version : prev!.titleVersion, notesVersion: takeNotes ? t.version : prev!.notesVersion,
    };
  }, [t?.id, t?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useTaskChanges(t?.id, () => void q.refetch());

  /** Title and notes are saved against the version on screen, so an edit made elsewhere is never overwritten silently. */
  const saveText = async (patch: { title?: string; notes?: string }, version = patch.title !== undefined ? shown.current?.titleVersion : shown.current?.notesVersion) => {
    if (!t) return;
    try {
      const r = await api.patch<{ task: Task }>(`/tasks/${t.id}`, { ...patch, version });
      setConflict(null);
      announceTaskChange(t.id, r.task.version);
      refresh();
      await q.refetch();
    } catch (e) {
      const theirs = (e instanceof ApiError && e.code === "version_conflict" ? (e.details as { task?: Task } | undefined)?.task : undefined);
      if (theirs) setConflict({ patch, theirs });
      else showError(e as Error);
    }
  };
  const keepMine = () => { if (conflict) void saveText(conflict.patch, conflict.theirs.version); };
  const useTheirs = () => {
    if (!conflict) return;
    if (conflict.patch.title !== undefined) setTitle(conflict.theirs.title);
    if (conflict.patch.notes !== undefined) setNotes(conflict.theirs.notes);
    setConflict(null);
    void q.refetch();
  };

  useEffect(() => {
    if (page) return; // R84: Esc does not leave the full page
    const on = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) && !(e.target as HTMLElement | null)?.closest?.('[role="dialog"] [role="dialog"], [aria-haspopup][aria-expanded="true"]')) onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose, page]);

  const save = (patch: Record<string, unknown>) => t && update.mutate({ id: t.id, patch }, { onSuccess: () => void q.refetch() });
  const project = projects.data?.find((p) => p.id === t?.projectId);

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

  const panel = (
    <aside role={page ? "region" : docked ? "complementary" : "dialog"} aria-label={page ? (t ? `${t.ref} ${t.title}` : "Task") : docked ? "Task details" : "Task"} data-keys-pass data-testid={page ? "task-page" : docked ? "task-inspector" : undefined}
      className={page ? "flex min-h-[calc(100dvh-8rem)] flex-col rounded-xl border border-line bg-surface max-sm:-mx-4 max-sm:rounded-none max-sm:border-x-0" : docked ? "flex h-full flex-col bg-surface" : "fixed inset-0 z-40 flex flex-col bg-surface sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[520px] sm:border-l sm:border-line sm:shadow-pop"}>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        {t ? <span className="font-mono text-[12px] text-subtle">{t.ref}</span> : <Skeleton className="w-16" />}
        {project && <span className="truncate text-[12.5px] text-muted">in {project.name}</span>}
        <div className="ml-auto flex items-center gap-1">
          {t && <WatchButton taskId={t.id} />}
          {t && <AskAboutButton kind="tasks" id={t.id} title={t.title} compact />}
          {t && !page && <Link to={`/app/tasks/${t.ref}`} aria-label="Open as page" title="Open as page" data-testid="open-task-page" className="inline-flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-elevated hover:text-fg sm:h-auto sm:w-auto sm:rounded-md sm:p-1.5"><IconMaximize className="h-4 w-4" /></Link>}
          {t && page && <Link to={`/app/tasks?task=${t.id}`} aria-label="Open in side panel" title="Open in side panel" className="inline-flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-elevated hover:text-fg sm:h-auto sm:w-auto sm:rounded-md sm:p-1.5"><IconSidebar className="h-4 w-4" /></Link>}
          {t && (
            <Menu trigger={<button className="inline-flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-elevated hover:text-fg sm:h-auto sm:w-auto sm:rounded-md sm:p-1.5" aria-label="More"><IconMore className="h-4 w-4" /></button>}>
              <MenuItem icon={<IconDocs />} onSelect={newDoc}>New doc for this task</MenuItem>
              <MenuItem icon={<IconVideo />} onSelect={() => void startMeeting({ type: "task", id: t.id }, navigate)}>Start a meeting</MenuItem>
              <MenuItem icon={<IconDocs />} onSelect={() => void api.post("/templates", { kind: "task", fromTaskId: t.id }).then(() => toast.success("Saved as a task template")).catch((e: Error) => showError(e))}>Save as template</MenuItem>
              <MenuItem icon={<IconCopy />} onSelect={() => void duplicate(t.id)}>Duplicate task</MenuItem>
              <MenuItem icon={<IconTrash />} danger onSelect={() => remove.mutate(t.id, { onSuccess: onClose })}>Delete task</MenuItem>
            </Menu>
          )}
          <button onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-elevated hover:text-fg sm:h-auto sm:w-auto sm:rounded-md sm:p-1.5" aria-label={page ? "Back to tasks" : "Close task"}><IconClose className="h-4 w-4" /></button>
        </div>
      </div>
      {!t ? (
        <div className="space-y-3 p-5">{q.error ? <p className="text-sm text-muted">{(q.error as Error).message}</p> : <><Skeleton className="h-7 w-3/4" /><Skeleton className="w-1/2" /><Skeleton className="h-24" /></>}</div>
      ) : (
        page ? (
          <div className="grid gap-x-8 px-5 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[auto_1fr]">
            <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          {conflict && <ConflictBar onKeepMine={keepMine} onUseTheirs={useTheirs} />}
          <CatchupCard key={`catchup-${t.id}`} type="task" id={t.id} className="mx-0 mb-0 mt-3" />
          <div className="flex items-start gap-2 pt-4">
            <button className="mt-1.5 text-muted hover:text-ok" aria-label={t.status === "done" ? "Mark as not done" : "Mark as done"} onClick={() => save({ status: t.status === "done" ? "todo" : "done" })}>
              {t.status === "done" ? <IconCheckCircle className="h-5 w-5 text-ok" /> : <IconCircle className="h-5 w-5" />}
            </button>
            <textarea aria-label="Title" rows={1} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== t.title && void saveText({ title })}
              className="w-full resize-none bg-transparent text-lg font-semibold leading-snug outline-none [field-sizing:content]" />
          </div>

            </div>
            <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-l lg:border-line lg:pl-6" data-testid="task-page-side">
              <div className="lg:sticky lg:top-4">
          <dl data-testid="task-properties" className="mt-4 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5 text-[13px]">
            <TaskTypeRows task={t} onSave={save} />
            <dt className="text-subtle">Status</dt>
            <dd><Select aria-label="Status" value={t.statusId} onChange={(e) => save({ statusId: e.target.value })} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base">
              {project?.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select></dd>
            <dt className="text-subtle">Assignees</dt>
            <dd className="min-w-0"><AssigneePicker value={(t.assignees ?? (t.assignee ? [t.assignee] : [])).map((a) => `${a.type}:${a.id}`)} people={people.data ?? []} onChange={(keys) => save({ assignees: keys })} /></dd>
            <dt className="text-subtle">Priority</dt>
            <dd><Select aria-label="Priority" value={t.priority} onChange={(e) => save({ priority: e.target.value as Priority })} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base">
              {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </Select></dd>
            <dt className="text-subtle">Start</dt>
            <dd><Input type="date" aria-label="Start date" value={dateInput(t.start)} onChange={(e) => save({ start: e.target.value || null })} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base" /></dd>
            <dt className="text-subtle">Due</dt>
            <dd><Input type="date" aria-label="Due date" value={dateInput(t.due)} onChange={(e) => save({ due: e.target.value || null })} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base" /></dd>
            <dt className="text-subtle">Repeat</dt>
            <dd><RepeatField value={t.repeat ?? null} due={t.due} onChange={(repeat) => save({ repeat })} /></dd>
            <dt className="text-subtle">Tags</dt>
            <dd className="min-w-0"><TagPicker value={t.labels} onChange={(labels) => save({ labels })} /></dd>
            <SprintFields task={t} onSave={(patch) => save(patch)} />
          </dl>


          {(q.data!.customFields?.length ?? 0) > 0 && (
            <section className="mt-4" aria-label="Custom fields">
              <dl className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5 text-[13px]">
                {taskFields(q.data!.customFields!).map((f) => (
                  <Fragment key={f.id}>
                    <dt className="truncate text-subtle" title={f.name}>{f.name}</dt>
                    <dd><FieldInput field={f} value={t.fields?.[f.id]} people={people.data ?? []} onSave={(v) => save({ fields: { [f.id]: v } })} /></dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          )}

              </div>
            </div>
            <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          {t.type === "epic" && <EpicSection epic={t} onChanged={() => void q.refetch()} />}
          <DescriptionEditor value={notes} people={people.data ?? []} onSave={(v) => { setNotes(v); void saveText({ notes: v }); }} />
          <ReferencesPanel type="task" id={t.id} stamp={t.updatedAt} />

          {t.source && (
            <section className="mt-6" aria-label="Email thread">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle"><IconMail className="h-3.5 w-3.5" />From email</h3>
                {t.source.messageId && <Link to={`/app/mail?m=${t.source.messageId}`} className="text-[12.5px] text-brand-hover hover:underline">Open thread</Link>}
              </div>
              <p className="mt-1.5 text-[13px] text-muted">{t.source.subject || "(no subject)"} · {t.source.from}</p>
              <ol className="mt-3 space-y-2">
                {q.data!.thread.map((m) => (
                  <li key={m.id} className={cn("rounded-lg border border-line p-3", m.direction === "outbound" ? "bg-fill/60" : "bg-elevated/60")}>
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="font-medium text-fg">{m.from.name || m.from.address}</span>
                      {m.byAgent && <Badge tone="brand"><IconAgent className="h-3 w-3" />Agent</Badge>}
                      <span className="ml-auto text-subtle">{mailDate(m.date)}</span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{m.latestText.slice(0, 600) || "(no text)"}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <MyDayRow taskId={t.id} /><TaskTime taskId={t.id} total={q.data!.time?.totalSeconds ?? 0} entries={q.data!.time?.entries ?? []} onChange={() => void q.refetch()} />

          <Dependencies task={t} blockedBy={q.data!.blockedBy ?? []} blocking={q.data!.blocking ?? []} onChange={() => void q.refetch()} />

          <TaskChecklist taskId={t.id} onSubtask={() => void q.refetch()} />

          <TaskRuns taskId={t.id} refreshedAt={q.dataUpdatedAt} />

          <section className="mt-6" aria-label="Subtasks" hidden={t.type === "epic"}>
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Subtasks {t.subtasks.total > 0 && <span className="font-normal normal-case">{t.subtasks.done} of {t.subtasks.total}</span>}</h3>
            <ul className="mt-2 space-y-1">
              {q.data!.subtasks.map((s: Task) => (
                <li key={s.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-hover">
                  <button aria-label={s.status === "done" ? `Mark ${s.title} as not done` : `Mark ${s.title} as done`} onClick={() => update.mutate({ id: s.id, patch: { status: s.status === "done" ? "todo" : "done" } }, { onSuccess: () => void q.refetch() })}>
                    {s.status === "done" ? <IconCheckCircle className="h-4 w-4 text-ok" /> : <IconCircle className="h-4 w-4 text-muted" />}
                  </button>
                  <span className={cn("text-[13px]", s.status === "done" && "text-subtle line-through")}>{s.title}</span>
                  {s.assignee && <span className="ml-auto text-[11.5px] text-subtle">{s.assignee.name}</span>}
                </li>
              ))}
            </ul>
            <form className="mt-1.5" onSubmit={(e) => { e.preventDefault(); void addSub(); }}>
              <Input aria-label="New subtask" placeholder="Add a subtask and press Enter" value={sub} onChange={(e) => setSub(e.target.value)} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base" />
            </form>
          </section>

          <TaskFiles taskId={t.id} />
          <TaskDocBacklinks taskId={t.id} />

          {q.data!.docs.length > 0 && (
            <section className="mt-6" aria-label="Docs">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Docs</h3>
              <ul className="mt-2 space-y-1">{q.data!.docs.map((d) => <li key={d.id}><Link to={`/app/docs/${d.id}`} className="flex items-center gap-2 text-[13px] text-fg hover:underline"><IconDocs className="h-3.5 w-3.5 text-muted" />{d.title}</Link></li>)}</ul>
            </section>
          )}

          {q.data!.contacts.length > 0 && (
            <section className="mt-6" aria-label="Contacts">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Contact</h3>
              <ul className="mt-2 space-y-1">{q.data!.contacts.map((c) => <li key={c.id}><Link to={`/app/contacts/${c.id}`} className="flex items-center gap-2 text-[13px] hover:underline"><IconUser className="h-3.5 w-3.5 text-muted" />{c.name || c.email}{c.company && <span className="text-subtle">· {c.company.name}</span>}</Link></li>)}</ul>
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
                    <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-muted"><CommentText text={c.body} /></p>
                  </div>
                </li>
              ))}
            </ul>
            <CommentBox people={people.data ?? []} onSend={async (body) => { try { await api.post(`/tasks/${t.id}/comments`, { body }); await q.refetch(); refresh(); } catch (e) { showError(e as Error); throw e; } }} />
          </section>

          <section className="mt-6" aria-label="History">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">History</h3>
            <ul className="mt-2 space-y-1.5">
              {q.data!.activity.slice(0, 20).map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-[12.5px] text-muted">
                  {a.actor.type === "agent" ? <IconAgent className="h-3.5 w-3.5 text-brand-hover" /> : a.actor.type === "system" ? <IconCalendar className="h-3.5 w-3.5" /> : <IconUser className="h-3.5 w-3.5" />}
                  <span><span className="text-fg">{a.actor.name ?? "Someone"}</span> {describeActivity(a)}</span>
                  <span className="ml-auto shrink-0 text-subtle">{timeAgo(a.at)}</span>
                </li>
              ))}
            </ul>
          </section>
            </div>
          </div>
        ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10">
          {conflict && <ConflictBar onKeepMine={keepMine} onUseTheirs={useTheirs} />}
          <CatchupCard key={`catchup-${t.id}`} type="task" id={t.id} className="mx-0 mb-0 mt-3" />
          <div className="flex items-start gap-2 pt-4">
            <button className="mt-1.5 text-muted hover:text-ok" aria-label={t.status === "done" ? "Mark as not done" : "Mark as done"} onClick={() => save({ status: t.status === "done" ? "todo" : "done" })}>
              {t.status === "done" ? <IconCheckCircle className="h-5 w-5 text-ok" /> : <IconCircle className="h-5 w-5" />}
            </button>
            <textarea aria-label="Title" rows={1} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== t.title && void saveText({ title })}
              className="w-full resize-none bg-transparent text-lg font-semibold leading-snug outline-none [field-sizing:content]" />
          </div>

          <dl data-testid="task-properties" className="mt-4 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5 text-[13px]">
            <TaskTypeRows task={t} onSave={save} />
            <dt className="text-subtle">Status</dt>
            <dd><Select aria-label="Status" value={t.statusId} onChange={(e) => save({ statusId: e.target.value })} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base">
              {project?.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select></dd>
            <dt className="text-subtle">Assignees</dt>
            <dd className="min-w-0"><AssigneePicker value={(t.assignees ?? (t.assignee ? [t.assignee] : [])).map((a) => `${a.type}:${a.id}`)} people={people.data ?? []} onChange={(keys) => save({ assignees: keys })} /></dd>
            <dt className="text-subtle">Priority</dt>
            <dd><Select aria-label="Priority" value={t.priority} onChange={(e) => save({ priority: e.target.value as Priority })} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base">
              {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </Select></dd>
            <dt className="text-subtle">Start</dt>
            <dd><Input type="date" aria-label="Start date" value={dateInput(t.start)} onChange={(e) => save({ start: e.target.value || null })} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base" /></dd>
            <dt className="text-subtle">Due</dt>
            <dd><Input type="date" aria-label="Due date" value={dateInput(t.due)} onChange={(e) => save({ due: e.target.value || null })} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base" /></dd>
            <dt className="text-subtle">Repeat</dt>
            <dd><RepeatField value={t.repeat ?? null} due={t.due} onChange={(repeat) => save({ repeat })} /></dd>
            <dt className="text-subtle">Tags</dt>
            <dd className="min-w-0"><TagPicker value={t.labels} onChange={(labels) => save({ labels })} /></dd>
            <SprintFields task={t} onSave={(patch) => save(patch)} />
          </dl>


          {(q.data!.customFields?.length ?? 0) > 0 && (
            <section className="mt-4" aria-label="Custom fields">
              <dl className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5 text-[13px]">
                {taskFields(q.data!.customFields!).map((f) => (
                  <Fragment key={f.id}>
                    <dt className="truncate text-subtle" title={f.name}>{f.name}</dt>
                    <dd><FieldInput field={f} value={t.fields?.[f.id]} people={people.data ?? []} onSave={(v) => save({ fields: { [f.id]: v } })} /></dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          )}

          {t.type === "epic" && <EpicSection epic={t} onChanged={() => void q.refetch()} />}
          <DescriptionEditor value={notes} people={people.data ?? []} onSave={(v) => { setNotes(v); void saveText({ notes: v }); }} />
          <ReferencesPanel type="task" id={t.id} stamp={t.updatedAt} />

          {t.source && (
            <section className="mt-6" aria-label="Email thread">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle"><IconMail className="h-3.5 w-3.5" />From email</h3>
                {t.source.messageId && <Link to={`/app/mail?m=${t.source.messageId}`} className="text-[12.5px] text-brand-hover hover:underline">Open thread</Link>}
              </div>
              <p className="mt-1.5 text-[13px] text-muted">{t.source.subject || "(no subject)"} · {t.source.from}</p>
              <ol className="mt-3 space-y-2">
                {q.data!.thread.map((m) => (
                  <li key={m.id} className={cn("rounded-lg border border-line p-3", m.direction === "outbound" ? "bg-fill/60" : "bg-elevated/60")}>
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="font-medium text-fg">{m.from.name || m.from.address}</span>
                      {m.byAgent && <Badge tone="brand"><IconAgent className="h-3 w-3" />Agent</Badge>}
                      <span className="ml-auto text-subtle">{mailDate(m.date)}</span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{m.latestText.slice(0, 600) || "(no text)"}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <MyDayRow taskId={t.id} /><TaskTime taskId={t.id} total={q.data!.time?.totalSeconds ?? 0} entries={q.data!.time?.entries ?? []} onChange={() => void q.refetch()} />

          <Dependencies task={t} blockedBy={q.data!.blockedBy ?? []} blocking={q.data!.blocking ?? []} onChange={() => void q.refetch()} />

          <TaskChecklist taskId={t.id} onSubtask={() => void q.refetch()} />

          <TaskRuns taskId={t.id} refreshedAt={q.dataUpdatedAt} />

          <section className="mt-6" aria-label="Subtasks" hidden={t.type === "epic"}>
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Subtasks {t.subtasks.total > 0 && <span className="font-normal normal-case">{t.subtasks.done} of {t.subtasks.total}</span>}</h3>
            <ul className="mt-2 space-y-1">
              {q.data!.subtasks.map((s: Task) => (
                <li key={s.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-hover">
                  <button aria-label={s.status === "done" ? `Mark ${s.title} as not done` : `Mark ${s.title} as done`} onClick={() => update.mutate({ id: s.id, patch: { status: s.status === "done" ? "todo" : "done" } }, { onSuccess: () => void q.refetch() })}>
                    {s.status === "done" ? <IconCheckCircle className="h-4 w-4 text-ok" /> : <IconCircle className="h-4 w-4 text-muted" />}
                  </button>
                  <span className={cn("text-[13px]", s.status === "done" && "text-subtle line-through")}>{s.title}</span>
                  {s.assignee && <span className="ml-auto text-[11.5px] text-subtle">{s.assignee.name}</span>}
                </li>
              ))}
            </ul>
            <form className="mt-1.5" onSubmit={(e) => { e.preventDefault(); void addSub(); }}>
              <Input aria-label="New subtask" placeholder="Add a subtask and press Enter" value={sub} onChange={(e) => setSub(e.target.value)} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base" />
            </form>
          </section>

          <TaskFiles taskId={t.id} />
          <TaskDocBacklinks taskId={t.id} />

          {q.data!.docs.length > 0 && (
            <section className="mt-6" aria-label="Docs">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Docs</h3>
              <ul className="mt-2 space-y-1">{q.data!.docs.map((d) => <li key={d.id}><Link to={`/app/docs/${d.id}`} className="flex items-center gap-2 text-[13px] text-fg hover:underline"><IconDocs className="h-3.5 w-3.5 text-muted" />{d.title}</Link></li>)}</ul>
            </section>
          )}

          {q.data!.contacts.length > 0 && (
            <section className="mt-6" aria-label="Contacts">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Contact</h3>
              <ul className="mt-2 space-y-1">{q.data!.contacts.map((c) => <li key={c.id}><Link to={`/app/contacts/${c.id}`} className="flex items-center gap-2 text-[13px] hover:underline"><IconUser className="h-3.5 w-3.5 text-muted" />{c.name || c.email}{c.company && <span className="text-subtle">· {c.company.name}</span>}</Link></li>)}</ul>
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
                    <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-muted"><CommentText text={c.body} /></p>
                  </div>
                </li>
              ))}
            </ul>
            <CommentBox people={people.data ?? []} onSend={async (body) => { try { await api.post(`/tasks/${t.id}/comments`, { body }); await q.refetch(); refresh(); } catch (e) { showError(e as Error); throw e; } }} />
          </section>

          <section className="mt-6" aria-label="History">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">History</h3>
            <ul className="mt-2 space-y-1.5">
              {q.data!.activity.slice(0, 20).map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-[12.5px] text-muted">
                  {a.actor.type === "agent" ? <IconAgent className="h-3.5 w-3.5 text-brand-hover" /> : a.actor.type === "system" ? <IconCalendar className="h-3.5 w-3.5" /> : <IconUser className="h-3.5 w-3.5" />}
                  <span><span className="text-fg">{a.actor.name ?? "Someone"}</span> {describeActivity(a)}</span>
                  <span className="ml-auto shrink-0 text-subtle">{timeAgo(a.at)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        )
      )}
    </aside>
  );
  if (docked) return slot ? createPortal(panel, slot) : null;
  return panel;
}

/** Blocked by and blocking: the same links the timeline draws as arrows. */
function Dependencies({ task, blockedBy, blocking, onChange }: { task: Task; blockedBy: Task[]; blocking: Task[]; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const candidates = useTasks({ projectId: task.projectId }, { enabled: adding });
  const add = async (other: string) => {
    if (!other) return;
    try { await api.post(`/tasks/${task.id}/dependencies`, { blockedBy: other }); setAdding(false); onChange(); } catch (e) { showError(e as Error); }
  };
  const remove = async (blocker: string, blocked: string) => { try { await api.del(`/tasks/${blocked}/dependencies/${blocker}`); onChange(); } catch (e) { showError(e as Error); } };
  const taken = new Set([task.id, ...blockedBy.map((b) => b.id)]);
  const open = blockedBy.filter((b) => b.status !== "done").length;
  // R38: each row carries the link's lead or lag (lagDays), edited in place with LagChip.
  const row = (x: Task, onRemove: () => void, link?: { blocked: string; blocker: string }) => (
    <li key={x.id} className="group flex min-h-7 items-center gap-2 text-[13px]">
      {x.status === "done" ? <IconCheckCircle className="h-3.5 w-3.5 shrink-0 text-ok" /> : <IconCircle className="h-3.5 w-3.5 shrink-0 text-muted" />}
      <span className="font-mono text-[12px] text-subtle">{x.ref}</span>
      <span className={cn("min-w-0 truncate", x.status === "done" && "text-subtle line-through")}>{x.title}</span>
      {link && <span className="ml-auto"><LagChip blockedId={link.blocked} blockerId={link.blocker} lag={(x as Task & { lagDays?: number }).lagDays ?? 0} onSaved={onChange} /></span>}
      <button className="ml-auto shrink-0 text-subtle opacity-0 hover:text-bad group-hover:opacity-100 focus:opacity-100" aria-label={`Remove dependency on ${x.ref}`} onClick={onRemove}><IconClose className="h-3.5 w-3.5" /></button>
    </li>
  );
  return (
    <section className="mt-6" aria-label="Dependencies" data-testid="dependencies">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle"><IconLink className="h-3.5 w-3.5" />Dependencies {open > 0 && <span className="rounded bg-warn/15 px-1.5 py-px text-[11px] font-medium normal-case text-warn">Blocked</span>}</h3>
        <button className="text-[12.5px] text-brand-hover hover:underline" onClick={() => setAdding((v) => !v)}>Add blocker</button>
      </div>
      {adding && (
        <Select aria-label="Blocked by" className="mt-2 h-8 text-[13px]" defaultValue="" onChange={(e) => void add(e.target.value)}>
          <option value="">This task is blocked by...</option>
          {candidates.data?.filter((c) => !taken.has(c.id)).map((c) => <option key={c.id} value={c.id}>{c.ref} {c.title}</option>)}
        </Select>
      )}
      {blockedBy.length > 0 && <><p className="mt-2 text-[12px] text-subtle">Blocked by</p><ul className="mt-1 space-y-1">{blockedBy.map((b) => row(b, () => void remove(b.id, task.id), { blocked: task.id, blocker: b.id }))}</ul></>}
      {blocking.length > 0 && <><p className="mt-2 text-[12px] text-subtle">Blocking</p><ul className="mt-1 space-y-1">{blocking.map((b) => row(b, () => void remove(task.id, b.id), { blocked: b.id, blocker: task.id }))}</ul></>}
      {!blockedBy.length && !blocking.length && !adding && <p className="mt-1 text-[12.5px] text-subtle">Nothing blocks this task.</p>}
    </section>
  );
}

type Repeat = NonNullable<Task["repeat"]>;

/** R95: the smart repeat control when Tasks plus is on, else the classic one. */
function RepeatField({ value, due, onChange }: { value: Repeat | null; due: string | null; onChange: (r: Omit<Repeat, "text"> | null) => void }) {
  const plus = !!useConfig().data?.tasksPlus;
  const people = useAssignees();
  if (!plus) return <RepeatPicker value={value} onChange={onChange} />;
  return <RepeatPlus value={value} due={due} people={(people.data ?? []).map((p) => ({ type: p.type, id: p.id, name: p.name }))} onChange={onChange as never} />;
}

/** R95: Add to My Day, above the task's time. */
function MyDayRow({ taskId }: { taskId: string }) {
  if (!useConfig().data?.tasksPlus) return null;
  return <div className="mt-6 flex items-center gap-2"><AddToMyDay taskId={taskId} /></div>;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Repeat rule: none, daily, weekly on chosen days, monthly, yearly, or every N of those. */
function RepeatPicker({ value, onChange }: { value: Repeat | null; onChange: (r: Omit<Repeat, "text"> | null) => void }) {
  const freq = value?.freq ?? "";
  const interval = value?.interval ?? 1;
  const set = (patch: Partial<Omit<Repeat, "text">>) => {
    const next = { freq: (patch.freq ?? value?.freq ?? "weekly") as Repeat["freq"], interval: patch.interval ?? interval, weekdays: patch.weekdays ?? value?.weekdays, monthDay: patch.monthDay ?? value?.monthDay, until: value?.until ?? null };
    if (next.freq !== "weekly") delete next.weekdays;
    if (next.freq !== "monthly") delete next.monthDay;
    onChange(next);
  };
  return (
    <div className="space-y-1.5" data-testid="repeat-picker">
      <div className="flex gap-1.5">
        <Select aria-label="Repeat" value={freq} onChange={(e) => (e.target.value ? set({ freq: e.target.value as Repeat["freq"] }) : onChange(null))} className="h-8 text-[13px] max-sm:h-11 max-sm:text-base">
          <option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option>
        </Select>
        {freq && <label className="flex items-center gap-1 text-[12.5px] text-muted">every<Input aria-label="Repeat every" type="number" min={1} max={365} value={interval} onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })} className="h-8 w-14 text-[13px]" /></label>}
      </div>
      {freq === "weekly" && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Repeat on">
          {DAYS.map((d, i) => {
            const on = value?.weekdays?.includes(i) ?? false;
            return <button key={d} type="button" aria-pressed={on} onClick={() => set({ weekdays: on ? (value?.weekdays ?? []).filter((x) => x !== i) : [...(value?.weekdays ?? []), i].sort() })}
              className={on ? "rounded-md bg-brand px-1.5 py-0.5 text-[11.5px] text-brand-fg" : "rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-muted"}>{d}</button>;
          })}
        </div>
      )}
      {value && <p className="text-[11.5px] text-subtle">{value.text}. Finishing it makes the next one.</p>}
    </div>
  );
}

/** R40 (MB-204): the person's text stays on screen; they choose which version wins. */
function ConflictBar({ onKeepMine, onUseTheirs }: { onKeepMine: () => void; onUseTheirs: () => void }) {
  return (
    <div role="alert" data-testid="task-conflict"
      className="sticky top-0 z-10 -mx-5 mt-0 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warn/25 bg-warn-soft/95 px-5 py-2.5 text-[13px] text-fg backdrop-blur motion-safe:animate-[fade-in_160ms_ease-out]">
      <IconWarning className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
      <span className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-0">Changed in another tab or by someone else. Keep yours or use theirs.</span>
      <span className="ml-auto flex gap-2">
        <Button size="sm" variant="secondary" onClick={onUseTheirs}>Use theirs</Button>
        <Button size="sm" onClick={onKeepMine}>Keep yours</Button>
      </span>
    </div>
  );
}

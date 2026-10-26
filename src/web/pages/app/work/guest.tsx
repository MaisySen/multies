/**
 * The guest's side: an outside person invited to one project. /g/:token trades the invite
 * for a guest session, then /guest shows that project's tasks, comments, files and docs.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { docBlockSchemaExtensions } from "@/web/lib/docs-blocks-schema"; // R32: tables, images, callouts read here too
import { AlertTriangle, CheckCircle2, Circle, ListTodo, LogOut, MessageSquare, X } from "lucide-react";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Logo } from "@/web/components/logo";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { Spinner } from "@/web/components/ui/spinner";
import { Textarea } from "@/web/components/ui/input";
import { Avatar, Card, Meter, Skeleton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { timeAgo } from "@/web/lib/format";
import type { Comment, CustomField, Status, Task, TaskFile } from "./data";
import { FieldCell } from "./fields";
import { FileList } from "./task-files";
import { tone } from "@/web/components/app-bits";
import { GuestBacklinks, GuestDocTree } from "./guest-docs";

interface Home {
  guest: { id: string; email: string; name: string }; workspace: { name: string };
  project: { id: string; name: string; key: string; color: string; statuses: Status[] };
  tasks: Task[]; customFields: CustomField[]; docs: { id: string; title: string; updatedAt: string }[];
}
interface Detail { task: Task; subtasks: Task[]; comments: Comment[]; files: TaskFile[]; customFields: CustomField[] }

export function GuestAcceptPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let done = false;
    api.post("/guest/accept", { token })
      .then(() => { if (!done) navigate("/guest", { replace: true }); })
      .catch((e: ApiError) => setError(e.message));
    return () => { done = true; };
  }, [token, navigate]);
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 text-fg">
      <Card className="w-full max-w-sm animate-pop-in p-8 text-center shadow-pop">
        <div className="flex justify-center"><Logo /></div>
        {error ? (
          <>
            <span className="mx-auto mt-6 grid h-11 w-11 place-items-center rounded-full bg-warn-soft text-warn" aria-hidden><AlertTriangle className="h-5 w-5" /></span>
            <h1 className="mt-4 text-[17px] font-semibold tracking-tight">This invite link doesn't work</h1>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{error}</p>
            <ButtonLink to="/" variant="secondary" className="mt-6 w-full">Go to Multies</ButtonLink>
          </>
        ) : (
          <p className="mt-6 flex items-center justify-center gap-2 text-[13.5px] text-muted" aria-busy="true"><Spinner className="h-4 w-4" />Opening the project</p>
        )}
      </Card>
    </main>
  );
}

function DocView({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ["guest-doc", id], queryFn: async () => (await api.get<{ doc: { title: string; content: unknown } }>(`/guest/docs/${id}`)).doc });
  const editor = useEditor({ extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), ...docBlockSchemaExtensions()], editable: false, content: null }, []);
  useEffect(() => { if (editor && q.data) editor.commands.setContent(q.data.content as never); }, [editor, q.data]);
  return (
    <Card className="p-5" aria-label="Doc">
      <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{q.data?.title ?? ""}</h2><Button variant="ghost" size="icon" aria-label="Close doc" onClick={onClose}><X className="h-4 w-4" /></Button></div>
      <div className="prose-doc mt-3 text-[14px] leading-relaxed"><EditorContent editor={editor} /></div>
      <GuestBacklinks id={id} onOpen={onOpen} />
    </Card>
  );
}

function TaskView({ id, fields, onClose }: { id: string; fields: CustomField[]; onClose: () => void }) {
  const q = useQuery({ queryKey: ["guest-task", id], queryFn: () => api.get<Detail>(`/guest/tasks/${id}`) });
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try { await api.post(`/guest/tasks/${id}/comments`, { body: comment }); setComment(""); await q.refetch(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  if (!q.data) return <Skeleton className="h-64" />;
  const t = q.data.task;
  return (
    <Card className="p-5" aria-label="Task" data-testid="guest-task">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[12px] text-subtle">{t.ref} · {t.statusName}</p>
          <h2 className="mt-0.5 text-lg font-semibold">{t.title}</h2>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close task" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>
      {t.notes && <p className="mt-3 whitespace-pre-wrap text-[13.5px] text-muted">{t.notes}</p>}
      <dl className="mt-4 grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-[13px]">
        <dt className="text-subtle">Due</dt><dd>{t.due ? new Date(t.due).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : <span className="text-subtle">-</span>}</dd>
        <dt className="text-subtle">Assignee</dt><dd>{t.assignee?.name ?? <span className="text-subtle">Nobody</span>}</dd>
        {fields.map((f) => <div key={f.id} className="contents"><dt className="truncate text-subtle">{f.name}</dt><dd><FieldCell field={f} value={t.fields?.[f.id]} /></dd></div>)}
      </dl>
      {q.data.subtasks.length > 0 && (
        <ul className="mt-4 space-y-1">{q.data.subtasks.map((s) => <li key={s.id} className="flex items-center gap-2 text-[13px]">{s.status === "done" ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <Circle className="h-4 w-4 text-muted" />}{s.title}</li>)}</ul>
      )}
      <FileList files={q.data.files} uploadPath={`/guest/tasks/${t.id}/files`} downloadPath={(fid) => `/guest/files/${fid}`} onUploaded={() => void q.refetch()} />
      <section className="mt-6" aria-label="Comments">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Comments</h3>
        <ol className="mt-2 space-y-3">
          {q.data.comments.map((c) => (
            <li key={c.id} className="text-[13px]"><span className="font-medium">{c.author.name}</span> <span className="text-[11.5px] text-subtle">{timeAgo(c.createdAt)}</span><p className="mt-0.5 whitespace-pre-wrap text-muted">{c.body}</p></li>
          ))}
        </ol>
        <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Textarea aria-label="Write a comment" placeholder="Write a comment" value={comment} onChange={(e) => setComment(e.target.value)} className="min-h-20 text-[13.5px]" />
          <Button type="submit" loading={busy} disabled={!comment.trim()}>Comment</Button>
        </form>
      </section>
    </Card>
  );
}

export function GuestProjectPage() {
  const q = useQuery({ queryKey: ["guest-home"], retry: false, queryFn: () => api.get<Home>("/guest/me") });
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const navigate = useNavigate();
  const signOut = async () => { await api.post("/guest/signout").catch(() => undefined); navigate("/", { replace: true }); };
  if (q.isPending) return (
    <main className="min-h-dvh bg-bg px-4 py-5" aria-busy>
      <div className="mx-auto max-w-5xl space-y-4"><Skeleton className="h-9 w-40" /><Skeleton className="h-8 w-72" /><Skeleton className="h-64 rounded-xl" /></div>
    </main>
  );
  if (!q.data) return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 text-fg">
      <Card className="w-full max-w-sm p-8 text-center shadow-pop"><div className="flex justify-center"><Logo /></div><h1 className="mt-6 text-[17px] font-semibold tracking-tight">You're signed out</h1><p className="mt-1.5 text-[13.5px] text-muted">Open your invite link again, or ask for a new one.</p></Card>
    </main>
  );
  const h = q.data;
  const top = h.tasks.filter((t) => !t.parentId);
  const doneCount = top.filter((t) => t.status === "done").length;
  const who = h.guest.name || h.guest.email;
  return (
    <main className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <Logo />
          <span className="ml-auto flex min-w-0 items-center gap-2 text-[12.5px] text-muted">
            <Avatar label={who.slice(0, 2).toUpperCase()} className="h-7 w-7 text-[10px]" />
            <span className="hidden min-w-0 truncate sm:inline"><span className="text-fg">{who}</span> · guest of {h.workspace.name}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={signOut}><LogOut className="h-4 w-4" /><span className="max-sm:sr-only">Sign out</span></Button>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-6">
        <p className="mb-1 text-[13px] font-semibold text-brand-hover sm:hidden">Guest of {h.workspace.name}</p>
        <div className="mb-2 flex items-center gap-2.5">
          <span className="h-3.5 w-3.5 rounded" style={{ background: tone(h.project.color) }} aria-hidden />
          <h1 className="large-title min-w-0 truncate" data-testid="guest-project">{h.project.name}</h1>
          <span className="rounded-md bg-fill px-1.5 py-0.5 font-mono text-[11.5px] text-muted">{h.project.key}</span>
        </div>
        <p className="mb-4 text-[13.5px] text-muted">You can see this project's tasks, comments and docs, comment, and upload files.</p>
        {top.length > 0 && (
          <div className="mb-5 flex max-w-sm items-center gap-3">
            <Meter value={doneCount} max={top.length} label={`${doneCount} of ${top.length} tasks done`} className="h-2" />
            <span className="shrink-0 text-[12.5px] tabular-nums text-muted">{doneCount} of {top.length} done</span>
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <section aria-label="Tasks" className={cn((openTask || openDoc) && "hidden lg:block")}>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-testid="guest-tasks">
              {top.map((t) => (
                <li key={t.id}>
                  <button onClick={() => { setOpenTask(t.id); setOpenDoc(null); window.scrollTo(0, 0); }} className={cn("flex w-full items-center gap-2.5 px-4 py-3 text-left text-[13.5px] transition-colors hover:bg-hover max-sm:min-h-12", openTask === t.id && "bg-brand-soft/60")}>
                    {t.status === "done" ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <Circle className="h-4 w-4 text-muted" />}
                    <span className="font-mono text-[11.5px] text-subtle">{t.ref}</span>
                    <span className={cn("truncate", t.status === "done" && "text-subtle line-through")}>{t.title}</span>
                    <span className="ml-auto shrink-0 rounded-full bg-fill px-2 py-0.5 text-[11.5px] text-muted">{t.statusName}</span>
                    {t.commentCount > 0 && <span className="inline-flex items-center gap-0.5 text-[11.5px] text-subtle"><MessageSquare className="h-3 w-3" />{t.commentCount}</span>}
                  </button>
                </li>
              ))}
              {!top.length && (
                <li className="flex flex-col items-center px-6 py-10 text-center">
                  <span className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-fill text-muted" aria-hidden><ListTodo className="h-5 w-5" /></span>
                  <span className="text-[14px] font-semibold">No tasks yet</span>
                  <span className="mt-1 text-[13px] text-muted">Tasks show here as {h.workspace.name} adds them.</span>
                </li>
              )}
            </ul>
            <GuestDocTree docs={h.docs} openId={openDoc} onOpen={(d) => { setOpenDoc(d); setOpenTask(null); }} />
          </section>
          <div className={cn(!openTask && !openDoc && "hidden lg:block")}>
            {openTask ? <TaskView id={openTask} fields={h.customFields} onClose={() => setOpenTask(null)} />
              : openDoc ? <DocView id={openDoc} onClose={() => setOpenDoc(null)} onOpen={(d) => { setOpenDoc(d); setOpenTask(null); }} />
                : <Card className="grid min-h-48 place-items-center p-6 text-center text-[13px] text-muted">Pick a task or a doc to open it.</Card>}
          </div>
        </div>
      </div>
    </main>
  );
}

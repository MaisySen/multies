/**
 * R129: courses, a doc type. A course doc opens here instead of the text editor: Learn (outline, lessons, quizzes,
 * certificate), Build (lessons and quizzes), Assign (people and due dates), Progress (table and CSV) and Settings.
 * My learning lives at /app/docs/learning. Quizzes are scored on the server; this page never sees the answer key
 * unless the person can build the course.
 */
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconArrowDown, IconArrowLeft, IconArrowUp, IconBook, IconCheckCircle, IconDownload, IconExternalLink, IconPlus, IconTrash } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { LoadError, LoadErrorInline } from "@/web/components/load-error-t1g";
import { Dialog } from "@/web/components/ui/dialog";
import { useDialogs } from "@/web/components/ui/confirm";
import { DateInput, Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, PageHeader, Skeleton, Switch, tableStyles } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { useConfig, useMe } from "@/web/lib/queries";
import { usePageTitle } from "@/web/lib/page-title-pol1"; // POL1
import { queryRetry } from "@/web/lib/load-errors-t1g"; // POL1
import { MoreMenu, useTrashAction } from "@/web/components/trash-pol1"; // POL1 (MB-313)
import { useAssignees, isAgentLike } from "./data";
import { LESSON_LABEL, LESSON_TYPES, STATUS_LABEL, type LearnerStatus, type LessonType, type PublicQuestion, type Question, type QuestionType } from "@/shared/courses-r129";

// ---------------------------------------------------------------- types and data

interface Lesson { id: string; title: string; type: LessonType; refDocId: string | null; url: string | null; body: string; required: boolean; passMark: number | null; questionCount: number; quiz?: Question[]; questions?: PublicQuestion[] }
interface Me { id: string; source: string; dueAt: number | null; startedAt: number | null; completedAt: number | null; certificateNo: string | null; status: LearnerStatus; percent: number; lessons: Record<string, { done: boolean; passed: boolean; bestScore: number | null; attempts: number }> }
interface Course { id: string; title: string; status: "draft" | "published"; passMark: number; certificate: boolean; editors?: string[]; managers?: string[]; createdBy?: string | null; canBuild: boolean; canDelete?: boolean; canSeeProgress: boolean; canLearn: boolean; guest: boolean }
interface Detail { course: Course; lessons: Lesson[]; me: Me | null }
interface ProgressRow { id: string; userId: string; name: string; email: string; source: string; percent: number; done: number; total: number; bestScore: number | null; dueAt: number | null; completedAt: number | null; status: LearnerStatus; statusLabel: string }
interface QuizResult { score: number; right: number; total: number; passed: boolean; passMark: number; wrong: string[] }

const key = (id: string) => ["course", id];
const day = (n: number | null) => (n ? new Date(n).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const statusTone = (s: LearnerStatus) => (s === "completed" ? "ok" : s === "overdue" ? "bad" : s === "in_progress" ? "brand" : "neutral") as "ok" | "bad" | "brand" | "neutral";

/** The flag is on and the API answers (an excluded workspace gets 404, so no entry points show). */
export function useCoursesOn() {
  const flag = !!(useConfig().data as { coursesR129?: boolean } | undefined)?.coursesR129;
  const list = useQuery({ queryKey: ["courses-list"], enabled: flag, staleTime: 300_000, retry: false, queryFn: () => api.get<{ courses: { id: string; title: string; status: string }[] }>("/courses") });
  return flag && list.isSuccess;
}

function useCourse(id: string) {
  return useQuery({ queryKey: key(id), retry: queryRetry, queryFn: () => api.get<Detail>(`/courses/${id}`) });
}

/** Course progress: brand colour while going, ok colour when done (the shared Meter reads as usage and turns red when full). */
function ProgressBar({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="flex items-center gap-2">
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label={label} className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-fill">
        <div className={cn("h-full rounded-full transition-[width] duration-200", v >= 100 ? "bg-ok" : "bg-brand")} style={{ width: `${v}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-muted">{v}%</span>
    </div>
  );
}

/** A switch with its words beside it (the shared Switch carries its label for screen readers only). */
function LabeledSwitch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <span className="text-[14px]" aria-hidden>{label}</span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

// ---------------------------------------------------------------- new course

export function NewCourseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ course: { id: string } }>("/courses", { title: title.trim() || undefined });
      void qc.invalidateQueries({ queryKey: ["docs"] });
      void qc.invalidateQueries({ queryKey: ["courses-list"] });
      onClose();
      navigate(`/app/docs/${r.course.id}?tab=build`);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New course" description="Build lessons from your docs, add a quiz, then assign it to your team."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void create()} disabled={busy} data-testid="create-course">Create course</Button></>}>
      <Field label="Course name">{(fp) => <Input {...fp} autoFocus value={title} placeholder="For example: Workplace safety" maxLength={200} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />}</Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------- the course page

type Tab = "learn" | "build" | "assign" | "progress" | "settings";

export function CourseDoc({ docId }: { docId: string }) {
  const q = useCourse(docId);
  const navigate = useNavigate();
  const initial = (new URLSearchParams(window.location.search).get("tab") ?? "") as Tab;
  const [tab, setTab] = useState<Tab | null>(null);
  const d = q.data;
  const tabs = useMemo(() => {
    if (!d) return [] as { id: Tab; label: string }[];
    const c = d.course;
    return [
      ...(c.status === "published" || !c.canBuild ? [{ id: "learn" as Tab, label: c.canBuild ? "Preview" : "Learn" }] : []),
      ...(c.canBuild ? [{ id: "build" as Tab, label: "Build" }, { id: "assign" as Tab, label: "Assign" }] : []),
      ...(c.canSeeProgress ? [{ id: "progress" as Tab, label: "Progress" }] : []),
      ...(c.canBuild ? [{ id: "settings" as Tab, label: "Settings" }] : []),
    ];
  }, [d]);
  const current: Tab | undefined = tabs.find((t) => t.id === (tab ?? initial))?.id ?? tabs[0]?.id;
  usePageTitle(d ? [d.course.title || "Untitled course", "Docs"] : null); // POL1 (MB-321)
  const trash = useTrashAction("course", docId, d?.course.title ?? "");
  // POL1: arrow keys, Home and End move between the course tabs.
  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === current);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (next === null || !tabs.length) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    setTab(t.id);
    document.getElementById(`course-tab-${t.id}`)?.focus();
  };

  if (q.isPending) return <div className="mx-auto max-w-5xl space-y-3" aria-busy="true"><Skeleton className="h-9 w-1/2" /><Skeleton className="h-10 w-2/3" /><Skeleton className="h-64" /></div>;
  if (q.error) {
    const draft = q.error instanceof ApiError && q.error.status === 403;
    if (q.error instanceof ApiError && q.error.status === 404) return <EmptyState icon={<IconBook />} title="This course was deleted or moved" body="If it was deleted in the last 30 days, an admin can restore it from Docs, Trash." action={<Button variant="secondary" onClick={() => navigate("/app/docs")}>All docs</Button>} />; // POL1
    if (!draft) return <LoadError onRetry={() => q.refetch()} />;
    return <EmptyState icon={<IconBook />} title="This course is not published yet" body="You can take it once its editor publishes it."
      action={<Button onClick={() => navigate("/app/docs/learning")}>My learning</Button>} />;
  }
  const c = d!.course;
  return (
    <div className="mx-auto max-w-5xl" data-testid="course-page">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <IconBook className="h-5 w-5 text-muted" aria-hidden />
        <h1 className="min-w-0 flex-1 break-words text-[22px] font-semibold tracking-tight">{c.title}</h1>
        <Badge tone={c.status === "published" ? "ok" : "neutral"}>{c.status === "published" ? "Published" : "Draft"}</Badge>
        {c.canBuild && <PublishButton course={c} lessons={d!.lessons.length} />}
        {c.canDelete && <MoreMenu label="More course actions" testId="course-more" onTrash={() => void trash.run()} />}
        {trash.dialogs}
      </div>
      <div role="tablist" aria-label="Course" onKeyDown={onTabKey} className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <button key={t.id} id={`course-tab-${t.id}`} role="tab" type="button" aria-selected={current === t.id} aria-controls="course-panel" tabIndex={current === t.id ? 0 : -1} data-testid={`course-tab-${t.id}`} onClick={() => setTab(t.id)}
            className={cn("-mb-px min-h-11 shrink-0 border-b-2 px-3 text-[14px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand", current === t.id ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id="course-panel" aria-labelledby={current ? `course-tab-${current}` : undefined}>
        {current === "learn" && <LearnTab detail={d!} />}
        {current === "build" && <BuildTab detail={d!} />}
        {current === "assign" && <AssignTab detail={d!} />}
        {current === "progress" && <ProgressTab detail={d!} />}
        {current === "settings" && <SettingsTab detail={d!} />}
      </div>
    </div>
  );
}

function PublishButton({ course, lessons }: { course: Course; lessons: number }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      const r = await api.patch<Detail>(`/courses/${course.id}`, { status: course.status === "published" ? "draft" : "published" });
      qc.setQueryData(key(course.id), r);
      toast.success(r.course.status === "published" ? "Course published" : "Course moved back to draft");
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  if (course.status === "published") return <Button variant="secondary" size="sm" onClick={() => void toggle()} disabled={busy}>Unpublish</Button>;
  return <Button size="sm" onClick={() => void toggle()} disabled={busy || lessons === 0} title={lessons === 0 ? "Add a lesson first" : undefined} data-testid="publish-course">Publish</Button>;
}

// ---------------------------------------------------------------- learn

function LearnTab({ detail }: { detail: Detail }) {
  const { course, lessons, me } = detail;
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const firstOpen = lessons.find((l) => !(me?.lessons[l.id]?.done || me?.lessons[l.id]?.passed))?.id ?? lessons[0]?.id ?? null;
  const active = lessons.find((l) => l.id === (openId ?? firstOpen)) ?? null;
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try { qc.setQueryData(key(course.id), await api.post<Detail>(`/courses/${course.id}/start`)); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  if (!lessons.length) return <EmptyState icon={<IconBook />} title="No lessons yet" body={course.canBuild ? "Add the first lesson in Build." : "Check back soon."} />;
  const done = (l: Lesson) => (l.type === "quiz" ? !!me?.lessons[l.id]?.passed : !!me?.lessons[l.id]?.done);
  const idx = active ? lessons.findIndex((l) => l.id === active.id) : -1;
  const next = idx >= 0 ? lessons[idx + 1] : undefined;

  return (
    <div className="space-y-4">
    {me?.completedAt && <CompletedCard course={course} me={me} />}
    <div className="grid gap-6 md:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="space-y-3">
        {me ? (
          <Card className="space-y-2 p-4">
            <div className="flex items-center justify-between text-[13px]"><span className="font-medium">Your progress</span><Badge tone={statusTone(me.status)}>{STATUS_LABEL[me.status]}</Badge></div>
            <ProgressBar value={me.percent} label="Progress" />
            {me.dueAt && !me.completedAt && <p className="text-[12.5px] text-muted">Due {day(me.dueAt)}</p>}
          </Card>
        ) : course.canLearn ? (
          <Card className="space-y-2 p-4"><p className="text-[13px] text-muted">Start the course to keep track of what you finish.</p><Button className="w-full" onClick={() => void start()} disabled={busy} data-testid="start-course">Start course</Button></Card>
        ) : null}
        <label className="block md:hidden"><span className="sr-only">Lesson</span>
          <Select value={active?.id ?? ""} onChange={(e) => setOpenId(e.target.value)} aria-label="Lesson">{lessons.map((l, i) => <option key={l.id} value={l.id}>{`${i + 1}. ${l.title}${done(l) ? " (done)" : ""}`}</option>)}</Select>
        </label>
        <nav aria-label="Lessons" className="hidden md:block">
          <ol className="space-y-1">
            {lessons.map((l, i) => (
              <li key={l.id}>
                <button type="button" onClick={() => setOpenId(l.id)} aria-current={active?.id === l.id ? "step" : undefined} data-testid={`outline-${i}`}
                  className={cn("flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand", active?.id === l.id ? "bg-hover font-medium" : "hover:bg-hover/60")}>
                  {done(l) ? <IconCheckCircle className="h-4 w-4 shrink-0 text-ok" aria-label="Done" /> : <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line-strong text-[10px] text-muted" aria-hidden>{i + 1}</span>}
                  <span className="min-w-0 flex-1 break-words">{l.title}</span>
                  <span className="text-[11.5px] text-muted">{LESSON_LABEL[l.type]}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </aside>
      <section className="min-w-0 space-y-4" aria-label="Lesson content">
        {active && <LessonView key={active.id} course={course} lesson={active} me={me} done={done(active)} onNext={next ? () => setOpenId(next.id) : undefined} />}
      </section>
    </div>
    </div>
  );
}

function CompletedCard({ course, me }: { course: Course; me: Me }) {
  return (
    <Card className="flex flex-wrap items-center gap-3 border-ok/40 p-4" data-testid="course-complete">
      <IconCheckCircle className="h-6 w-6 text-ok" aria-hidden />
      <div className="min-w-0 flex-1"><p className="font-medium">You finished this course</p><p className="text-[13px] text-muted">Completed on {day(me.completedAt)}</p></div>
      {me.certificateNo && <a className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand px-3 text-[14px] font-medium text-brand-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2" href={`/api/courses/${course.id}/certificate.pdf`} download data-testid="download-certificate"><IconDownload className="h-4 w-4" />Download certificate</a>}
    </Card>
  );
}

function LessonView({ course, lesson, me, done, onNext }: { course: Course; lesson: Lesson; me: Me | null; done: boolean; onNext?: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const mark = async (v: boolean) => {
    setBusy(true);
    try { qc.setQueryData(key(course.id), await api.post<Detail>(`/courses/${course.id}/lessons/${lesson.id}/done`, { done: v })); if (v && onNext) onNext(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2"><Badge>{LESSON_LABEL[lesson.type]}</Badge>{!lesson.required && <Badge>Optional</Badge>}{done && <Badge tone="ok">Done</Badge>}</div>
      <h2 className="break-words text-[18px] font-semibold">{lesson.title}</h2>
      {lesson.body && <p className="whitespace-pre-wrap break-words text-[14.5px] leading-6">{lesson.body}</p>}
      {lesson.type === "page" && <PageLesson course={course} lesson={lesson} />}
      {(lesson.type === "file" || lesson.type === "video") && lesson.url && (
        <a href={lesson.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-[14px] font-medium hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
          <IconExternalLink className="h-4 w-4" />{lesson.type === "video" ? "Open video" : "Open file"}
        </a>
      )}
      {lesson.type === "quiz" ? <QuizView course={course} lesson={lesson} me={me} onNext={onNext} />
        : me && course.canLearn ? (
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            {done ? <Button variant="secondary" onClick={() => void mark(false)} disabled={busy}>Mark as not done</Button> : <Button onClick={() => void mark(true)} disabled={busy} data-testid="mark-done">Mark as done</Button>}
            {onNext && <Button variant="ghost" onClick={onNext}>Next lesson</Button>}
          </div>
        ) : null}
    </Card>
  );
}

function PageLesson({ course, lesson }: { course: Course; lesson: Lesson }) {
  const base = course.guest ? "/guest" : "";
  const q = useQuery({ queryKey: ["course-page", course.id, lesson.id], queryFn: () => api.get<{ page: { id: string; title: string; text: string } | null }>(`${base}/courses/${course.id}/lessons/${lesson.id}/page`) });
  if (q.isPending) return <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>;
  if (q.error) return <LoadErrorInline onRetry={() => q.refetch()} />;
  if (!q.data.page) return <p className="text-[14px] text-muted">This page was removed or you can't open it.</p>;
  return (
    <div className="space-y-3">
      <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-fill/50 p-4 text-[14.5px] leading-6" data-testid="lesson-page-text">{q.data.page.text || "This page is empty."}</div>
      {!course.guest && <Link to={`/app/docs/${q.data.page.id}`} className="inline-flex items-center gap-1 text-[13.5px] text-brand underline-offset-2 hover:underline">Open in Docs</Link>}
    </div>
  );
}

function QuizView({ course, lesson, me, onNext }: { course: Course; lesson: Lesson; me: Me | null; onNext?: () => void }) {
  const qc = useQueryClient();
  const qs = lesson.questions ?? (lesson.quiz ?? []).map((q) => ({ id: q.id, prompt: q.prompt, type: q.type, options: q.options }));
  const [answers, setAnswers] = useState<Record<string, number | number[] | string>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [retake, setRetake] = useState(false);
  const mine = me?.lessons[lesson.id];
  const passMark = lesson.passMark ?? course.passMark;
  if (!course.canLearn) return <p className="text-[14px] text-muted">{qs.length === 1 ? "1 question" : `${qs.length} questions`}. Pass mark {passMark}%.</p>;
  if (!me) return <p className="text-[14px] text-muted">Start the course to take this quiz.</p>;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ result: QuizResult; detail: Detail }>(`/courses/${course.id}/lessons/${lesson.id}/quiz`, { answers });
      setResult(r.result);
      qc.setQueryData(key(course.id), r.detail);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const wrong = new Set(result?.wrong ?? []);
  if (mine?.passed && !result && !retake) return (
    <div className="space-y-3">
      <div role="status" className="rounded-lg border border-ok/40 bg-ok/10 p-3 text-[14px]"><p className="font-medium">You passed this quiz{mine.bestScore !== null ? ` with ${mine.bestScore}%` : ""}</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setRetake(true)}>Take it again</Button>{onNext && <Button variant="ghost" onClick={onNext}>Next lesson</Button>}</div>
    </div>
  );
  return (
    <div className="space-y-4">
      <p className="text-[13.5px] text-muted">{qs.length === 1 ? "1 question" : `${qs.length} questions`}. Pass mark {passMark}%.{mine?.bestScore !== null && mine?.bestScore !== undefined ? ` Your best so far: ${mine.bestScore}%.` : ""}</p>
      {result && (
        <div role="status" className={cn("rounded-lg border p-3 text-[14px]", result.passed ? "border-ok/40 bg-ok/10" : "border-bad/40 bg-bad/10")} data-testid="quiz-result">
          <p className="font-medium">{result.passed ? `You passed with ${result.score}%` : `You scored ${result.score}%. You need ${result.passMark}% to pass.`}</p>
          <p className="text-[13px] text-muted">{result.right} of {result.total} right.{!result.passed ? " Look again at the questions marked below and try again." : ""}</p>
        </div>
      )}
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {qs.map((q, i) => (
          <fieldset key={q.id} className={cn("space-y-2 rounded-lg border p-4", wrong.has(q.id) ? "border-bad/50" : "border-line")} aria-describedby={wrong.has(q.id) ? `${q.id}-wrong` : undefined}>
            <legend className="px-1 text-[14px] font-medium">{i + 1}. {q.prompt}</legend>
            {wrong.has(q.id) && <p id={`${q.id}-wrong`} className="text-[12.5px] text-bad">Not quite right</p>}
            {q.type === "short" ? (
              <Input aria-label={q.prompt} value={String(answers[q.id] ?? "")} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} maxLength={300} />
            ) : q.options.map((o, oi) => {
              const multi = q.type === "multi";
              const picked = multi ? ((answers[q.id] as number[] | undefined) ?? []).includes(oi) : answers[q.id] === oi;
              return (
                <label key={oi} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-hover/60">
                  <input type={multi ? "checkbox" : "radio"} name={q.id} className="h-4 w-4 accent-brand focus-visible:ring-2 focus-visible:ring-brand" checked={picked}
                    onChange={() => setAnswers((a) => {
                      if (!multi) return { ...a, [q.id]: oi };
                      const cur = (a[q.id] as number[] | undefined) ?? [];
                      return { ...a, [q.id]: cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi] };
                    })} />
                  <span className="text-[14px]">{o}</span>
                </label>
              );
            })}
            {q.type === "multi" && <p className="text-[12px] text-muted">Pick all that apply.</p>}
          </fieldset>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy} data-testid="submit-quiz">{result && !result.passed ? "Try again" : "Submit answers"}</Button>
          {(mine?.passed || result?.passed) && onNext && <Button type="button" variant="ghost" onClick={onNext}>Next lesson</Button>}
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- build

function BuildTab({ detail }: { detail: Detail }) {
  const { course, lessons } = detail;
  const qc = useQueryClient();
  const { confirm, dialogs } = useDialogs();
  const [editing, setEditing] = useState<Lesson | "new" | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key(course.id) });
  const move = async (l: Lesson, dir: "up" | "down") => { try { await api.post(`/courses/${course.id}/lessons/${l.id}/move`, { dir }); await refresh(); } catch (e) { showError(e as Error); } };
  const remove = async (l: Lesson) => {
    if (!(await confirm({ title: `Remove the lesson ${l.title}?`, description: "Learners' progress on it is no longer counted.", confirmLabel: "Remove lesson" }))) return;
    try { await api.del(`/courses/${course.id}/lessons/${l.id}`); await refresh(); toast.success("Lesson removed"); } catch (e) { showError(e as Error); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13.5px] text-muted">{lessons.length ? `${lessons.length} lessons. Learners go through them in this order.` : "Lessons can be a Docs page, a file or video link, a short text or a quiz."}</p>
        <Button onClick={() => setEditing("new")} data-testid="add-lesson"><IconPlus className="h-4 w-4" />Add lesson</Button>
      </div>
      {!lessons.length ? <EmptyState icon={<IconBook />} title="Add the first lesson" body="Start with a Docs page you already have, then add a quiz to check what people learned." action={<Button onClick={() => setEditing("new")}>Add lesson</Button>} /> : (
        <ol className="divide-y divide-line rounded-xl border border-line">
          {lessons.map((l, i) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid={`build-lesson-${i}`}>
              <span className="w-6 text-[13px] text-muted">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <button type="button" className="break-words text-left text-[14px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" onClick={() => setEditing(l)}>{l.title}</button>
                <div className="text-[12.5px] text-muted">{LESSON_LABEL[l.type]}{l.type === "quiz" ? `, ${l.questionCount === 1 ? "1 question" : `${l.questionCount} questions`}` : ""}{l.required ? "" : ", optional"}</div>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" aria-label={`Move ${l.title} up`} disabled={i === 0} onClick={() => void move(l, "up")}><IconArrowUp className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" aria-label={`Move ${l.title} down`} disabled={i === lessons.length - 1} onClick={() => void move(l, "down")}><IconArrowDown className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" aria-label={`Remove ${l.title}`} onClick={() => void remove(l)}><IconTrash className="h-4 w-4" /></Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {editing && <LessonDialog course={course} lesson={editing === "new" ? null : editing} afterId={lessons[lessons.length - 1]?.id ?? null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} />}
      {dialogs}
    </div>
  );
}

let qn = 0;
const newQuestion = (type: QuestionType = "single"): Question => ({ id: `q${Date.now().toString(36)}${(qn++).toString(36)}`, prompt: "", type, options: type === "short" ? [] : ["", ""], correct: [], accepted: type === "short" ? [""] : [] });

function LessonDialog({ course, lesson, afterId, onClose, onSaved }: { course: Course; lesson: Lesson | null; afterId: string | null; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<LessonType>(lesson?.type ?? "page");
  const [title, setTitle] = useState(lesson?.title ?? "");
  const [refDocId, setRefDocId] = useState(lesson?.refDocId ?? "");
  const [url, setUrl] = useState(lesson?.url ?? "");
  const [body, setBody] = useState(lesson?.body ?? "");
  const [required, setRequired] = useState(lesson?.required ?? true);
  const [passMark, setPassMark] = useState(lesson?.passMark === null || lesson?.passMark === undefined ? "" : String(lesson.passMark));
  const [quiz, setQuiz] = useState<Question[]>(lesson?.quiz?.length ? lesson.quiz : [newQuestion()]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pages = useQuery({ queryKey: ["docs", ""], enabled: type === "page", queryFn: async () => (await api.get<{ docs: { id: string; title: string; kind?: string }[] }>("/docs")).docs });
  const save = async () => {
    setError("");
    if (!title.trim()) { setError("Give the lesson a title."); return; }
    const payload: Record<string, unknown> = { title: title.trim(), body, required };
    if (type === "page") payload.refDocId = refDocId || null;
    if (type === "file" || type === "video") payload.url = url.trim() || null;
    if (type === "quiz") { payload.quiz = quiz; payload.passMark = passMark === "" ? null : Number(passMark); }
    setBusy(true);
    try {
      if (lesson) await api.patch(`/courses/${course.id}/lessons/${lesson.id}`, payload);
      else await api.post(`/courses/${course.id}/lessons`, { ...payload, type, afterId });
      toast.success(lesson ? "Lesson saved" : "Lesson added");
      onSaved();
    } catch (e) { if (e instanceof ApiError && e.status === 422) setError(e.message); else showError(e as Error); } finally { setBusy(false); }
  };
  const setQ = (i: number, patch: Partial<Question>) => setQuiz((list) => list.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  return (
    <Dialog open onClose={onClose} title={lesson ? "Edit lesson" : "Add lesson"} className="max-w-2xl"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy} data-testid="save-lesson">{lesson ? "Save lesson" : "Add lesson"}</Button></>}>
      <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
        {!lesson && (
          <Field label="Kind of lesson">{(fp) => <Select {...fp} value={type} onChange={(e) => setType(e.target.value as LessonType)} data-testid="lesson-type">{LESSON_TYPES.map((t) => <option key={t} value={t}>{LESSON_LABEL[t]}</option>)}</Select>}</Field>
        )}
        <Field label="Title">{(fp) => <Input {...fp} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} data-testid="lesson-title" />}</Field>
        {type === "page" && (
          <Field label="Docs page" hint="Learners read it inside the course.">{(fp) => (
            <Select {...fp} value={refDocId} onChange={(e) => { setRefDocId(e.target.value); if (!title.trim()) setTitle(pages.data?.find((p) => p.id === e.target.value)?.title ?? ""); }} data-testid="lesson-page">
              <option value="">{pages.isPending ? "Loading pages" : "Choose a page"}</option>
              {(pages.data ?? []).filter((p) => p.kind !== "course").map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </Select>
          )}</Field>
        )}
        {(type === "file" || type === "video") && <Field label={type === "video" ? "Video link" : "File link"} hint="A link that starts with https://">{(fp) => <Input {...fp} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" data-testid="lesson-url" />}</Field>}
        <Field label={type === "text" ? "Text" : "Note for learners (optional)"}>{(fp) => <Textarea {...fp} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} className="min-h-24" data-testid="lesson-body" />}</Field>
        {type === "quiz" && (
          <div className="space-y-3">
            <Field label="Pass mark for this quiz (%)" hint={`Leave empty to use the course pass mark (${course.passMark}%).`}>{(fp) => <Input {...fp} inputMode="numeric" value={passMark} onChange={(e) => setPassMark(e.target.value.replace(/\D/g, "").slice(0, 3))} className="max-w-32" />}</Field>
            {quiz.map((q, i) => (
              <Card key={q.id} className="space-y-3 p-4" data-testid={`question-${i}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">Question {i + 1}</span>
                  <Select aria-label={`Question ${i + 1} kind`} value={q.type} className="ml-auto w-auto" onChange={(e) => { const t = e.target.value as QuestionType; setQ(i, { type: t, options: t === "short" ? [] : q.options.length ? q.options : ["", ""], correct: [], accepted: t === "short" ? [""] : [] }); }}>
                    <option value="single">One right answer</option><option value="multi">Several right answers</option><option value="short">Short answer</option>
                  </Select>
                  <Button size="sm" variant="ghost" aria-label={`Remove question ${i + 1}`} disabled={quiz.length === 1} onClick={() => setQuiz((l) => l.filter((_, j) => j !== i))}><IconTrash className="h-4 w-4" /></Button>
                </div>
                <Input aria-label={`Question ${i + 1}`} placeholder="Question" value={q.prompt} maxLength={1000} onChange={(e) => setQ(i, { prompt: e.target.value })} />
                {q.type === "short" ? (
                  <Field label="Accepted answers" hint="One per line. Capitals and spaces at the ends don't matter.">{(fp) => <Textarea {...fp} value={q.accepted.join("\n")} onChange={(e) => setQ(i, { accepted: e.target.value.split("\n").slice(0, 10) })} className="min-h-16" />}</Field>
                ) : (
                  <div className="space-y-2">
                    {q.options.map((o, oi) => (
                      <div key={oi} className="flex items-center gap-2">
                        <input type={q.type === "multi" ? "checkbox" : "radio"} name={`right-${q.id}`} aria-label={`Option ${oi + 1} is right`} className="h-4 w-4 accent-brand" checked={q.correct.includes(oi)}
                          onChange={() => setQ(i, { correct: q.type === "multi" ? (q.correct.includes(oi) ? q.correct.filter((x) => x !== oi) : [...q.correct, oi]) : [oi] })} />
                        <Input aria-label={`Option ${oi + 1}`} placeholder={`Option ${oi + 1}`} value={o} maxLength={300} onChange={(e) => setQ(i, { options: q.options.map((x, k) => (k === oi ? e.target.value : x)) })} />
                        <Button size="sm" variant="ghost" aria-label={`Remove option ${oi + 1}`} disabled={q.options.length <= 2} onClick={() => setQ(i, { options: q.options.filter((_, k) => k !== oi), correct: q.correct.filter((x) => x !== oi).map((x) => (x > oi ? x - 1 : x)) })}><IconTrash className="h-4 w-4" /></Button>
                      </div>
                    ))}
                    <div className="flex flex-wrap items-center gap-3">
                      {q.options.length < 10 && <Button size="sm" variant="secondary" onClick={() => setQ(i, { options: [...q.options, ""] })}><IconPlus className="h-4 w-4" />Add option</Button>}
                      <span className="text-[12px] text-muted">Tick the right {q.type === "multi" ? "answers" : "answer"}.</span>
                    </div>
                  </div>
                )}
              </Card>
            ))}
            {quiz.length < 50 && <Button variant="secondary" onClick={() => setQuiz((l) => [...l, newQuestion()])} data-testid="add-question"><IconPlus className="h-4 w-4" />Add question</Button>}
          </div>
        )}
        <LabeledSwitch checked={required} onChange={setRequired} label="Learners must finish this lesson" />
        {error && <p role="alert" className="text-[13px] text-bad" data-testid="lesson-error">{error}</p>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- assign

function PeoplePicker({ value, onChange, label }: { value: string[]; onChange: (v: string[]) => void; label: string }) {
  const people = useAssignees();
  const [q, setQ] = useState("");
  const list = (people.data ?? []).filter((p) => p.type === "member" && !isAgentLike(p));
  const shown = list.filter((p) => !q || `${p.name} ${p.email ?? ""}`.toLowerCase().includes(q.toLowerCase())).slice(0, 100);
  return (
    <fieldset className="space-y-2">
      <legend className="text-[13px] font-medium">{label}</legend>
      <Input aria-label={`Search ${label.toLowerCase()}`} placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
        {people.isPending ? <div className="space-y-2 p-3"><Skeleton className="h-5" /><Skeleton className="h-5" /></div>
          : !shown.length ? <p className="p-3 text-[13px] text-muted">No one matches.</p>
          : shown.map((p) => (
            <label key={p.id} className="flex min-h-11 cursor-pointer items-center gap-3 px-3 hover:bg-hover/60">
              <input type="checkbox" className="h-4 w-4 accent-brand" checked={value.includes(p.id)} onChange={() => onChange(value.includes(p.id) ? value.filter((x) => x !== p.id) : [...value, p.id])} />
              <span className="min-w-0 flex-1 truncate text-[14px]">{p.name}</span><span className="hidden truncate text-[12.5px] text-muted sm:inline">{p.email}</span>
            </label>
          ))}
      </div>
    </fieldset>
  );
}

function AssignTab({ detail }: { detail: Detail }) {
  const { course } = detail;
  const qc = useQueryClient();
  const [people, setPeople] = useState<string[]>([]);
  const [everyone, setEveryone] = useState(false);
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  if (course.status !== "published") return <EmptyState icon={<IconBook />} title="Publish the course first" body="Once it is published you can assign it to people with a due date." />;
  const assign = async () => {
    setBusy(true);
    try {
      const dueAt = due ? new Date(`${due}T17:00:00`).getTime() : null;
      const r = await api.post<{ assigned: number; added: number }>(`/courses/${course.id}/assign`, everyone ? { everyone: true, dueAt } : { userIds: people, dueAt });
      toast.success(r.assigned === 1 ? "Assigned to 1 person" : `Assigned to ${r.assigned} people`);
      setPeople([]); setEveryone(false);
      void qc.invalidateQueries({ queryKey: ["course-progress", course.id] });
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card className="space-y-4 p-5">
        <h2 className="text-[16px] font-semibold">Assign this course</h2>
        <LabeledSwitch checked={everyone} onChange={setEveryone} label="Everyone in the workspace" />
        {!everyone && <PeoplePicker value={people} onChange={setPeople} label="People" />}
        <Field label="Due date (optional)" hint="People get a reminder two days before and when it is overdue.">{(fp) => <DateInput {...fp} value={due} min={today} onChange={(e) => setDue(e.target.value)} data-testid="assign-due" />}</Field>
        <Button onClick={() => void assign()} disabled={busy || (!everyone && !people.length)} data-testid="assign-course">{everyone ? "Assign to everyone" : people.length ? `Assign to ${people.length}` : "Assign"}</Button>
      </Card>
      {course.canSeeProgress && <LearnerList course={course} />}
    </div>
  );
}

function useProgress(courseId: string) {
  return useQuery({ queryKey: ["course-progress", courseId], queryFn: () => api.get<{ rows: ProgressRow[]; counts: { learners: number; completed: number; overdue: number } }>(`/courses/${courseId}/progress`) });
}

function LearnerList({ course }: { course: Course }) {
  const q = useProgress(course.id);
  const qc = useQueryClient();
  const { confirm, dialogs } = useDialogs();
  const remove = async (r: ProgressRow) => {
    if (!(await confirm({ title: `Remove ${r.name} from this course?`, description: "Their progress is kept if they start it again.", confirmLabel: "Remove" }))) return;
    try { await api.del(`/courses/${course.id}/learners/${r.id}`); void qc.invalidateQueries({ queryKey: ["course-progress", course.id] }); } catch (e) { showError(e as Error); }
  };
  return (
    <Card className="space-y-3 p-5">
      <h2 className="text-[16px] font-semibold">Learners</h2>
      {q.isPending ? <Skeleton className="h-24" /> : q.error ? <LoadErrorInline onRetry={() => q.refetch()} />
        : !q.data.rows.length ? <p className="text-[13.5px] text-muted">No one has this course yet.</p>
        : <ul className="divide-y divide-line">{q.data.rows.map((r) => (
          <li key={r.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1"><div className="truncate text-[14px]">{r.name}</div><div className="text-[12.5px] text-muted">{r.dueAt ? `Due ${day(r.dueAt)}` : r.source === "self" ? "Started on their own" : "No due date"}</div></div>
            <Badge tone={statusTone(r.status)}>{r.statusLabel}</Badge>
            <Button size="sm" variant="ghost" aria-label={`Remove ${r.name}`} onClick={() => void remove(r)}><IconTrash className="h-4 w-4" /></Button>
          </li>
        ))}</ul>}
      {dialogs}
    </Card>
  );
}

// ---------------------------------------------------------------- progress

function ProgressTab({ detail }: { detail: Detail }) {
  const { course } = detail;
  const q = useProgress(course.id);
  if (q.isPending) return <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-40" /></div>;
  if (q.error) return <LoadError onRetry={() => q.refetch()} />;
  const { rows, counts } = q.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-[13.5px] text-muted">{counts.learners === 1 ? "1 learner" : `${counts.learners} learners`}, {counts.completed} completed{counts.overdue ? `, ${counts.overdue} overdue` : ""}</p>
        {rows.length > 0 && <a href={`/api/courses/${course.id}/progress.csv`} download className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-[14px] font-medium hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" data-testid="export-csv"><IconDownload className="h-4 w-4" />Export CSV</a>}
      </div>
      {!rows.length ? <EmptyState icon={<IconBook />} title="No learners yet" body={course.canBuild ? "Assign the course to see progress here." : "Progress shows here once people start."} /> : (
        <>
          <div className={cn(tableStyles.wrap, "hidden md:block")} role="region" aria-label="Progress of each learner" tabIndex={0}>
            <table className={tableStyles.table} data-testid="progress-table">
              <thead className={tableStyles.head}><tr><th className={tableStyles.th}>Name</th><th className={tableStyles.th}>Status</th><th className={tableStyles.th}>Progress</th><th className={tableStyles.th}>Quiz score</th><th className={tableStyles.th}>Due</th><th className={tableStyles.th}>Completed</th></tr></thead>
              <tbody className={tableStyles.body}>{rows.map((r) => (
                <tr key={r.id} className={tableStyles.row}>
                  <td className={tableStyles.td}><div className="font-medium">{r.name}</div><div className="text-[12.5px] text-muted">{r.email}</div></td>
                  <td className={cn(tableStyles.td, "whitespace-nowrap")}><Badge tone={statusTone(r.status)}>{r.statusLabel}</Badge></td>
                  <td className={cn(tableStyles.td, "min-w-36")}><ProgressBar value={r.percent} label="Progress" /></td>
                  <td className={tableStyles.td}>{r.bestScore === null ? "" : `${r.bestScore}%`}</td>
                  <td className={cn(tableStyles.td, "whitespace-nowrap")}>{day(r.dueAt)}</td>
                  <td className={cn(tableStyles.td, "whitespace-nowrap")}>{day(r.completedAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <ul className="space-y-2 md:hidden">{rows.map((r) => (
            <li key={r.id}><Card className="space-y-2 p-4">
              <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{r.name}</span><Badge tone={statusTone(r.status)}>{r.statusLabel}</Badge></div>
              <ProgressBar value={r.percent} label="Progress" />
              <div className="text-[12.5px] text-muted">{[r.bestScore !== null ? `Quiz ${r.bestScore}%` : "", r.dueAt ? `Due ${day(r.dueAt)}` : "", r.completedAt ? `Completed ${day(r.completedAt)}` : ""].filter(Boolean).join(", ")}</div>
            </Card></li>
          ))}</ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings

function SettingsTab({ detail }: { detail: Detail }) {
  const { course } = detail;
  const qc = useQueryClient();
  const me = useMe();
  const [passMark, setPassMark] = useState(String(course.passMark));
  const [certificate, setCertificate] = useState(course.certificate);
  const [editors, setEditors] = useState<string[]>(course.editors ?? []);
  const [managers, setManagers] = useState<string[]>(course.managers ?? []);
  const [busy, setBusy] = useState(false);
  const role = (me.data as { role?: string } | undefined)?.role;
  const userId = (me.data as { user?: { id?: string } } | undefined)?.user?.id;
  const canPeople = role === "owner" || role === "admin" || (!!userId && userId === course.createdBy);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.patch<Detail>(`/courses/${course.id}`, { passMark: Math.min(100, Math.max(0, Number(passMark) || 0)), certificate, ...(canPeople ? { editors, managers } : {}) });
      qc.setQueryData(key(course.id), r);
      toast.success("Settings saved");
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Card className="max-w-2xl space-y-5 p-5">
      <Field label="Pass mark (%)" hint="A quiz is passed at this score unless the quiz sets its own.">{(fp) => <Input {...fp} inputMode="numeric" value={passMark} onChange={(e) => setPassMark(e.target.value.replace(/\D/g, "").slice(0, 3))} className="max-w-32" data-testid="pass-mark" />}</Field>
      <LabeledSwitch checked={certificate} onChange={setCertificate} label="Give a certificate when someone finishes" />
      {canPeople && <PeoplePicker value={editors} onChange={setEditors} label="Course editors (can build and assign)" />}
      {canPeople && <PeoplePicker value={managers} onChange={setManagers} label="Managers (can see everyone's progress)" />}
      <Button onClick={() => void save()} disabled={busy}>Save settings</Button>
    </Card>
  );
}

// ---------------------------------------------------------------- my learning

export function MyLearningPage() {
  const on = useCoursesOn();
  const cfg = useConfig();
  const flag = !!(cfg.data as { coursesR129?: boolean } | undefined)?.coursesR129;
  const q = useQuery({ queryKey: ["my-learning"], enabled: flag, queryFn: () => api.get<{ items: { courseId: string; title: string; source: string; dueAt: number | null; completedAt: number | null; percent: number; lessons: number; status: LearnerStatus; hasCertificate: boolean }[] }>("/courses/learning") });
  const [newCourse, setNewCourse] = useState(false);
  const me = useMe();
  const role = (me.data as { role?: string } | undefined)?.role;
  usePageTitle(["My learning", "Docs"]); // POL1 (MB-321)
  if (cfg.isSuccess && !flag) return <EmptyState icon={<IconBook />} title="Courses are not on for this workspace" body="Ask an admin if you expected to see your courses here." />;
  const items = q.data?.items ?? [];
  const groups: { title: string; list: typeof items }[] = [
    { title: "Assigned to you", list: items.filter((i) => i.status !== "completed" && i.source === "assigned") },
    { title: "In progress", list: items.filter((i) => i.status !== "completed" && i.source !== "assigned") },
    { title: "Completed", list: items.filter((i) => i.status === "completed") },
  ];
  return (
    <div className="mx-auto max-w-4xl" data-testid="my-learning">
      <Link to="/app/docs" className="mb-2 inline-flex min-h-11 items-center gap-1 text-[13px] text-muted hover:text-fg"><IconArrowLeft className="h-4 w-4" />Docs</Link>
      <PageHeader title="My learning" description="Courses assigned to you and the ones you started, with your progress and certificates."
        actions={on && (role === "owner" || role === "admin") ? <Button onClick={() => setNewCourse(true)}><IconPlus className="h-4 w-4" />New course</Button> : undefined} />
      {q.isPending ? <div className="space-y-2" aria-busy="true"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
        : q.error ? <LoadError onRetry={() => q.refetch()} />
        : !items.length ? <EmptyState icon={<IconBook />} title="Nothing to learn yet" body={role === "owner" || role === "admin" ? "Make a course from your docs and assign it to your team." : "Courses assigned to you show up here."} />
        : groups.filter((g) => g.list.length).map((g) => (
          <section key={g.title} className="mb-6">
            <h2 className="mb-2 text-[13px] font-medium text-muted">{g.title}</h2>
            <ul className="space-y-2">{g.list.map((i) => (
              <li key={i.courseId}>
                <Card className="flex flex-wrap items-center gap-3 p-4">
                  <IconBook className="h-5 w-5 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <Link to={`/app/docs/${i.courseId}`} className="break-words text-[14.5px] font-medium hover:underline">{i.title}</Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                      <Badge tone={statusTone(i.status)}>{STATUS_LABEL[i.status]}</Badge>
                      {i.dueAt && !i.completedAt && <span>Due {day(i.dueAt)}</span>}{i.completedAt && <span>Completed {day(i.completedAt)}</span>}<span>{i.lessons} lessons</span>
                    </div>
                  </div>
                  <div className="w-full sm:w-40"><ProgressBar value={i.percent} label="Progress" /></div>
                  {i.hasCertificate && <a href={`/api/courses/${i.courseId}/certificate.pdf`} download className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-[13.5px] font-medium hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><IconDownload className="h-4 w-4" />Certificate</a>}
                </Card>
              </li>
            ))}</ul>
          </section>
        ))}
      {newCourse && <NewCourseDialog open onClose={() => setNewCourse(false)} />}
    </div>
  );
}

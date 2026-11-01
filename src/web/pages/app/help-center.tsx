/**
 * R122: Docs > Help center (/app/docs/help-center). A public knowledge base and Q&A for the workspace: articles are
 * published snapshots of docs, questions come from visitors (moderated) or from solved tickets. Owners and admins change
 * things; members read and answer questions.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import {
  IconBook, IconChatQuote, IconCheck, IconExternalLink, IconEye, IconHelp, IconPlus, IconRefresh, IconSearch, IconTrash,
} from "@/web/components/ui/icon";
import { POST_STATUS_LABEL, centerSlugProblem, helpfulPercent, type HelpCenterSettings, type PostStatus } from "@/shared/help-center";
import { LoadError } from "@/web/components/load-error-t1g";
import { isServerLoadError } from "@/web/lib/load-errors-t1g";

export interface CenterOut {
  settings: HelpCenterSettings | null; suggestedSlug: string; orgName: string; canEdit: boolean; url: string | null;
  counts: { published: number; drafts: number; waitingQuestions: number; waitingAnswers: number } | null;
}
interface Category { id: string; name: string; slug: string; description: string; position: number; articles: number }
interface Article {
  id: string; slug: string; title: string; summary: string; categoryId: string | null; docId: string | null; status: "draft" | "published"; position: number;
  helpfulYes: number; helpfulNo: number; views: number; publishedAt: number | null; updatedAt: number; docChanged: boolean; docGone: boolean;
}
interface Question {
  id: string; title: string; body: string; authorName: string; source: "public" | "ticket" | "team"; status: PostStatus; votes: number; answerCount: number;
  acceptedAnswerId: string | null; categoryId: string | null; createdAt: number; waitingAnswers?: number;
}
interface QuestionDetail extends Question { url: string | null; answers: { id: string; body: string; authorKind: "team" | "visitor"; authorName: string; status: PostStatus; votes: number; createdAt: number; accepted: boolean }[] }
interface Feedback { id: string; helpful: boolean; comment: string | null; createdAt: number; articleId: string; title: string }

const KEY = ["help-center"];
export const useCenter = () => useQuery({ queryKey: KEY, queryFn: () => api.get<CenterOut>("/help-center") });
const useCategories = (on: boolean) => useQuery({ queryKey: [...KEY, "categories"], enabled: on, queryFn: () => api.get<{ categories: Category[] }>("/help-center/categories") });
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const TABS = [["articles", "Articles"], ["questions", "Questions"], ["categories", "Categories"], ["feedback", "Feedback"], ["settings", "Settings"]] as const;
type Tab = (typeof TABS)[number][0];

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

/** F12 (MB-299): a refused read (4xx) keeps the server's own words; a failed one shows the shared Retry card. */
function ErrorCard({ error, retry }: { error: unknown; retry: () => void }) {
  if (isServerLoadError(error)) return <Card><LoadError onRetry={retry} /></Card>;
  return (
    <Card className="p-6 text-center" role="alert">
      <p className="font-medium">{errorMessage(error)}</p>
      <Button className="mt-4" variant="secondary" onClick={retry}><IconRefresh className="h-4 w-4" aria-hidden />Try again</Button>
    </Card>
  );
}

function ListSkeleton() {
  return <Card className="divide-y divide-line" aria-busy="true" aria-label="Loading">{[0, 1, 2, 3].map((i) => <div key={i} className="flex items-center gap-4 p-4"><Skeleton className="h-4 w-1/2" /><Skeleton className="ml-auto h-4 w-16" /></div>)}</Card>;
}

export function HelpCenterPage() {
  const center = useCenter();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([k]) => k === params.get("tab")) ? params.get("tab") : "articles") as Tab;
  const [publishOpen, setPublishOpen] = useState(false);
  if (center.isPending) return <div className="mx-auto max-w-5xl"><Skeleton className="mb-6 h-8 w-48" /><ListSkeleton /></div>;
  if (center.isError) return <div className="mx-auto max-w-5xl"><ErrorCard error={center.error} retry={() => center.refetch()} /></div>;
  const c = center.data;
  if (!c.settings) return <div className="mx-auto max-w-3xl"><PageHeader title="Help center" description="Answers your customers can find on their own: articles from your docs, questions with votes and best answers." /><SetupCard c={c} /></div>;
  const s = c.settings;
  const waiting = (c.counts?.waitingQuestions ?? 0) + (c.counts?.waitingAnswers ?? 0);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Help center"
        description={s.on ? <span className="inline-flex flex-wrap items-center gap-2">Live at <a className="break-all font-medium text-fg underline underline-offset-2 hover:text-brand" href={c.url ?? "#"} target="_blank" rel="noreferrer">{c.url?.replace(/^https?:\/\//, "")}</a>{c.url && <CopyButton value={c.url} label="Copy link" toastText="Link copied" />}</span> : "Turned off: visitors see nothing until you turn it on in Settings."}
        actions={<>
          {c.url && s.on && <a className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong px-4 text-sm font-medium hover:bg-hover max-sm:min-h-11" href={c.url} target="_blank" rel="noreferrer"><IconExternalLink className="h-4 w-4" aria-hidden />View help center</a>}
          {c.canEdit && <Button onClick={() => setPublishOpen(true)}><IconPlus className="h-4 w-4" aria-hidden />Publish a doc</Button>}
        </>}
      />
      <div role="tablist" aria-label="Help center" className="-mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-line px-1">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setParams((p) => { p.set("tab", k); return p; }, { replace: true })}
            className={cn("relative -mb-px inline-flex min-h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors max-sm:min-h-11", tab === k ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>
            {label}{k === "questions" && waiting > 0 && <Badge tone="warn">{waiting}</Badge>}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "articles" && <ArticlesTab c={c} onPublish={() => setPublishOpen(true)} />}
        {tab === "questions" && <QuestionsTab c={c} />}
        {tab === "categories" && <CategoriesTab c={c} />}
        {tab === "feedback" && <FeedbackTab />}
        {tab === "settings" && <SettingsTab c={c} />}
      </div>
      {publishOpen && <PublishDocDialog onClose={() => setPublishOpen(false)} />}
    </div>
  );
}

function SetupCard({ c }: { c: CenterOut }) {
  const inv = useInvalidate();
  const [name, setName] = useState(c.orgName);
  const [slug, setSlug] = useState(c.suggestedSlug.length >= 3 ? c.suggestedSlug : `${c.suggestedSlug}-help`);
  const problem = centerSlugProblem(slug);
  const save = useMutation({ mutationFn: () => api.patch("/help-center", { name, slug, on: true }), onSuccess: () => { toast.success("Your help center is live"); inv(); }, onError: (e) => toast.error(errorMessage(e)) });
  if (!c.canEdit) return <Card><EmptyState icon={<IconHelp className="h-5 w-5" />} title="No help center yet" body="Ask an owner or admin to set it up. You can then answer questions here." /></Card>;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <Card className="p-6">
      <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-fill"><IconBook className="h-5 w-5" aria-hidden /></span>
        <div><h2 className="text-base font-semibold">Set up your help center</h2><p className="mt-1 text-sm text-muted">Only what you publish is public. Your docs stay private until you choose one and press Publish.</p></div></div>
      <form className="mt-5 grid gap-4" onSubmit={(e) => { e.preventDefault(); if (!problem) save.mutate(); }}>
        <label className="block text-sm font-medium">Name<Input className="mt-1" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        <label className="block text-sm font-medium">Address
          <div className="mt-1 flex items-center rounded-lg border border-line focus-within:ring-2 focus-within:ring-brand/30"><span className="shrink-0 pl-3 text-sm text-subtle max-sm:hidden">{origin}/help/</span><input aria-describedby="slug-hint" className="h-9 min-w-0 flex-1 bg-transparent px-2 text-sm outline-none max-sm:h-11" value={slug} maxLength={60} onChange={(e) => setSlug(e.target.value.toLowerCase())} /></div>
          <span id="slug-hint" className={cn("mt-1 block text-xs font-normal", problem ? "text-bad" : "text-subtle")}>{problem ?? "Lowercase letters, numbers and hyphens."}</span>
        </label>
        <div><Button type="submit" loading={save.isPending} disabled={!!problem}>Turn on help center</Button></div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------------------------------------------

function ArticlesTab({ c, onPublish }: { c: CenterOut; onPublish: () => void }) {
  const inv = useInvalidate();
  const list = useQuery({ queryKey: [...KEY, "articles"], queryFn: () => api.get<{ articles: Article[] }>("/help-center/articles") });
  const cats = useCategories(true);
  const catName = useMemo(() => new Map((cats.data?.categories ?? []).map((x) => [x.id, x.name])), [cats.data]);
  const [del, setDel] = useState<Article | null>(null);
  const act = useMutation({
    mutationFn: ({ a, op }: { a: Article; op: "publish" | "unpublish" | "refresh" | "delete" }) =>
      op === "refresh" ? api.post(`/help-center/articles/${a.id}/refresh`) : op === "delete" ? api.del(`/help-center/articles/${a.id}`) : api.patch(`/help-center/articles/${a.id}`, { status: op === "publish" ? "published" : "draft" }),
    onSuccess: (_d, v) => { toast.success({ publish: "Article is live", unpublish: "Article is hidden", refresh: "Public page updated from the doc", delete: "Article removed" }[v.op]); setDel(null); inv(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (list.isPending) return <ListSkeleton />;
  if (list.isError) return <ErrorCard error={list.error} retry={() => list.refetch()} />;
  const rows = list.data.articles;
  if (!rows.length) return <Card><EmptyState icon={<IconBook className="h-5 w-5" />} title="No articles yet" body="Pick a doc and publish it. Visitors see a copy; your edits stay private until you press Update." action={c.canEdit ? <Button onClick={onPublish}><IconPlus className="h-4 w-4" aria-hidden />Publish a doc</Button> : undefined} /></Card>;
  const link = (a: Article) => (c.url ? `${c.url}/a/${a.slug}` : "#");
  const actions = (a: Article) => c.canEdit && (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {a.docChanged && <Button size="sm" variant="outline" onClick={() => act.mutate({ a, op: "refresh" })} loading={act.isPending && act.variables?.a.id === a.id && act.variables.op === "refresh"}><IconRefresh className="h-3.5 w-3.5" aria-hidden />Update</Button>}
      <Button size="sm" variant="ghost" onClick={() => act.mutate({ a, op: a.status === "published" ? "unpublish" : "publish" })}>{a.status === "published" ? "Hide" : "Publish"}</Button>
      <Button size="icon" variant="ghost" aria-label={`Remove ${a.title}`} onClick={() => setDel(a)}><IconTrash className="h-4 w-4" aria-hidden /></Button>
    </div>
  );
  const status = (a: Article) => (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={a.status === "published" ? "ok" : "neutral"} dot>{a.status === "published" ? "Live" : "Draft"}</Badge>
      {a.docChanged && <Badge tone="warn">Doc changed</Badge>}{a.docGone && <Badge tone="bad">Doc deleted</Badge>}
    </span>
  );
  const helpful = (a: Article) => { const p = helpfulPercent(a.helpfulYes, a.helpfulNo); return p === null ? <span className="text-subtle">No votes</span> : <span>{p}% of {a.helpfulYes + a.helpfulNo}</span>; };
  return (
    <>
      <Card className="overflow-hidden max-md:hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="border-b border-line text-left text-xs font-medium text-muted"><tr><th className="w-[38%] px-4 py-2.5">Title</th><th className="w-[14%] px-3 py-2.5">Category</th><th className="w-[16%] px-3 py-2.5">Status</th><th className="w-[12%] px-3 py-2.5">Helpful</th><th className="w-[7%] px-3 py-2.5 text-right">Views</th><th className="w-[13%] px-4 py-2.5"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((a) => (
              <tr key={a.id} className="transition-colors hover:bg-hover/50">
                <td className="max-w-0 px-4 py-3"><a className="line-clamp-2 font-medium hover:underline" href={link(a)} target="_blank" rel="noreferrer">{a.title}</a>{a.summary && <p className="truncate text-xs text-muted">{a.summary}</p>}</td>
                <td className="truncate px-3 py-3 text-muted">{a.categoryId ? catName.get(a.categoryId) ?? "" : <span className="text-subtle">None</span>}</td>
                <td className="px-3 py-3">{status(a)}</td>
                <td className="px-3 py-3 whitespace-nowrap text-muted">{helpful(a)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-muted">{a.views}</td>
                <td className="px-4 py-3">{actions(a)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <ul className="grid gap-2 md:hidden" aria-label="Articles">
        {rows.map((a) => (
          <li key={a.id}><Card className="p-4">
            <a className="font-medium hover:underline" href={link(a)} target="_blank" rel="noreferrer">{a.title}</a>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">{status(a)}{a.categoryId && <span>{catName.get(a.categoryId)}</span>}<span className="inline-flex items-center gap-1"><IconEye className="h-3.5 w-3.5" aria-hidden />{a.views}</span>{helpful(a)}</div>
            {c.canEdit && <div className="mt-2 border-t border-line pt-2">{actions(a)}</div>}
          </Card></li>
        ))}
      </ul>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && act.mutate({ a: del, op: "delete" })} title="Remove this article?" description="It leaves the help center. The doc itself stays in Docs." confirmLabel="Remove" busy={act.isPending} />
    </>
  );
}

function PublishDocDialog({ onClose }: { onClose: () => void }) {
  const inv = useInvalidate();
  const [q, setQ] = useState("");
  const [docId, setDocId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [summary, setSummary] = useState("");
  const docs = useQuery({ queryKey: ["docs", "pick", q], queryFn: () => api.get<{ docs: { id: string; title: string; excerpt?: string }[] }>(`/docs${q ? `?q=${encodeURIComponent(q)}` : ""}`) });
  const cats = useCategories(true);
  const pub = useMutation({
    mutationFn: () => api.post("/help-center/articles", { docId, categoryId: categoryId || null, summary: summary || undefined }),
    onSuccess: () => { toast.success("Article is live"); inv(); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onClose={onClose} title="Publish a doc" description="Visitors see a copy of the doc as it is now. Later edits stay private until you press Update."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => pub.mutate()} disabled={!docId} loading={pub.isPending}>Publish</Button></>}>
      <label className="relative block"><span className="sr-only">Search docs</span><IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden /><Input className="pl-9" placeholder="Search docs" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></label>
      <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-line" role="listbox" aria-label="Docs">
        {docs.isPending ? <div className="space-y-2 p-3"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>
          : docs.isError ? <p className="p-3 text-sm text-bad">{errorMessage(docs.error)}</p>
          : !docs.data.docs.length ? <p className="p-3 text-sm text-muted">{q ? "No docs match." : "No docs yet. Write one in Docs first."}</p>
          : docs.data.docs.slice(0, 50).map((d) => (
            <button key={d.id} type="button" role="option" aria-selected={docId === d.id} onClick={() => setDocId(d.id)}
              className={cn("flex w-full min-h-11 items-center gap-2 border-b border-line px-3 py-2 text-left text-sm last:border-0 hover:bg-hover", docId === d.id && "bg-brand/10")}>
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{d.title || "Untitled"}</span>{d.excerpt && <span className="block truncate text-xs text-muted">{d.excerpt}</span>}</span>
              {docId === d.id && <IconCheck className="h-4 w-4 text-brand" aria-hidden />}
            </button>
          ))}
      </div>
      <label className="mt-4 block text-sm font-medium">Category<Select className="mt-1 w-full" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">None</option>{(cats.data?.categories ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></label>
      <label className="mt-4 block text-sm font-medium">Summary <span className="font-normal text-subtle">(optional, shows in lists and search)</span><Textarea className="mt-1" rows={2} maxLength={300} value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------------------------------------------

function QuestionsTab({ c }: { c: CenterOut }) {
  const [status, setStatus] = useState<PostStatus | "all">(c.counts?.waitingQuestions ? "pending" : "published");
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: [...KEY, "questions", status], queryFn: () => api.get<{ questions: Question[] }>(`/help-center/questions${status === "all" ? "" : `?status=${status}`}`) });
  const chip = (k: PostStatus | "all", label: string) => (
    <button type="button" aria-pressed={status === k} onClick={() => setStatus(k)} className={cn("min-h-8 rounded-full border px-3 text-[13px] font-medium transition-colors max-sm:min-h-11", status === k ? "border-brand bg-brand/10 text-fg" : "border-line text-muted hover:text-fg")}>{label}</button>
  );
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Show">{chip("pending", "Waiting")}{chip("published", "Live")}{chip("hidden", "Hidden")}{chip("all", "All")}</div>
      {!c.settings?.qaOn && <p className="mb-3 text-sm text-muted">Questions from visitors are off. You can still publish solved tickets as answers.</p>}
      {list.isPending ? <ListSkeleton /> : list.isError ? <ErrorCard error={list.error} retry={() => list.refetch()} />
        : !list.data.questions.length ? <Card><EmptyState icon={<IconChatQuote className="h-5 w-5" />} title={status === "pending" ? "Nothing waiting" : "No questions here"} body={status === "pending" ? "New questions and answers from visitors wait here until you approve them." : "Questions show here once visitors ask them, or when you publish a solved ticket from the shared inbox."} /></Card>
        : <Card className="divide-y divide-line overflow-hidden">
          {list.data.questions.map((q) => (
            <button key={q.id} type="button" onClick={() => setOpen(q.id)} className="flex w-full min-h-14 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover/60">
              <span className="min-w-0 flex-1"><span className="line-clamp-2 font-medium">{q.title}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted"><Badge tone={q.status === "published" ? "ok" : q.status === "pending" ? "warn" : "neutral"}>{POST_STATUS_LABEL[q.status]}</Badge>{q.source === "ticket" && <span>From a ticket</span>}<span>{q.votes} votes</span><span>{q.answerCount} answers</span>{q.acceptedAnswerId && <span className="text-ok">Answered</span>}{!!q.waitingAnswers && <Badge tone="warn">{q.waitingAnswers} waiting</Badge>}<span>{day(q.createdAt)}</span></span>
              </span>
            </button>
          ))}
        </Card>}
      {open && <QuestionDialog id={open} c={c} onClose={() => setOpen(null)} />}
    </>
  );
}

function QuestionDialog({ id, c, onClose }: { id: string; c: CenterOut; onClose: () => void }) {
  const qc = useQueryClient();
  const key = [...KEY, "question", id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ question: QuestionDetail }>(`/help-center/questions/${id}`) });
  const [text, setText] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const done = (d: unknown) => { if (d && typeof d === "object" && "question" in d) qc.setQueryData(key, d); qc.invalidateQueries({ queryKey: KEY }); };
  const m = useMutation({
    mutationFn: (a: { op: "status"; status: PostStatus } | { op: "answer" } | { op: "answerStatus"; aid: string; status: PostStatus } | { op: "accept"; aid: string | null } | { op: "delete" }) => {
      if (a.op === "status") return api.patch(`/help-center/questions/${id}`, { status: a.status });
      if (a.op === "answer") return api.post(`/help-center/questions/${id}/answers`, { body: text });
      if (a.op === "answerStatus") return api.patch(`/help-center/answers/${a.aid}`, { status: a.status });
      if (a.op === "accept") return api.post(`/help-center/questions/${id}/accept`, { answerId: a.aid });
      return api.del(`/help-center/questions/${id}`);
    },
    onSuccess: (d, a) => { if (a.op === "delete") { toast.success("Question deleted"); qc.invalidateQueries({ queryKey: KEY }); onClose(); return; } if (a.op === "answer") setText(""); done(d); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = q.data?.question;
  return (
    <Dialog open onClose={onClose} title={d?.title ?? "Question"} className="sm:max-w-2xl"
      description={d ? <span className="inline-flex flex-wrap items-center gap-2"><Badge tone={d.status === "published" ? "ok" : d.status === "pending" ? "warn" : "neutral"}>{POST_STATUS_LABEL[d.status]}</Badge>{d.authorName && <span>Asked by {d.authorName}</span>}{d.url && d.status === "published" && c.settings?.on && <a className="text-fg underline underline-offset-2 hover:text-brand" href={d.url} target="_blank" rel="noreferrer">Open public page</a>}</span> : undefined}
      footer={d && c.canEdit ? <>
        <Button variant="danger" onClick={() => setConfirmDel(true)} className="mr-auto"><IconTrash className="h-4 w-4" aria-hidden />Delete</Button>
        {d.status !== "hidden" && <Button variant="ghost" onClick={() => m.mutate({ op: "status", status: "hidden" })}>Hide</Button>}
        {d.status !== "published" && <Button onClick={() => m.mutate({ op: "status", status: "published" })} loading={m.isPending && m.variables?.op === "status"}>Approve</Button>}
      </> : <Button variant="ghost" onClick={onClose}>Close</Button>}>
      {q.isPending ? <div className="space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div> : q.isError ? <p className="text-sm text-bad">{errorMessage(q.error)}</p> : d && <>
        {d.body && <p className="whitespace-pre-wrap break-words text-sm">{d.body}</p>}
        <h3 className="mt-5 text-sm font-semibold">{d.answers.length ? `${d.answers.length} ${d.answers.length === 1 ? "answer" : "answers"}` : "No answers yet"}</h3>
        <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
          {d.answers.map((a) => (
            <li key={a.id} className={cn("p-3", a.accepted && "bg-ok-soft/40")}>
              <p className="whitespace-pre-wrap break-words text-sm">{a.body}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                {a.accepted && <Badge tone="ok"><IconCheck className="h-3 w-3" aria-hidden />Best answer</Badge>}
                <Badge tone={a.status === "published" ? "ok" : a.status === "pending" ? "warn" : "neutral"}>{POST_STATUS_LABEL[a.status]}</Badge>
                <span>{a.authorKind === "team" ? `${a.authorName || "Team"} (team)` : a.authorName || "A visitor"}</span><span>{a.votes} votes</span>
                {c.canEdit && <span className="ml-auto flex flex-wrap gap-1">
                  {a.status !== "published" && <Button size="sm" variant="outline" onClick={() => m.mutate({ op: "answerStatus", aid: a.id, status: "published" })}>Approve</Button>}
                  {a.status !== "hidden" && <Button size="sm" variant="ghost" onClick={() => m.mutate({ op: "answerStatus", aid: a.id, status: "hidden" })}>Hide</Button>}
                  {a.status === "published" && <Button size="sm" variant="ghost" onClick={() => m.mutate({ op: "accept", aid: a.accepted ? null : a.id })}>{a.accepted ? "Unmark best" : "Mark best"}</Button>}
                </span>}
              </div>
            </li>
          ))}
          {!d.answers.length && <li className="p-3 text-sm text-muted">Be the first to answer.</li>}
        </ul>
        <form className="mt-4" onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 2) m.mutate({ op: "answer" }); }}>
          <label className="block text-sm font-medium" htmlFor="hc-answer">Answer as the team</label>
          <Textarea id="hc-answer" className="mt-1" rows={3} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a clear answer" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim().length >= 2) m.mutate({ op: "answer" }); }} />
          <div className="mt-2 flex items-center justify-between gap-2"><span className="text-xs text-subtle">Team answers show at once. Ctrl Enter posts.</span><Button type="submit" size="sm" disabled={text.trim().length < 2} loading={m.isPending && m.variables?.op === "answer"}>Post answer</Button></div>
        </form>
      </>}
      <ConfirmDialog open={confirmDel} onClose={() => setConfirmDel(false)} onConfirm={() => m.mutate({ op: "delete" })} title="Delete this question?" description="The question and its answers are removed for good." busy={m.isPending} />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Categories, feedback, settings
// ---------------------------------------------------------------------------------------------------------------

function CategoriesTab({ c }: { c: CenterOut }) {
  const inv = useInvalidate();
  const cats = useCategories(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [del, setDel] = useState<Category | null>(null);
  const [edit, setEdit] = useState<Category | null>(null);
  const add = useMutation({ mutationFn: () => api.post("/help-center/categories", { name, description }), onSuccess: () => { setName(""); setDescription(""); inv(); toast.success("Category added"); }, onError: (e) => toast.error(errorMessage(e)) });
  const upd = useMutation({ mutationFn: (x: { id: string; body: Record<string, unknown> }) => api.patch(`/help-center/categories/${x.id}`, x.body), onSuccess: () => { setEdit(null); inv(); }, onError: (e) => toast.error(errorMessage(e)) });
  const rm = useMutation({ mutationFn: (id: string) => api.del(`/help-center/categories/${id}`), onSuccess: () => { setDel(null); inv(); toast.success("Category removed"); }, onError: (e) => toast.error(errorMessage(e)) });
  const rows = cats.data?.categories ?? [];
  const move = (i: number, dir: -1 | 1) => {
    const a = rows[i], b = rows[i + dir];
    if (!a || !b) return;
    upd.mutate({ id: a.id, body: { position: b.position } });
    upd.mutate({ id: b.id, body: { position: a.position } });
  };
  return (
    <div className="grid gap-4">
      {c.canEdit && (
        <Card className="p-4">
          <form className="grid gap-3 sm:grid-cols-[1fr_1.5fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(); }}>
            <label className="block text-sm font-medium">Name<Input className="mt-1" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder="Billing" /></label>
            <label className="block text-sm font-medium">Description <span className="font-normal text-subtle">(optional)</span><Input className="mt-1" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="Plans, invoices and payments" /></label>
            <Button type="submit" disabled={!name.trim()} loading={add.isPending}><IconPlus className="h-4 w-4" aria-hidden />Add category</Button>
          </form>
        </Card>
      )}
      {cats.isPending ? <ListSkeleton /> : cats.isError ? <ErrorCard error={cats.error} retry={() => cats.refetch()} />
        : !rows.length ? <Card><EmptyState icon={<IconBook className="h-5 w-5" />} title="No categories yet" body="Categories group articles on your help center's front page. Empty ones stay hidden from visitors." /></Card>
        : <Card className="divide-y divide-line overflow-hidden">
          {rows.map((x, i) => (
            <div key={x.id} className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1"><p className="font-medium">{x.name}</p><p className="truncate text-xs text-muted">{x.description || "No description"} · {x.articles} live {x.articles === 1 ? "article" : "articles"}</p></div>
              {c.canEdit && <div className="flex items-center gap-1">
                <Button size="icon" variant="ghost" aria-label={`Move ${x.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
                <Button size="icon" variant="ghost" aria-label={`Move ${x.name} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit(x)}>Rename</Button>
                <Button size="icon" variant="ghost" aria-label={`Remove ${x.name}`} onClick={() => setDel(x)}><IconTrash className="h-4 w-4" aria-hidden /></Button>
              </div>}
            </div>
          ))}
        </Card>}
      {edit && <RenameDialog cat={edit} busy={upd.isPending} onClose={() => setEdit(null)} onSave={(body) => upd.mutate({ id: edit.id, body })} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && rm.mutate(del.id)} title="Remove this category?" description="Its articles stay live, without a category." confirmLabel="Remove" busy={rm.isPending} />
    </div>
  );
}

function RenameDialog({ cat, busy, onClose, onSave }: { cat: Category; busy: boolean; onClose: () => void; onSave: (b: { name: string; description: string }) => void }) {
  const [name, setName] = useState(cat.name);
  const [description, setDescription] = useState(cat.description);
  return (
    <Dialog open onClose={onClose} title="Rename category" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => onSave({ name, description })} disabled={!name.trim()} loading={busy}>Save</Button></>}>
      <label className="block text-sm font-medium">Name<Input className="mt-1" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label className="mt-3 block text-sm font-medium">Description<Input className="mt-1" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} /></label>
    </Dialog>
  );
}

function FeedbackTab() {
  const f = useQuery({ queryKey: [...KEY, "feedback"], queryFn: () => api.get<{ feedback: Feedback[] }>("/help-center/feedback") });
  if (f.isPending) return <ListSkeleton />;
  if (f.isError) return <ErrorCard error={f.error} retry={() => f.refetch()} />;
  if (!f.data.feedback.length) return <Card><EmptyState icon={<IconChatQuote className="h-5 w-5" />} title="No feedback yet" body="When visitors say whether an article helped, and what was missing, it shows here. Only your team sees comments." /></Card>;
  return (
    <Card className="divide-y divide-line overflow-hidden">
      {f.data.feedback.map((x) => (
        <div key={x.id} className="flex gap-3 px-4 py-3">
          <Badge tone={x.helpful ? "ok" : "bad"}>{x.helpful ? "Helped" : "Did not help"}</Badge>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{x.title}</p>{x.comment ? <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{x.comment}</p> : <p className="text-xs text-subtle">No comment</p>}</div>
          <span className="shrink-0 text-xs text-muted">{day(x.createdAt)}</span>
        </div>
      ))}
    </Card>
  );
}

function SettingsTab({ c }: { c: CenterOut }) {
  const inv = useInvalidate();
  const s = c.settings!;
  const [form, setForm] = useState<HelpCenterSettings>(s);
  const dirty = JSON.stringify(form) !== JSON.stringify(s);
  const problem = form.slug !== s.slug ? centerSlugProblem(form.slug) : null;
  const save = useMutation({ mutationFn: () => api.patch("/help-center", form), onSuccess: () => { toast.success("Saved"); inv(); }, onError: (e) => toast.error(errorMessage(e)) });
  const set = <K extends keyof HelpCenterSettings>(k: K, v: HelpCenterSettings[K]) => setForm((f) => ({ ...f, [k]: v }));
  const ro = !c.canEdit;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const row = (k: "on" | "qaOn" | "moderate" | "suggestInChat", title: string, body: string) => (
    <div className="flex items-start justify-between gap-4 py-3"><div><p className="text-sm font-medium">{title}</p><p className="text-xs text-muted">{body}</p></div><Switch checked={form[k]} onChange={(v) => set(k, v)} label={title} disabled={ro} /></div>
  );
  return (
    <Card className="p-5">
      {ro && <p className="mb-3 text-sm text-muted">Only owners and admins can change these.</p>}
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (!problem) save.mutate(); }}>
        <label className="block text-sm font-medium">Name<Input className="mt-1" value={form.name} maxLength={80} disabled={ro} onChange={(e) => set("name", e.target.value)} /></label>
        <label className="block text-sm font-medium">Welcome line<Textarea className="mt-1" rows={2} maxLength={300} value={form.intro} disabled={ro} onChange={(e) => set("intro", e.target.value)} placeholder="Answers and guides from our team." /></label>
        <label className="block text-sm font-medium">Address
          <div className="mt-1 flex items-center rounded-lg border border-line focus-within:ring-2 focus-within:ring-brand/30"><span className="shrink-0 pl-3 text-sm text-subtle max-sm:hidden">{origin}/help/</span><input aria-describedby="hc-slug-hint" disabled={ro} className="h-9 min-w-0 flex-1 bg-transparent px-2 text-sm outline-none max-sm:h-11" value={form.slug} maxLength={60} onChange={(e) => set("slug", e.target.value.toLowerCase())} /></div>
          <span id="hc-slug-hint" className={cn("mt-1 block text-xs font-normal", problem ? "text-bad" : "text-subtle")}>{problem ?? "Changing it breaks old links to your help center."}</span>
        </label>
        <div className="divide-y divide-line border-y border-line">
          {row("on", "Help center is on", "Visitors can open it. Off hides every page at once.")}
          {row("qaOn", "Questions from visitors", "Visitors can ask, answer and vote.")}
          {row("moderate", "Check posts before they show", "New questions and answers wait for you. Posts that look like spam always wait.")}
          {row("suggestInChat", "Suggest articles in website chat", "Shows up to 3 matching articles before a visitor starts a chat.")}
        </div>
        {!ro && <div className="flex gap-2"><Button type="submit" disabled={!dirty || !!problem} loading={save.isPending}>Save changes</Button>{dirty && <Button type="button" variant="ghost" onClick={() => setForm(s)}>Discard</Button>}</div>}
      </form>
    </Card>
  );
}

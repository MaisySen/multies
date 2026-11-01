/**
 * R123: Docs > Sites (/app/docs/sites) and the page editor (/app/docs/sites/<page id>). A simple website for the
 * workspace: pages built from typed blocks with a live preview (the same renderer as the public page), drafts, versions,
 * publish now or later, SEO fields, moderated comments and page view counts with no personal data.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton, StatTile, Switch } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import {
  IconArrowDown, IconArrowLeft, IconArrowUp, IconCheck, IconChevronDown, IconExternalLink, IconGlobe, IconHistory, IconMonitor, IconPlus, IconSettings, IconSmartphone, IconTrash,
} from "@/web/components/ui/icon";
import {
  BLOCK_HINT, BLOCK_LABEL, MAX_BLOCKS, MAX_DESCRIPTION, STATUS_LABEL, newBlock, pageSlugProblem, renderPageHtml, siteSlugProblem, slugify,
  type Block, type BlockType, type CommentInfo, type PageDetail, type PageSummary, type SiteInfo, type StatsOut, type VersionInfo,
} from "@/shared/sites";

interface SiteOut { site: SiteInfo | null; canStart: boolean; suggestedSlug: string; orgName: string }
interface Linkables { forms: { slug: string; title: string }[]; booking: { slug: string; title: string }[]; people: { id: string; name: string; role: string }[] }

const KEY = ["sites"];
export const useSite = () => useQuery({ queryKey: KEY, queryFn: () => api.get<SiteOut>("/sites") });
const usePages = (on: boolean) => useQuery({ queryKey: [...KEY, "pages"], enabled: on, queryFn: () => api.get<{ pages: PageSummary[] }>("/sites/pages") });
const useLinkables = (on: boolean) => useQuery({ queryKey: [...KEY, "linkables"], enabled: on, queryFn: () => api.get<Linkables>("/sites/linkables"), staleTime: 60_000 });
const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function StatusBadge({ p }: { p: Pick<PageSummary, "status" | "publishAt" | "hasUnpublished"> }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={p.status === "published" ? "ok" : p.status === "scheduled" ? "brand" : "neutral"} dot>{STATUS_LABEL[p.status]}</Badge>
      {p.publishAt && <Badge tone="brand">Goes live {fmt(p.publishAt)}</Badge>}
      {p.status === "published" && p.hasUnpublished && <Badge tone="warn">Changes not published</Badge>}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Sites page
// ---------------------------------------------------------------------------------------------------------------

const TABS = [["pages", "Pages"], ["comments", "Comments"], ["stats", "Stats"], ["settings", "Settings"]] as const;
type Tab = (typeof TABS)[number][0];

export function SitesPage() {
  const q = useSite();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([k]) => k === params.get("tab"))?.[0] ?? "pages") as Tab;
  const [newOpen, setNewOpen] = useState(params.get("new") === "1");
  if (q.isLoading) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-8 w-48" /><Skeleton className="h-24 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>;
  if (q.isError || !q.data) return <Card className="p-6"><p className="font-medium">Couldn't load Sites.</p><p className="mt-1 text-sm text-muted">{errorMessage(q.error)}</p><Button className="mt-3" variant="outline" onClick={() => q.refetch()}>Try again</Button></Card>;
  const { site } = q.data;
  if (!site) return <StartSite d={q.data} />;
  return (
    <div>
      <PageHeader title="Sites" description="A simple website for your team, with pages, comments and visit counts."
        actions={<>
          <a className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted hover:text-fg" href={site.url} target="_blank" rel="noopener noreferrer"><IconExternalLink className="h-4 w-4" aria-hidden />View site</a>
          {site.canEdit && <Button onClick={() => setNewOpen(true)}><IconPlus className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">New page</span></Button>}
        </>} />
      <Card className="mb-5 flex flex-wrap items-center gap-3 p-4">
        <IconGlobe className="h-5 w-5 text-muted" aria-hidden />
        <div className="min-w-0 flex-1"><p className="truncate font-medium">{site.name}</p><p className="truncate text-sm text-muted">{site.url}</p></div>
        <CopyButton value={site.url} label="Copy address" />
      </Card>
      <div role="tablist" aria-label="Sites" className="-mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-line px-1">
        {TABS.filter(([k]) => site.canEdit || k === "pages").map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setParams((p) => { p.set("tab", k); return p; }, { replace: true })}
            className={cn("relative -mb-px inline-flex min-h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors max-sm:min-h-11", tab === k ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>{label}</button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "pages" && <PagesTab site={site} onNew={() => setNewOpen(true)} />}
        {tab === "comments" && site.canEdit && <CommentsTab />}
        {tab === "stats" && site.canEdit && <StatsTab />}
        {tab === "settings" && site.canEdit && <SettingsTab site={site} />}
      </div>
      <NewPageDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

function StartSite({ d }: { d: SiteOut }) {
  const qc = useQueryClient();
  const [name, setName] = useState(d.orgName);
  const [slug, setSlug] = useState(d.suggestedSlug);
  const bad = slug ? siteSlugProblem(slug) : null;
  const m = useMutation({ mutationFn: () => api.post("/sites", { name, slug }), onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); toast.success("Your site is ready to build"); }, onError: (e) => toast.error(errorMessage(e)) });
  return (
    <div>
      <PageHeader title="Sites" description="A simple website for your team, with pages, comments and visit counts." />
      <EmptyState icon={<IconGlobe className="h-6 w-6" aria-hidden />} title="Build a simple website for your team"
        body={d.canStart ? "Add pages from ready blocks, preview them as you go and publish when you are ready. Nothing is public until you publish." : "No site yet. Ask an admin to start one."}
        action={d.canStart ? (
          <form className="mx-auto mt-2 grid w-full max-w-sm gap-3 text-left" onSubmit={(e) => { e.preventDefault(); if (!bad && name.trim()) m.mutate(); }}>
            <label className="text-sm font-medium" htmlFor="site-name">Site name</label>
            <Input id="site-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
            <label className="text-sm font-medium" htmlFor="site-slug">Site address</label>
            <Input id="site-slug" value={slug} maxLength={40} aria-describedby="site-slug-hint" onChange={(e) => setSlug(slugify(e.target.value, "").slice(0, 40))} />
            <p id="site-slug-hint" className={cn("text-xs", bad ? "text-bad" : "text-subtle")}>{bad ?? `Your site will live at /site/${slug || "your-site"}`}</p>
            <Button type="submit" loading={m.isPending} disabled={!!bad || !name.trim()}>Start a site</Button>
          </form>
        ) : undefined} />
    </div>
  );
}

function PagesTab({ site, onNew }: { site: SiteInfo; onNew: () => void }) {
  const q = usePages(true);
  const nav = useNavigate();
  if (q.isLoading) return <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  if (q.isError) return <Card className="p-6"><p className="font-medium">Couldn't load the pages.</p><Button className="mt-3" variant="outline" onClick={() => q.refetch()}>Try again</Button></Card>;
  const pages = q.data?.pages ?? [];
  if (!pages.length) return <EmptyState title={site.canEdit ? "No pages yet" : "Nothing to see yet"} body={site.canEdit ? "Add your first page." : "Published pages and drafts shared with members show here."} action={site.canEdit ? <Button onClick={onNew}><IconPlus className="h-4 w-4" aria-hidden />New page</Button> : undefined} />;
  return (
    <Card className="divide-y divide-line p-0">
      {pages.map((p) => (
        <button key={p.id} type="button" onClick={() => nav(`/app/docs/sites/${p.id}`)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:bg-hover max-sm:min-h-14">
          <span className="min-w-0 flex-1"><span className="block truncate font-medium" title={p.title}>{p.title}{p.isHome && <span className="ml-2 text-xs font-normal text-subtle">Home page</span>}</span><span className="block truncate text-xs text-subtle">/{p.isHome ? "" : p.slug}</span></span>
          <StatusBadge p={p} />
          {p.waitingComments > 0 && <Badge tone="warn">{p.waitingComments} to review</Badge>}
          <span className="w-24 text-right text-xs text-subtle max-sm:w-auto max-sm:text-left">{p.views} views</span>
        </button>
      ))}
    </Card>
  );
}

function NewPageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [title, setTitle] = useState("");
  const m = useMutation({
    mutationFn: () => api.post<{ page: PageDetail }>("/sites/pages", { title }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: KEY }); setTitle(""); onClose(); nav(`/app/docs/sites/${r.page.id}`); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onClose={onClose} title="New page" description="You can change the title and address later."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => title.trim() && m.mutate()} loading={m.isPending} disabled={!title.trim()}>Create page</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) m.mutate(); }}>
        <label className="text-sm font-medium" htmlFor="np-title">Page title</label>
        <Input id="np-title" className="mt-1" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="About us" autoFocus />
        <p className="mt-1 text-xs text-subtle">Address: /{slugify(title || "page")}</p>
      </form>
    </Dialog>
  );
}

function CommentsTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const q = useQuery({ queryKey: [...KEY, "comments", status], queryFn: () => api.get<{ comments: CommentInfo[]; waiting: number }>(`/sites/comments?status=${status}`) });
  const [del, setDel] = useState<CommentInfo | null>(null);
  const m = useMutation({
    mutationFn: (x: { id: string; status: string }) => api.patch(`/sites/comments/${x.id}`, { status: x.status }),
    onSuccess: (_r, x) => { qc.invalidateQueries({ queryKey: KEY }); setDel(null); toast.success(x.status === "approved" ? "Comment approved" : x.status === "delete" ? "Comment deleted" : x.status === "rejected" ? "Comment rejected" : "Comment moved back"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rows = q.data?.comments ?? [];
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Show comments">
        {(["pending", "approved", "rejected"] as const).map((s) => (
          <Button key={s} size="sm" variant={status === s ? "secondary" : "ghost"} aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s === "pending" ? "Waiting" : s === "approved" ? "Approved" : "Rejected"}{s === "pending" && (q.data?.waiting ?? 0) > 0 && <Badge tone="warn">{q.data?.waiting}</Badge>}
          </Button>
        ))}
      </div>
      {q.isLoading ? <Skeleton className="h-20 w-full" /> : q.isError ? <Card className="p-6"><p>Couldn't load comments.</p><Button className="mt-3" variant="outline" onClick={() => q.refetch()}>Try again</Button></Card> : !rows.length ? (
        <EmptyState title={status === "pending" ? "Nothing waiting" : "No comments here"} body={status === "pending" ? "New comments from visitors wait here until you approve them." : "Comments you move here show in this list."} />
      ) : (
        <Card className="divide-y divide-line p-0">
          {rows.map((c) => (
            <div key={c.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm"><span className="font-medium">{c.name}</span><span className="text-xs text-subtle">on {c.pageTitle} · {fmt(c.createdAt)}</span></div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">{c.body}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {c.status !== "approved" && <Button size="sm" variant="outline" onClick={() => m.mutate({ id: c.id, status: "approved" })}><IconCheck className="h-4 w-4" aria-hidden />Approve</Button>}
                {c.status !== "rejected" && <Button size="sm" variant="ghost" onClick={() => m.mutate({ id: c.id, status: "rejected" })}>Reject</Button>}
                <Button size="sm" variant="ghost" onClick={() => setDel(c)}><IconTrash className="h-4 w-4" aria-hidden />Delete</Button>
              </div>
            </div>
          ))}
        </Card>
      )}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && m.mutate({ id: del.id, status: "delete" })} title="Delete this comment?" description="It is removed for good." busy={m.isPending} />
    </div>
  );
}

function StatsTab() {
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: [...KEY, "stats", days], queryFn: () => api.get<StatsOut>(`/sites/stats?days=${days}`) });
  if (q.isLoading) return <Skeleton className="h-40 w-full" />;
  if (q.isError || !q.data) return <Card className="p-6"><p>Couldn't load stats.</p><Button className="mt-3" variant="outline" onClick={() => q.refetch()}>Try again</Button></Card>;
  const s = q.data;
  const max = Math.max(1, ...s.days.map((d) => d.views));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {[7, 30, 90].map((d) => <Button key={d} size="sm" variant={days === d ? "secondary" : "ghost"} aria-pressed={days === d} onClick={() => setDays(d)}>{d} days</Button>)}
        <p className="ml-auto text-xs text-subtle">Counts only. No addresses, cookies or visitor ids are kept.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Views" value={s.total.toLocaleString()} />
        <StatTile label="Top page" value={s.pages[0]?.title ?? "None yet"} />
        <StatTile label="Top source" value={s.sources[0]?.source ?? "None yet"} />
      </div>
      {s.total === 0 ? <EmptyState title="No visits yet" body="Views show here once people open your published pages." /> : <>
        <Card className="p-4">
          <p className="mb-3 text-sm font-medium">Views per day</p>
          <div className="flex h-32 items-end gap-0.5" role="img" aria-label={`Views per day for the last ${days} days, ${s.total} in all`}>
            {s.days.map((d) => <div key={d.day} title={`${d.day}: ${d.views}`} className="flex-1 rounded-t bg-brand/70" style={{ height: `${Math.max(2, (d.views / max) * 100)}%` }} />)}
          </div>
        </Card>
        <div className="grid gap-3 md:grid-cols-3">
          {([["Pages", s.pages.map((p) => [p.title, p.views])], ["Sources", s.sources.map((p) => [p.source, p.views])], ["Devices", s.devices.map((p) => [p.device, p.views])]] as [string, [string, number][]][]).map(([t, rows]) => (
            <Card key={t} className="p-4"><p className="mb-2 text-sm font-medium">{t}</p><ul className="space-y-1 text-sm">{rows.map(([k, v]) => <li key={k} className="flex justify-between gap-2"><span className="truncate">{k}</span><span className="text-muted">{v}</span></li>)}</ul></Card>
          ))}
        </div>
      </>}
    </div>
  );
}

function SettingsTab({ site }: { site: SiteInfo }) {
  const qc = useQueryClient();
  const l = useLinkables(true);
  const [name, setName] = useState(site.name);
  const [description, setDescription] = useState(site.description);
  const [editors, setEditors] = useState<string[]>(site.editors);
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch("/sites", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); toast.success("Site settings saved"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const people = (l.data?.people ?? []).filter((p) => p.role === "member");
  return (
    <div className="grid max-w-xl gap-5">
      <Card className="grid gap-3 p-4">
        <label className="text-sm font-medium" htmlFor="ss-name">Site name</label>
        <Input id="ss-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <label className="text-sm font-medium" htmlFor="ss-desc">Description</label>
        <Textarea id="ss-desc" rows={2} value={description} maxLength={MAX_DESCRIPTION} onChange={(e) => setDescription(e.target.value)} aria-describedby="ss-desc-hint" />
        <p id="ss-desc-hint" className="text-xs text-subtle">Used for search and shared links when a page has none. {description.length}/{MAX_DESCRIPTION}</p>
        <div><Button onClick={() => m.mutate({ name, description })} loading={m.isPending}>Save</Button></div>
      </Card>
      <Card className="p-4"><Switch checked={site.commentsOn} onChange={(v) => m.mutate({ commentsOn: v })} label="Visitors can comment (every comment waits for approval)" /></Card>
      <Card className="grid gap-2 p-4">
        <p className="text-sm font-medium">Site editors</p>
        <p className="text-xs text-subtle">Owners and admins can always build and publish. Members you pick here can too.</p>
        {l.isLoading ? <Skeleton className="h-10 w-full" /> : people.length ? people.map((p) => (
          <label key={p.id} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={editors.includes(p.id)} onChange={(e) => setEditors((x) => (e.target.checked ? [...x, p.id] : x.filter((i) => i !== p.id)))} />{p.name}</label>
        )) : <p className="text-sm text-muted">No members to add yet.</p>}
        {people.length > 0 && <div><Button variant="outline" onClick={() => m.mutate({ editors })} loading={m.isPending}>Save editors</Button></div>}
      </Card>
      <Card className="p-4 text-sm text-muted">Your site lives at <span className="text-fg">{site.url}</span>. Custom domains for sites come in a later update.</Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------------------------

const ADDABLE: BlockType[] = ["hero", "heading", "text", "image", "button", "quote", "features", "divider", "form", "booking"];
interface Draft { title: string; slug: string; blocks: Block[]; seoTitle: string; description: string; image: string; membersCanView: boolean; commentsOn: boolean }
const draftOf = (p: PageDetail): Draft => ({ title: p.title, slug: p.slug, blocks: p.blocks, seoTitle: p.seoTitle, description: p.description, image: p.image, membersCanView: p.membersCanView, commentsOn: p.commentsOn });

export function SiteEditorPage() {
  const { pageId = "" } = useParams();
  const q = useQuery({ queryKey: [...KEY, "page", pageId], queryFn: () => api.get<{ page: PageDetail; site: SiteInfo; look?: { brandColor: string | null } }>(`/sites/pages/${pageId}`), retry: false });
  if (q.isLoading) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-10 w-64" /><div className="grid gap-4 lg:grid-cols-[360px_1fr]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div></div>;
  if (q.isError || !q.data) {
    const msg = errorMessage(q.error);
    return <Card className="p-6"><p className="font-medium">{/draft|access/i.test(msg) ? "You can't open this page" : "Couldn't load this page"}</p><p className="mt-1 text-sm text-muted">{msg}</p><div className="mt-3 flex gap-2"><Link className="text-sm underline" to="/app/docs/sites">Back to Sites</Link>{!/draft|access/i.test(msg) && <Button variant="outline" size="sm" onClick={() => q.refetch()}>Try again</Button>}</div></Card>;
  }
  return <Editor key={q.data.page.id + q.data.page.updatedAt} page={q.data.page} site={q.data.site} brandColor={q.data.look?.brandColor ?? null} />;
}

function Editor({ page, site, brandColor }: { page: PageDetail; site: SiteInfo; brandColor: string | null }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [d, setD] = useState<Draft>(() => draftOf(page));
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [width, setWidth] = useState<"desktop" | "phone">("desktop");
  const [settings, setSettings] = useState(false);
  const [versions, setVersions] = useState(false);
  const [schedule, setSchedule] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmPub, setConfirmPub] = useState(false);
  const canEdit = site.canEdit;
  const l = useLinkables(canEdit);
  const set = (patch: Partial<Draft>) => { setD((x) => ({ ...x, ...patch })); setDirty(true); };
  const setBlock = (i: number, patch: Partial<Block>) => set({ blocks: d.blocks.map((b, j) => (j === i ? ({ ...b, ...patch } as Block) : b)) });
  const move = (i: number, dir: -1 | 1) => { const b = [...d.blocks]; const j = i + dir; if (j < 0 || j >= b.length) return; [b[i], b[j]] = [b[j], b[i]]; set({ blocks: b }); };
  const add = (t: BlockType) => set({ blocks: [...d.blocks, newBlock(t, `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`)] });
  const refresh = (p: PageDetail) => { qc.setQueryData([...KEY, "page", page.id], { page: p, site, look: { brandColor } }); qc.invalidateQueries({ queryKey: [...KEY, "pages"] }); };

  const save = useMutation({
    mutationFn: () => api.patch<{ page: PageDetail }>(`/sites/pages/${page.id}`, d),
    onSuccess: (r) => { setDirty(false); refresh(r.page); toast.success("Draft saved"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const publish = useMutation({
    mutationFn: async (at: number | null) => { if (dirty) await api.patch(`/sites/pages/${page.id}`, d); return api.post<{ page: PageDetail }>(`/sites/pages/${page.id}/publish`, { at }); },
    onSuccess: (r, at) => { setDirty(false); setSchedule(false); setConfirmPub(false); refresh(r.page); toast.success(at ? `Scheduled for ${fmt(at)}` : "Page published"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const unpublish = useMutation({ mutationFn: () => api.post<{ page: PageDetail }>(`/sites/pages/${page.id}/unpublish`, {}), onSuccess: (r) => { refresh(r.page); toast.success("Page taken offline"); }, onError: (e) => toast.error(errorMessage(e)) });
  const del = useMutation({ mutationFn: () => api.del(`/sites/pages/${page.id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); toast.success("Page deleted"); nav("/app/docs/sites"); }, onError: (e) => toast.error(errorMessage(e)) });

  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!save.isPending) save.mutate(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); setConfirmPub(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, save]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const preview = useMemo(() => {
    const app = window.location.origin;
    return renderPageHtml(
      { name: site.name, brandColor, logoUrl: null, homeHref: "#", nav: [] },
      { title: d.title, blocks: d.blocks, seoTitle: d.seoTitle, description: d.description, image: d.image || null },
      { formHref: (s) => `${app}/f/${s}`, bookingHref: (s) => `${app}/book/${s}` }, { preview: true },
    );
  }, [d, site.name, brandColor]);

  const status = { status: page.status, publishAt: page.publishAt, hasUnpublished: page.hasUnpublished || dirty };
  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link to="/app/docs/sites" className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm text-muted hover:text-fg sm:min-h-9"><IconArrowLeft className="h-4 w-4" aria-hidden />Sites</Link>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold" title={d.title}>{d.title || "Untitled page"}</h1>
        <StatusBadge p={status} />
        {page.url && <a href={page.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1 px-2 text-sm text-muted hover:text-fg"><IconExternalLink className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">Open</span></a>}
        {canEdit && <>
          <Button variant="outline" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>Save draft</Button>
          <Button onClick={() => setConfirmPub(true)} loading={publish.isPending}>Publish</Button>
          <Menu label="More page actions" trigger={<Button variant="ghost" size="icon" aria-label="More page actions"><IconChevronDown className="h-4 w-4" aria-hidden /></Button>}>
            <MenuItem icon={<IconSettings className="h-4 w-4" />} onSelect={() => setSettings(true)}>Page settings</MenuItem>
            <MenuItem icon={<IconHistory className="h-4 w-4" />} onSelect={() => setVersions(true)}>Versions</MenuItem>
            <MenuItem onSelect={() => setSchedule(true)}>Schedule publish</MenuItem>
            {(page.status !== "draft" || page.publishAt) && <MenuItem onSelect={() => unpublish.mutate()}>Take offline</MenuItem>}
            {!page.isHome && <MenuItem danger icon={<IconTrash className="h-4 w-4" />} onSelect={() => setConfirmDel(true)}>Delete page</MenuItem>}
          </Menu>
        </>}
      </div>
      <div className="mb-3 flex gap-1 lg:hidden" role="group" aria-label="Edit or preview">
        <Button size="sm" variant={view === "edit" ? "secondary" : "ghost"} aria-pressed={view === "edit"} onClick={() => setView("edit")}>Edit</Button>
        <Button size="sm" variant={view === "preview" ? "secondary" : "ghost"} aria-pressed={view === "preview"} onClick={() => setView("preview")}>Preview</Button>
      </div>
      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(320px,380px)_1fr]">
        <section aria-label="Blocks" className={cn("space-y-3", view === "preview" && "max-lg:hidden")}>
          {!canEdit && <Card className="p-3 text-sm text-muted">You can view this draft. Only admins and site editors can change it.</Card>}
          {d.blocks.length === 0 && <EmptyState title="No blocks yet" body="Add a block to start the page." />}
          {d.blocks.map((b, i) => (
            <Card key={b.id} className="p-3">
              <div className="mb-2 flex items-center gap-1">
                <p className="flex-1 text-sm font-medium">{BLOCK_LABEL[b.type]}</p>
                {canEdit && <>
                  <Button size="icon" variant="ghost" aria-label={`Move ${BLOCK_LABEL[b.type]} block up`} disabled={i === 0} onClick={() => move(i, -1)}><IconArrowUp className="h-4 w-4" aria-hidden /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Move ${BLOCK_LABEL[b.type]} block down`} disabled={i === d.blocks.length - 1} onClick={() => move(i, 1)}><IconArrowDown className="h-4 w-4" aria-hidden /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Remove ${BLOCK_LABEL[b.type]} block`} onClick={() => set({ blocks: d.blocks.filter((_, j) => j !== i) })}><IconTrash className="h-4 w-4" aria-hidden /></Button>
                </>}
              </div>
              <fieldset disabled={!canEdit} className="grid gap-2"><BlockFields b={b} i={i} on={(p) => setBlock(i, p)} links={l.data} /></fieldset>
            </Card>
          ))}
          {canEdit && d.blocks.length < MAX_BLOCKS && (
            <Menu label="Add block" align="start" trigger={<Button variant="outline" className="w-full"><IconPlus className="h-4 w-4" aria-hidden />Add block</Button>}>
              {ADDABLE.map((t) => <MenuItem key={t} onSelect={() => add(t)} hint={BLOCK_HINT[t]}>{BLOCK_LABEL[t]}</MenuItem>)}
            </Menu>
          )}
          {canEdit && <p className="text-xs text-subtle">Ctrl S saves the draft. Ctrl Enter publishes.</p>}
        </section>
        <section aria-label="Live preview" className={cn("min-h-[480px]", view === "edit" && "max-lg:hidden")}>
          <div className="mb-2 flex items-center gap-1">
            <p className="flex-1 text-sm font-medium">Live preview</p>
            <Button size="icon" variant={width === "desktop" ? "secondary" : "ghost"} aria-label="Preview at desktop width" aria-pressed={width === "desktop"} onClick={() => setWidth("desktop")}><IconMonitor className="h-4 w-4" aria-hidden /></Button>
            <Button size="icon" variant={width === "phone" ? "secondary" : "ghost"} aria-label="Preview at phone width" aria-pressed={width === "phone"} onClick={() => setWidth("phone")}><IconSmartphone className="h-4 w-4" aria-hidden /></Button>
          </div>
          <div className="overflow-hidden rounded-lg border border-line bg-fill">
            <iframe title="Page preview" sandbox="" srcDoc={preview} className={cn("mx-auto block h-[70vh] min-h-[480px] w-full bg-white transition-[max-width] duration-200", width === "phone" && "max-w-[390px]")} />
          </div>
        </section>
      </div>
      <PageSettings open={settings} onClose={() => setSettings(false)} d={d} set={set} isHome={page.isHome} />
      <Versions open={versions} onClose={() => setVersions(false)} pageId={page.id} onRestored={(p) => { setD(draftOf(p)); setDirty(false); refresh(p); setVersions(false); }} />
      <ScheduleDialog open={schedule} onClose={() => setSchedule(false)} onPick={(at) => publish.mutate(at)} busy={publish.isPending} />
      <ConfirmDialog open={confirmPub} onClose={() => setConfirmPub(false)} onConfirm={() => publish.mutate(null)} title="Publish this page now?" description="Visitors see this version at once. Earlier versions stay in Versions." confirmLabel="Publish" tone="primary" busy={publish.isPending} />
      <ConfirmDialog open={confirmDel} onClose={() => setConfirmDel(false)} onConfirm={() => del.mutate()} title="Delete this page?" description="The page, its versions, comments and counts are removed for good." busy={del.isPending} />
    </div>
  );
}

function Lbl({ id, children }: { id: string; children: string }) { return <label htmlFor={id} className="text-xs font-medium text-muted">{children}</label>; }

function BlockFields({ b, i, on, links }: { b: Block; i: number; on: (p: Partial<Block>) => void; links?: Linkables }) {
  const id = (k: string) => `blk-${i}-${k}`;
  switch (b.type) {
    case "hero": return <>
      <Lbl id={id("t")}>Title</Lbl><Input id={id("t")} value={b.title} maxLength={200} onChange={(e) => on({ title: e.target.value })} />
      <Lbl id={id("x")}>Text</Lbl><Textarea id={id("x")} rows={2} value={b.text} maxLength={600} onChange={(e) => on({ text: e.target.value })} />
      <Lbl id={id("bl")}>Button label</Lbl><Input id={id("bl")} value={b.buttonLabel} maxLength={60} onChange={(e) => on({ buttonLabel: e.target.value })} />
      <Lbl id={id("bu")}>Button address</Lbl><Input id={id("bu")} value={b.buttonUrl} maxLength={2048} placeholder="https://" onChange={(e) => on({ buttonUrl: e.target.value })} />
    </>;
    case "heading": return <>
      <Lbl id={id("t")}>Heading</Lbl><Input id={id("t")} value={b.text} maxLength={200} onChange={(e) => on({ text: e.target.value })} />
      <label className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={b.level === 3} onChange={(e) => on({ level: e.target.checked ? 3 : 2 })} />Smaller heading</label>
    </>;
    case "text": return <><Lbl id={id("x")}>Text</Lbl><Textarea id={id("x")} rows={5} value={b.text} maxLength={5000} onChange={(e) => on({ text: e.target.value })} /><p className="text-xs text-subtle">**bold**, *italic*, [link](https://example.com). A blank line starts a new paragraph.</p></>;
    case "image": return <>
      <Lbl id={id("u")}>Image address</Lbl><Input id={id("u")} value={b.url} maxLength={2048} placeholder="https://" onChange={(e) => on({ url: e.target.value })} />
      <Lbl id={id("a")}>Describe the image for screen readers</Lbl><Input id={id("a")} value={b.alt} maxLength={300} onChange={(e) => on({ alt: e.target.value })} />
      <Lbl id={id("c")}>Caption</Lbl><Input id={id("c")} value={b.caption} maxLength={300} onChange={(e) => on({ caption: e.target.value })} />
    </>;
    case "button": return <>
      <Lbl id={id("l")}>Label</Lbl><Input id={id("l")} value={b.label} maxLength={60} onChange={(e) => on({ label: e.target.value })} />
      <Lbl id={id("u")}>Address</Lbl><Input id={id("u")} value={b.url} maxLength={2048} placeholder="https://" onChange={(e) => on({ url: e.target.value })} />
      <label className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={b.style === "secondary"} onChange={(e) => on({ style: e.target.checked ? "secondary" : "primary" })} />Outline style</label>
    </>;
    case "quote": return <>
      <Lbl id={id("x")}>Quote</Lbl><Textarea id={id("x")} rows={2} value={b.text} maxLength={1000} onChange={(e) => on({ text: e.target.value })} />
      <Lbl id={id("b")}>Who said it</Lbl><Input id={id("b")} value={b.by} maxLength={120} onChange={(e) => on({ by: e.target.value })} />
    </>;
    case "features": return <>
      {b.items.map((it, k) => (
        <div key={k} className="grid gap-1 rounded-lg border border-line p-2">
          <Lbl id={id(`ft${k}`)}>{`Point ${k + 1} title`}</Lbl><Input id={id(`ft${k}`)} value={it.title} maxLength={120} onChange={(e) => on({ items: b.items.map((x, j) => (j === k ? { ...x, title: e.target.value } : x)) })} />
          <Lbl id={id(`fx${k}`)}>{`Point ${k + 1} text`}</Lbl><Textarea id={id(`fx${k}`)} rows={2} value={it.text} maxLength={400} onChange={(e) => on({ items: b.items.map((x, j) => (j === k ? { ...x, text: e.target.value } : x)) })} />
          <div><Button size="sm" variant="ghost" onClick={() => on({ items: b.items.filter((_, j) => j !== k) })}>Remove point</Button></div>
        </div>
      ))}
      {b.items.length < 6 && <div><Button size="sm" variant="outline" onClick={() => on({ items: [...b.items, { title: "", text: "" }] })}><IconPlus className="h-4 w-4" aria-hidden />Add point</Button></div>}
    </>;
    case "divider": return <p className="text-xs text-subtle">A thin line between sections.</p>;
    case "form":
    case "booking": {
      const list = b.type === "form" ? links?.forms ?? [] : links?.booking ?? [];
      return <>
        <Lbl id={id("s")}>{b.type === "form" ? "Form" : "Booking page"}</Lbl>
        <Select id={id("s")} value={b.slug} onChange={(e) => on({ slug: e.target.value })}>
          <option value="">{list.length ? "Pick one" : b.type === "form" ? "No forms yet" : "No booking pages yet"}</option>
          {list.map((x) => <option key={x.slug} value={x.slug}>{x.title}</option>)}
        </Select>
        <Lbl id={id("t")}>Title</Lbl><Input id={id("t")} value={b.title} maxLength={200} onChange={(e) => on({ title: e.target.value })} />
        <Lbl id={id("x")}>Text</Lbl><Textarea id={id("x")} rows={2} value={b.text} maxLength={400} onChange={(e) => on({ text: e.target.value })} />
      </>;
    }
  }
}

function PageSettings({ open, onClose, d, set, isHome }: { open: boolean; onClose: () => void; d: Draft; set: (p: Partial<Draft>) => void; isHome: boolean }) {
  const bad = d.slug ? pageSlugProblem(d.slug) : "Add a page address.";
  return (
    <Dialog open={open} onClose={onClose} title="Page settings" description="Changes are part of the draft until you save or publish." footer={<Button onClick={onClose}>Done</Button>}>
      <div className="grid gap-2">
        <label className="text-sm font-medium" htmlFor="ps-title">Page title</label>
        <Input id="ps-title" value={d.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
        <label className="text-sm font-medium" htmlFor="ps-slug">Page address</label>
        <Input id="ps-slug" value={d.slug} maxLength={60} disabled={isHome} onChange={(e) => set({ slug: slugify(e.target.value, "").slice(0, 60) })} aria-describedby="ps-slug-hint" />
        <p id="ps-slug-hint" className={cn("text-xs", bad && !isHome ? "text-bad" : "text-subtle")}>{isHome ? "This is the home page, so it opens at the site address." : bad ?? `/${d.slug}`}</p>
        <p className="mt-2 text-sm font-medium">Search and sharing</p>
        <label className="text-sm" htmlFor="ps-seo">Title in search results</label>
        <Input id="ps-seo" value={d.seoTitle} maxLength={70} placeholder={d.title} onChange={(e) => set({ seoTitle: e.target.value })} />
        <label className="text-sm" htmlFor="ps-desc">Description</label>
        <Textarea id="ps-desc" rows={2} value={d.description} maxLength={MAX_DESCRIPTION} onChange={(e) => set({ description: e.target.value })} aria-describedby="ps-desc-hint" />
        <p id="ps-desc-hint" className="text-xs text-subtle">{d.description.length}/{MAX_DESCRIPTION}</p>
        <label className="text-sm" htmlFor="ps-img">Share image address</label>
        <Input id="ps-img" value={d.image} maxLength={2048} placeholder="https://" onChange={(e) => set({ image: e.target.value })} />
        <p className="text-xs text-subtle">Without one, shared links use your logo.</p>
        <div className="mt-2 grid gap-2">
          <Switch checked={d.commentsOn} onChange={(v) => set({ commentsOn: v })} label="Show comments on this page" />
          <Switch checked={d.membersCanView} onChange={(v) => set({ membersCanView: v })} label="Members can view the draft" />
        </div>
      </div>
    </Dialog>
  );
}

function Versions({ open, onClose, pageId, onRestored }: { open: boolean; onClose: () => void; pageId: string; onRestored: (p: PageDetail) => void }) {
  const q = useQuery({ queryKey: [...KEY, "versions", pageId], enabled: open, queryFn: () => api.get<{ versions: VersionInfo[] }>(`/sites/pages/${pageId}/versions`) });
  const [pick, setPick] = useState<VersionInfo | null>(null);
  const m = useMutation({ mutationFn: (vid: string) => api.post<{ page: PageDetail }>(`/sites/pages/${pageId}/versions/${vid}/restore`, {}), onSuccess: (r) => { setPick(null); toast.success("Version restored into the draft"); onRestored(r.page); }, onError: (e) => toast.error(errorMessage(e)) });
  const rows = q.data?.versions ?? [];
  return (
    <Dialog open={open} onClose={onClose} title="Versions" description="Restoring copies a version into the draft. Visitors see it only after you publish.">
      {q.isLoading ? <Skeleton className="h-24 w-full" /> : !rows.length ? <p className="text-sm text-muted">No versions yet. Each save and publish adds one.</p> : (
        <ul className="divide-y divide-line">
          {rows.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1"><span className="block truncate">{v.title || "Untitled"}</span><span className="text-xs text-subtle">{v.kind === "published" ? "Published" : "Saved"} by {v.byName} · {fmt(v.createdAt)} · {v.blocks} blocks</span></span>
              <Button size="sm" variant="outline" onClick={() => setPick(v)}>Restore</Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!pick} onClose={() => setPick(null)} onConfirm={() => pick && m.mutate(pick.id)} title="Restore this version?" description="Your current draft is replaced. It is still in the list if you need it back." confirmLabel="Restore" tone="primary" busy={m.isPending} />
    </Dialog>
  );
}

function ScheduleDialog({ open, onClose, onPick, busy }: { open: boolean; onClose: () => void; onPick: (at: number) => void; busy: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const def = () => { const t = new Date(Date.now() + 86_400_000); t.setMinutes(0, 0, 0); const p = (n: number) => String(n).padStart(2, "0"); return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:00`; };
  const [v, setV] = useState(def);
  const at = v ? new Date(v).getTime() : NaN;
  const bad = !Number.isFinite(at) || at <= Date.now() + 30_000;
  return (
    <Dialog open={open} onClose={onClose} title="Schedule publish" description="The current draft goes live at this time. Until then visitors see the page as it is now."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => !bad && onPick(at)} disabled={bad} loading={busy}>Schedule</Button></>}>
      <label className="text-sm font-medium" htmlFor="sch-at">Publish at</label>
      <Input ref={ref} id="sch-at" type="datetime-local" className="mt-1" value={v} onChange={(e) => setV(e.target.value)} aria-describedby="sch-hint" />
      <p id="sch-hint" className={cn("mt-1 text-xs", bad ? "text-bad" : "text-subtle")}>{bad ? "Pick a time in the future." : `In your time zone: ${new Date(at).toLocaleString()}`}</p>
    </Dialog>
  );
}

/**
 * R124: the blog inside Sites (Docs > Sites > Blog) and its post editor (/app/docs/sites/blog/<post id>). Posts are
 * written in the Docs editor; the settings column holds the address, excerpt, cover, tags, author, publish or schedule
 * and the opt in "Email this post to subscribers" (sent through Campaigns). Admins also see subscribers and the
 * newsletter settings. Flag BLOG_R124.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { useConfig, useMailboxes } from "@/web/lib/queries";
import { uploadDocImage } from "@/web/lib/docs-blocks";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, Skeleton, StatTile, Switch } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { LoadError } from "@/web/components/load-error-t1g";
import { IconArrowLeft, IconBook, IconDownload, IconExternalLink, IconEye, IconImage, IconMail, IconPlus, IconSearch, IconSettings, IconTrash, IconUpload, IconUser } from "@/web/components/ui/icon";
import { EmbeddedDoc } from "./work/docs";
import { MAX_EXCERPT, MAX_TAGS_PER_POST, POST_STATUS_LABEL, postSlugProblem, type AuthorInfo, type BlogInfo, type PostDetail, type PostStatus, type PostSummary } from "@/shared/blog-r124";

interface BlogOut { blog: BlogInfo | null; canStart: boolean; canEdit: boolean; isAdmin: boolean; me: string; people: { id: string; name: string }[] }
interface PublishOut { post: PostDetail; email: { status: string; message: string } }
interface SubsOut { counts: { subscribed: number; pending: number; unsubscribed: number }; more: boolean; subscribers: { id: string; email: string; status: string; source: string; at: string | null }[] }

const KEY = ["sites", "blog"];
export const useBlogOn = () => !!(useConfig().data as { blog?: boolean } | undefined)?.blog;
const useBlog = (on = true) => useQuery({ queryKey: KEY, enabled: on, queryFn: () => api.get<BlogOut>("/sites/blog") });
const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const label = (cls = "") => cn("text-sm font-medium", cls);

function PostBadge({ p }: { p: Pick<PostSummary, "status" | "publishAt" | "hasUnpublished"> }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={p.status === "published" ? "ok" : p.status === "scheduled" ? "brand" : "neutral"} dot>{POST_STATUS_LABEL[p.status]}</Badge>
      {p.status === "scheduled" && p.publishAt && <Badge tone="brand">Goes live {fmt(p.publishAt)}</Badge>}
      {p.hasUnpublished && <Badge tone="warn">Changes not published</Badge>}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Blog tab
// ---------------------------------------------------------------------------------------------------------------

const VIEWS = [["posts", "Posts"], ["subscribers", "Subscribers"], ["authors", "Authors"], ["settings", "Settings"]] as const;
type View = (typeof VIEWS)[number][0];

export function BlogTab() {
  const q = useBlog();
  const [params, setParams] = useSearchParams();
  const [newOpen, setNewOpen] = useState(params.get("new") === "1" && params.get("tab") === "blog");
  if (q.isLoading) return <div className="space-y-2" aria-busy="true"><Skeleton className="h-10 w-full" />{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>;
  if (q.isError || !q.data) return <LoadError onRetry={() => q.refetch()} />;
  const d = q.data;
  if (!d.blog) return <StartBlog d={d} />;
  const blog = d.blog;
  const views = VIEWS.filter(([k]) => k === "posts" || (k === "subscribers" ? d.isAdmin && !!blog.newsletter?.listId : d.canEdit));
  const view = (views.find(([k]) => k === params.get("view"))?.[0] ?? "posts") as View;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {views.length > 1 && (
          <div role="group" aria-label="Blog" className="inline-flex max-w-full overflow-x-auto rounded-lg border border-line p-0.5">
            {views.map(([k, l]) => (
              <button key={k} type="button" aria-pressed={view === k} onClick={() => setParams((p) => { p.set("tab", "blog"); if (k === "posts") p.delete("view"); else p.set("view", k); return p; }, { replace: true })}
                className={cn("min-h-9 shrink-0 rounded-md px-3 text-sm transition-colors duration-150 max-sm:min-h-11", view === k ? "bg-brand-soft font-medium text-brand-hover" : "text-muted hover:text-fg")}>{l}</button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <a className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted hover:text-fg max-sm:min-h-11" href={blog.url} target="_blank" rel="noopener noreferrer"><IconExternalLink className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">View blog</span></a>
          {d.canEdit && view === "posts" && <Button onClick={() => setNewOpen(true)}><IconPlus className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">New post</span></Button>}
        </div>
      </div>
      {view === "posts" && <PostsView d={d} onNew={() => setNewOpen(true)} />}
      {view === "subscribers" && <SubscribersView blog={blog} />}
      {view === "authors" && <AuthorsView blog={blog} />}
      {view === "settings" && <BlogSettings d={d} blog={blog} />}
      <NewPostDialog open={newOpen} onClose={() => { setNewOpen(false); if (params.get("new")) setParams((p) => { p.delete("new"); return p; }, { replace: true }); }} />
    </div>
  );
}

function StartBlog({ d }: { d: BlogOut }) {
  const qc = useQueryClient();
  const m = useMutation({ mutationFn: () => api.post<BlogOut>("/sites/blog", {}), onSuccess: (r) => { qc.setQueryData(KEY, r); toast.success("Your blog is ready"); }, onError: (e) => toast.error(errorMessage(e)) });
  return (
    <EmptyState icon={<IconBook />} title="Start a blog on your site"
      body={<span className="block max-w-md">Write posts in the Docs editor, tag them and publish now or later. Visitors get a post list, tag and author pages and an RSS feed, and can subscribe to get new posts by email.</span>}
      action={d.canStart ? <Button onClick={() => m.mutate()} loading={m.isPending}>Start the blog</Button> : <p className="text-sm text-muted">Ask an admin to start the blog.</p>} />
  );
}

function PostsView({ d, onNew }: { d: BlogOut; onNew: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const [author, setAuthor] = useState("");
  const [deb, setDeb] = useState("");
  useEffect(() => { const t = setTimeout(() => setDeb(q), 200); return () => clearTimeout(t); }, [q]);
  const qs = new URLSearchParams(Object.entries({ q: deb, status, tag, author }).filter(([, v]) => v)).toString();
  const posts = useQuery({ queryKey: [...KEY, "posts", qs], queryFn: () => api.get<{ posts: PostSummary[]; tags: string[]; total: number }>(`/sites/blog/posts${qs ? `?${qs}` : ""}`), placeholderData: (x) => x });
  if (posts.isLoading) return <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>;
  if (posts.isError || !posts.data) return <LoadError onRetry={() => posts.refetch()} />;
  const { total, tags } = posts.data;
  if (!total) {
    return d.canEdit
      ? <EmptyState icon={<IconBook />} title="Write your first post" body={<span className="block max-w-md">1. Click New post and write in the editor. 2. Add an excerpt, a cover image and tags. 3. Publish now or pick a time. Tick Email this post to send it to subscribers.</span>} action={<Button onClick={onNew}><IconPlus className="h-4 w-4" aria-hidden />New post</Button>} />
      : <EmptyState icon={<IconBook />} title="No posts yet" body="Published posts show here." />;
  }
  const filtered = !!(deb || status || tag || author);
  return (
    <div>
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1 max-sm:-mx-1 max-sm:px-1">
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">Search posts</span>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search posts" className="pl-9" type="search" />
        </label>
        {d.canEdit && <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-36 shrink-0"><option value="">All statuses</option>{(["draft", "scheduled", "published"] as PostStatus[]).map((s) => <option key={s} value={s}>{POST_STATUS_LABEL[s]}</option>)}</Select>}
        {tags.length > 0 && <Select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)} className="w-36 shrink-0"><option value="">All tags</option>{tags.map((t) => <option key={t} value={t}>{t}</option>)}</Select>}
        {d.people.length > 1 && <Select aria-label="Author" value={author} onChange={(e) => setAuthor(e.target.value)} className="w-40 shrink-0"><option value="">All authors</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}
      </div>
      {posts.data.posts.length === 0 ? (
        <EmptyState icon={<IconSearch />} title="No posts match" body={filtered ? "Try other words or clear the filters." : "Nothing here yet."} action={filtered ? <Button variant="outline" onClick={() => { setQ(""); setStatus(""); setTag(""); setAuthor(""); }}>Clear filters</Button> : undefined} />
      ) : (
        <Card className="divide-y divide-line p-0" data-testid="blog-posts">
          {posts.data.posts.map((p) => (
            <button key={p.id} type="button" onClick={() => nav(`/app/docs/sites/blog/${p.id}`)} disabled={!d.canEdit && p.status !== "published"}
              className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand">
              <PostThumb src={p.cover} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium" title={p.title}>{p.title}</span>
                {p.excerpt && <span className="mt-0.5 block truncate text-sm text-muted">{p.excerpt}</span>}
                <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
                  <PostBadge p={p} />
                  {p.authorName && <span>{p.authorName}</span>}
                  <span>{p.publishedAt ? fmtDay(p.publishedAt) : `Edited ${fmtDay(p.updatedAt)}`}</span>
                  {p.emailed && <span className="inline-flex items-center gap-1"><IconMail className="h-3.5 w-3.5" aria-hidden />Emailed</span>}
                  {p.tags.slice(0, 3).map((t) => <span key={t} className="rounded-full border border-line px-2">{t}</span>)}
                </span>
              </span>
            </button>
          ))}
        </Card>
      )}
    </div>
  );
}

function PostThumb({ src }: { src: string }) {
  const url = /^\/api\/doc-images\/|^https:\/\//.test(src) ? src : "";
  return url
    ? <img src={url} alt="" className="h-14 w-20 shrink-0 rounded-md bg-elevated object-cover max-sm:h-12 max-sm:w-16" loading="lazy" />
    : <span className="flex h-14 w-20 shrink-0 items-center justify-center rounded-md bg-elevated text-subtle max-sm:h-12 max-sm:w-16" aria-hidden><IconImage className="h-5 w-5" /></span>;
}

function NewPostDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [title, setTitle] = useState("");
  const m = useMutation({
    mutationFn: () => api.post<PostDetail>("/sites/blog/posts", { title }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: KEY }); setTitle(""); onClose(); nav(`/app/docs/sites/blog/${r.id}`); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onClose={onClose} title="New post" description="You write the post in the editor next. Nothing is public until you publish."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending}>Create post</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <label className={label()} htmlFor="bp-title">Title</label>
        <Input id="bp-title" className="mt-1" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="What we shipped this week" autoFocus />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Post editor
// ---------------------------------------------------------------------------------------------------------------

export function PostEditorPage() {
  const { postId = "" } = useParams();
  const qc = useQueryClient();
  const blog = useBlog();
  const q = useQuery({ queryKey: [...KEY, "post", postId], queryFn: () => api.get<PostDetail>(`/sites/blog/posts/${postId}`), refetchOnWindowFocus: false });
  const [showSettings, setShowSettings] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  if (q.isLoading || blog.isLoading) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>;
  if (q.isError || !q.data || !blog.data?.blog) {
    const gone = (q.error as { status?: number } | null)?.status === 404;
    return gone ? <EmptyState icon={<IconBook />} title="Post not found" body="It may have been deleted, or it is a draft you can't open." action={<Link to="/app/docs/sites?tab=blog" className="text-sm font-medium text-brand-hover underline">All posts</Link>} />
      : <LoadError onRetry={() => { void q.refetch(); void blog.refetch(); }} />;
  }
  const p = q.data;
  const b = blog.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: KEY }); };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 max-sm:-mt-2">
        <Link to="/app/docs/sites?tab=blog" className="inline-flex min-h-9 items-center gap-1 text-sm text-muted hover:text-fg max-sm:min-h-11"><IconArrowLeft className="h-4 w-4" aria-hidden />Blog</Link>
        <PostBadge p={p} />
        <div className="ml-auto flex items-center gap-1.5">
          {p.canEdit && <a href={p.previewUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted hover:text-fg max-sm:min-h-11"><IconEye className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">Preview</span></a>}
          {p.status === "published" && <a href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted hover:text-fg max-sm:min-h-11"><IconExternalLink className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">View post</span></a>}
          {p.canEdit && <Button variant="outline" className="lg:hidden" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings} aria-controls="post-settings"><IconSettings className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">Post settings</span></Button>}
          {p.canEdit && <Button onClick={() => setPublishOpen(true)} data-testid="post-publish">{p.status === "published" ? "Update" : p.status === "scheduled" ? "Reschedule" : "Publish"}</Button>}
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className={cn("min-w-0", showSettings && "max-lg:hidden")}>
          {p.canEdit ? <EmbeddedDoc docId={p.docId} /> : <Card className="p-6"><p className="font-medium">{p.title}</p><p className="mt-1 text-sm text-muted">Only admins and site editors can change posts. <a className="underline" href={p.url} target="_blank" rel="noopener noreferrer">Read it on the blog</a>.</p></Card>}
        </div>
        {p.canEdit && <aside id="post-settings" aria-label="Post settings" className={cn("min-w-0", !showSettings && "max-lg:hidden")}><PostSettings p={p} b={b} onChanged={refresh} /></aside>}
      </div>
      {publishOpen && <PublishDialog p={p} b={b} onClose={() => setPublishOpen(false)} onDone={refresh} />}
    </div>
  );
}

function PostSettings({ p, b, onChanged }: { p: PostDetail; b: BlogOut; onChanged: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [slug, setSlug] = useState(p.slug);
  const [excerpt, setExcerpt] = useState(p.excerpt);
  const [tagText, setTagText] = useState("");
  const [cover, setCover] = useState(p.cover);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmUnpub, setConfirmUnpub] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { setSlug(p.slug); setExcerpt(p.excerpt); setCover(p.cover); }, [p.id, p.slug, p.excerpt, p.cover]);
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch<PostDetail>(`/sites/blog/posts/${p.id}`, patch),
    onSuccess: (r) => { qc.setQueryData([...KEY, "post", p.id], r); onChanged(); },
    onError: (e) => { toast.error(errorMessage(e)); setSlug(p.slug); },
  });
  const unpub = useMutation({ mutationFn: () => api.post<PostDetail>(`/sites/blog/posts/${p.id}/unpublish`), onSuccess: (r) => { qc.setQueryData([...KEY, "post", p.id], r); onChanged(); setConfirmUnpub(false); toast.success("Unpublished. Visitors can't see it now."); }, onError: (e) => toast.error(errorMessage(e)) });
  const del = useMutation({ mutationFn: () => api.del(`/sites/blog/posts/${p.id}`), onSuccess: () => { onChanged(); toast.success("Post deleted. Its text stays in Docs."); nav("/app/docs/sites?tab=blog"); }, onError: (e) => toast.error(errorMessage(e)) });
  const slugErr = slug !== p.slug ? postSlugProblem(slug) : null;
  const addTags = () => {
    const more = tagText.split(",").map((t) => t.trim()).filter(Boolean);
    if (!more.length) return;
    save.mutate({ tags: [...p.tags, ...more] }); setTagText("");
  };
  const upload = async (f: File) => {
    try { const src = await uploadDocImage(p.docId, f); setCover(src); save.mutate({ cover: src }); } catch (e) { toast.error(errorMessage(e)); }
  };
  const newsletter = b.blog?.newsletter;
  return (
    <div className="space-y-5 lg:sticky lg:top-4">
      <Card className="space-y-4 p-4">
        <h2 className="text-sm font-semibold">Post settings</h2>
        <div>
          <label className={label()} htmlFor="ps-slug">Address</label>
          <div className="mt-1 flex items-center gap-1 text-sm"><span className="shrink-0 text-subtle">/blog/</span>
            <Input id="ps-slug" value={slug} maxLength={80} aria-invalid={!!slugErr} aria-describedby="ps-slug-hint" onChange={(e) => setSlug(e.target.value.toLowerCase())} onBlur={() => { if (slug !== p.slug && !slugErr) save.mutate({ slug }); }} />
          </div>
          <p id="ps-slug-hint" className={cn("mt-1 text-xs", slugErr ? "text-bad" : "text-subtle")}>{slugErr ?? (p.status === "published" ? "Changing it moves the post. The old address stops working." : "Lowercase letters, numbers and hyphens.")}</p>
        </div>
        <div>
          <label className={label()} htmlFor="ps-excerpt">Excerpt</label>
          <Textarea id="ps-excerpt" className="mt-1" rows={3} maxLength={MAX_EXCERPT} value={excerpt} onChange={(e) => setExcerpt(e.target.value)} onBlur={() => { if (excerpt !== p.excerpt) save.mutate({ excerpt }); }} placeholder="Shown in the post list, in search results and in the email" />
          <p className="mt-1 text-xs text-subtle">{excerpt.length}/{MAX_EXCERPT}. Left empty, the first lines of the post are used.</p>
        </div>
        <div>
          <p className={label()} id="ps-cover-l">Cover image</p>
          {cover ? <img src={cover} alt="Cover" className="mt-1 aspect-video w-full rounded-lg bg-elevated object-cover" /> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" aria-labelledby="ps-cover-l" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
            <Button variant="outline" size="sm" onClick={() => file.current?.click()}><IconUpload className="h-4 w-4" aria-hidden />{cover ? "Replace" : "Upload"}</Button>
            {cover && <Button variant="ghost" size="sm" onClick={() => { setCover(""); save.mutate({ cover: "" }); }}>Remove</Button>}
          </div>
          <label className="mt-2 block text-xs text-subtle" htmlFor="ps-cover-url">Or an image link</label>
          <Input id="ps-cover-url" className="mt-1" value={/^https:/.test(cover) ? cover : ""} placeholder="https://" maxLength={2048} onChange={(e) => setCover(e.target.value)} onBlur={(e) => { if (e.target.value !== p.cover && (/^https:\/\//.test(e.target.value) || !e.target.value)) save.mutate({ cover: e.target.value }); }} />
        </div>
        <div>
          <label className={label()} htmlFor="ps-tags">Tags</label>
          {p.tags.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Tags on this post">
              {p.tags.map((t) => (
                <li key={t} className="inline-flex items-center gap-1 rounded-full border border-line py-0.5 pl-2.5 pr-1 text-sm">{t}
                  <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded-full text-subtle hover:bg-hover hover:text-fg max-sm:h-8 max-sm:w-8" aria-label={`Remove tag ${t}`} onClick={() => save.mutate({ tags: p.tags.filter((x) => x !== t) })}>×</button>
                </li>
              ))}
            </ul>
          )}
          {p.tags.length < MAX_TAGS_PER_POST && (
            <div className="mt-2 flex gap-2">
              <Input id="ps-tags" value={tagText} maxLength={120} onChange={(e) => setTagText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTags(); } }} placeholder="Add a tag, then press Enter" />
              <Button variant="outline" size="sm" onClick={addTags} disabled={!tagText.trim()}>Add</Button>
            </div>
          )}
        </div>
        <div>
          <label className={label()} htmlFor="ps-author">Author</label>
          <Select id="ps-author" className="mt-1" value={p.authorId ?? ""} onChange={(e) => save.mutate({ authorId: e.target.value || null })}>
            <option value="">No author</option>
            {b.people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </div>
      </Card>
      <Card className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><IconMail className="h-4 w-4" aria-hidden />Email to subscribers</h2>
        {p.emailState === "sent" || p.emailState === "scheduled" ? (
          <p className="text-sm text-muted">{p.emailState === "sent" ? "This post was emailed to subscribers. It won't be sent again." : "The email goes out when the post goes live. Unpublish to cancel it."}</p>
        ) : !newsletter?.available ? (
          <p className="text-sm text-muted">Email newsletters are not on for this workspace.</p>
        ) : !p.canEmail ? (
          <p className="text-sm text-muted">Only admins can email a post to subscribers.</p>
        ) : (
          <>
            <Switch checked={p.emailOnPublish} onChange={(v) => save.mutate({ emailOnPublish: v })} label="Email this post to subscribers when it goes live" />
            <p className="text-xs text-subtle">
              {newsletter.ready ? `${newsletter.counts.subscribed} confirmed subscriber${newsletter.counts.subscribed === 1 ? "" : "s"}. Sent once, through Campaigns, with your sender details and an unsubscribe link. People who haven't confirmed or who unsubscribed never get it.` : `Finish the newsletter settings first: ${newsletter.problems.join(" ")}`}
            </p>
          </>
        )}
      </Card>
      <div className="flex flex-wrap gap-2">
        {p.status !== "draft" && <Button variant="outline" onClick={() => setConfirmUnpub(true)}>{p.status === "scheduled" ? "Cancel schedule" : "Unpublish"}</Button>}
        <Button variant="ghost" className="text-bad" onClick={() => setConfirmDel(true)}><IconTrash className="h-4 w-4" aria-hidden />Delete post</Button>
      </div>
      <ConfirmDialog open={confirmUnpub} onClose={() => setConfirmUnpub(false)} onConfirm={() => unpub.mutate()} busy={unpub.isPending} tone="primary" confirmLabel={p.status === "scheduled" ? "Cancel schedule" : "Unpublish"}
        title={p.status === "scheduled" ? "Cancel the schedule?" : "Unpublish this post?"} description={p.emailState === "scheduled" ? "The post goes back to draft and its email is cancelled." : "The post goes back to draft. Visitors and the RSS feed stop showing it at once."} />
      <ConfirmDialog open={confirmDel} onClose={() => setConfirmDel(false)} onConfirm={() => del.mutate()} busy={del.isPending} title="Delete this post?" description="It leaves the blog. Its text stays in Docs, so you can bring it back as a new post." />
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function PublishDialog({ p, b, onClose, onDone }: { p: PostDetail; b: BlogOut; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const live = p.status === "published";
  const [when, setWhen] = useState<"now" | "later">(p.status === "scheduled" ? "later" : "now");
  const [at, setAt] = useState(() => localInput(p.publishAt && p.publishAt > Date.now() ? p.publishAt : Date.now() + 86_400_000));
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const m = useMutation({
    // The browser turns the local date and time into an exact moment, so the server never guesses a time zone.
    mutationFn: () => api.post<PublishOut>(`/sites/blog/posts/${p.id}/publish`, { at: !live && when === "later" ? new Date(at).getTime() : null }),
    onSuccess: (r) => {
      qc.setQueryData([...KEY, "post", p.id], r.post); onDone(); onClose();
      toast.success(r.post.status === "scheduled" ? `Scheduled for ${fmt(r.post.publishAt!)}` : live ? "Live copy updated" : "Published");
      if (r.email.status === "skipped") toast.warning(r.email.message); else if (r.email.message) toast.success(r.email.message);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const n = b.blog?.newsletter;
  return (
    <Dialog open onClose={onClose} title={live ? "Update the live post" : "Publish post"} description={live ? "Visitors see your latest text, title, cover and tags. The publish date stays the same." : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} data-testid="publish-confirm">{live ? "Update" : when === "later" ? "Schedule" : "Publish now"}</Button></>}>
      {!live && (
        <fieldset className="space-y-2">
          <legend className="sr-only">When</legend>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="when" checked={when === "now"} onChange={() => setWhen("now")} />Publish now</label>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="when" checked={when === "later"} onChange={() => setWhen("later")} />Pick a date and time</label>
          {when === "later" && (
            <div className="pl-6">
              <label className="sr-only" htmlFor="pub-at">Date and time</label>
              <Input id="pub-at" type="datetime-local" value={at} min={localInput(Date.now())} onChange={(e) => setAt(e.target.value)} />
              <p className="mt-1 text-xs text-subtle">Your time zone: {tz}.</p>
            </div>
          )}
        </fieldset>
      )}
      <p className={cn("text-sm text-muted", !live && "mt-4")}>
        {p.emailState === "sent" || p.emailState === "scheduled" ? "Subscribers already got this post, so no new email goes out."
          : p.emailOnPublish && n?.ready ? `An email goes to ${n.counts.subscribed} confirmed subscriber${n.counts.subscribed === 1 ? "" : "s"} when it goes live.`
          : "No email goes out. Tick Email this post in the settings to send it to subscribers."}
      </p>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Subscribers, authors, settings
// ---------------------------------------------------------------------------------------------------------------

function SubscribersView({ blog }: { blog: BlogInfo }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [deb, setDeb] = useState("");
  const [status, setStatus] = useState("");
  const [remove, setRemove] = useState<{ id: string; email: string } | null>(null);
  useEffect(() => { const t = setTimeout(() => setDeb(q), 200); return () => clearTimeout(t); }, [q]);
  const qs = new URLSearchParams(Object.entries({ q: deb, status }).filter(([, v]) => v)).toString();
  const s = useQuery({ queryKey: [...KEY, "subs", qs], queryFn: () => api.get<SubsOut>(`/sites/blog/subscribers${qs ? `?${qs}` : ""}`), placeholderData: (x) => x });
  const rm = useMutation({ mutationFn: (id: string) => api.del(`/sites/blog/subscribers/${id}`), onSuccess: () => { setRemove(null); void qc.invalidateQueries({ queryKey: KEY }); toast.success("Subscriber removed"); }, onError: (e) => toast.error(errorMessage(e)) });
  if (s.isLoading) return <div className="space-y-2" aria-busy="true"><Skeleton className="h-20 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (s.isError || !s.data) return <LoadError onRetry={() => s.refetch()} />;
  const c = s.data.counts;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 max-sm:gap-2">
        <StatTile label="Confirmed" value={c.subscribed} />
        <StatTile label="Waiting to confirm" value={c.pending} />
        <StatTile label="Unsubscribed" value={c.unsubscribed} />
      </div>
      {!blog.newsletter?.ready && <Card className="p-4 text-sm"><p className="font-medium">The subscribe box is hidden until the newsletter is set up.</p><p className="mt-1 text-muted">{blog.newsletter?.problems.join(" ")} Open Settings to finish.</p></Card>}
      <div className="flex flex-wrap gap-2">
        <label className="relative min-w-[12rem] flex-1"><span className="sr-only">Search subscribers</span>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by email" className="pl-9" type="search" />
        </label>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-44"><option value="">Everyone</option><option value="subscribed">Confirmed</option><option value="pending">Waiting to confirm</option><option value="unsubscribed">Unsubscribed</option></Select>
        <a href="/api/sites/blog/subscribers.csv" download className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-medium hover:bg-hover max-sm:min-h-11"><IconDownload className="h-4 w-4" aria-hidden />Export CSV</a>
      </div>
      {s.data.subscribers.length === 0 ? (
        <EmptyState icon={<IconMail />} title={qs ? "No subscribers match" : "No subscribers yet"} body={qs ? "Try other words." : "People who subscribe on the blog show here once they sign up. They get a link to confirm first."} />
      ) : (
        <Card className="divide-y divide-line p-0">
          {s.data.subscribers.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <span className="min-w-0 flex-1 truncate font-medium" title={m.email}>{m.email}</span>
              <Badge tone={m.status === "subscribed" ? "ok" : m.status === "pending" ? "warn" : "neutral"}>{m.status === "subscribed" ? "Confirmed" : m.status === "pending" ? "Waiting to confirm" : m.status === "unsubscribed" ? "Unsubscribed" : m.status}</Badge>
              <span className="text-xs text-subtle max-sm:basis-full">{m.source}{m.at ? `, ${fmtDay(Date.parse(m.at))}` : ""}</span>
              <Button variant="ghost" size="sm" aria-label={`Remove ${m.email}`} onClick={() => setRemove({ id: m.id, email: m.email })}><IconTrash className="h-4 w-4" aria-hidden /></Button>
            </div>
          ))}
        </Card>
      )}
      {s.data.more && <p className="text-xs text-subtle">Showing the newest 50. Search or export to see everyone.</p>}
      <ConfirmDialog open={!!remove} onClose={() => setRemove(null)} onConfirm={() => remove && rm.mutate(remove.id)} busy={rm.isPending} confirmLabel="Remove" title="Remove this subscriber?" description={`${remove?.email ?? ""} is taken off the list and gets no more posts. To stop all your emails to them, they can unsubscribe from any email.`} />
    </div>
  );
}

function AuthorsView({ blog }: { blog: BlogInfo }) {
  const a = useQuery({ queryKey: [...KEY, "authors"], queryFn: () => api.get<{ authors: AuthorInfo[] }>("/sites/blog/authors") });
  const [edit, setEdit] = useState<AuthorInfo | null>(null);
  if (a.isLoading) return <div className="space-y-2" aria-busy="true">{[0, 1].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  if (a.isError || !a.data) return <LoadError onRetry={() => a.refetch()} />;
  if (!a.data.authors.length) return <EmptyState icon={<IconUser />} title="No authors yet" body="Whoever writes a post becomes its author. Each author gets a public page with their name, a short bio and a photo." />;
  return (
    <>
      <Card className="divide-y divide-line p-0">
        {a.data.authors.map((x) => (
          <div key={x.userId} className="flex items-center gap-3 px-4 py-3">
            {x.photo ? <img src={x.photo} alt="" className="h-10 w-10 shrink-0 rounded-full bg-elevated object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-elevated text-subtle" aria-hidden><IconUser className="h-5 w-5" /></span>}
            <span className="min-w-0 flex-1"><span className="block truncate font-medium">{x.name}</span><span className="block truncate text-sm text-muted">{x.bio || "No bio yet"}</span></span>
            <span className="text-xs text-subtle max-sm:hidden">{x.posts} post{x.posts === 1 ? "" : "s"}</span>
            <Button variant="outline" size="sm" onClick={() => setEdit(x)} aria-label={`Edit ${x.name}`}>Edit</Button>
          </div>
        ))}
      </Card>
      {edit && <AuthorDialog a={edit} rootDocId={blog.rootDocId} onClose={() => setEdit(null)} />}
    </>
  );
}

function AuthorDialog({ a, rootDocId, onClose }: { a: AuthorInfo; rootDocId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(a.name);
  const [bio, setBio] = useState(a.bio);
  const [photo, setPhoto] = useState(a.photo);
  const file = useRef<HTMLInputElement>(null);
  const m = useMutation({ mutationFn: () => api.patch(`/sites/blog/authors/${a.userId}`, { name, bio, photo }), onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); toast.success("Author saved"); onClose(); }, onError: (e) => toast.error(errorMessage(e)) });
  return (
    <Dialog open onClose={onClose} title="Author profile" description="Shown on the author's public page and under their posts."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending}>Save</Button></>}>
      <div className="space-y-3">
        <div><label className={label()} htmlFor="au-name">Name</label><Input id="au-name" className="mt-1" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className={label()} htmlFor="au-bio">Short bio</label><Textarea id="au-bio" className="mt-1" rows={3} maxLength={400} value={bio} onChange={(e) => setBio(e.target.value)} /></div>
        <div>
          <p className={label()} id="au-photo-l">Photo</p>
          <div className="mt-1 flex items-center gap-3">
            {photo ? <img src={photo} alt="" className="h-12 w-12 rounded-full bg-elevated object-cover" /> : null}
            <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" aria-labelledby="au-photo-l" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f || !rootDocId) return; try { setPhoto(await uploadDocImage(rootDocId, f)); } catch (err) { toast.error(errorMessage(err)); } }} />
            <Button variant="outline" size="sm" onClick={() => file.current?.click()} disabled={!rootDocId}><IconUpload className="h-4 w-4" aria-hidden />{photo ? "Replace" : "Upload"}</Button>
            {photo && <Button variant="ghost" size="sm" onClick={() => setPhoto("")}>Remove</Button>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function BlogSettings({ d, blog }: { d: BlogOut; blog: BlogInfo }) {
  const qc = useQueryClient();
  const mailboxes = useMailboxes();
  const n = blog.newsletter;
  const [title, setTitle] = useState(blog.title);
  const [desc, setDesc] = useState(blog.description);
  const [sender, setSender] = useState(n?.senderName ?? "");
  const [address, setAddress] = useState(n?.senderAddress ?? "");
  // Fields save on blur; saves run one after another so two quick edits cannot overwrite each other on the server.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const m = useMutation({ mutationFn: (patch: Record<string, unknown>) => { const next = chain.current.catch(() => undefined).then(() => api.patch<BlogOut>("/sites/blog", patch)); chain.current = next; return next; }, onSuccess: (r) => { qc.setQueryData(KEY, r); toast.success("Saved"); }, onError: (e) => toast.error(errorMessage(e)) });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="space-y-4 p-4">
        <h2 className="text-sm font-semibold">Blog</h2>
        <div><label className={label()} htmlFor="bs-title">Name</label><Input id="bs-title" className="mt-1" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== blog.title && m.mutate({ title })} /><p className="mt-1 text-xs text-subtle">Shown in the site's menu, page titles and the feed.</p></div>
        <div><label className={label()} htmlFor="bs-desc">Description</label><Textarea id="bs-desc" className="mt-1" rows={2} maxLength={300} value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== blog.description && m.mutate({ description: desc })} /></div>
        <div><p className={label()}>RSS feed</p><div className="mt-1 flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded bg-elevated px-2 py-1 text-xs">{blog.rssUrl}</code><CopyButton value={blog.rssUrl} label="Copy feed address" /></div></div>
      </Card>
      <Card className="space-y-4 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><IconMail className="h-4 w-4" aria-hidden />Subscribe box and newsletter</h2>
        {!n?.available ? <p className="text-sm text-muted">Email newsletters are not on for this workspace, so the blog has no subscribe box.</p> : !d.isAdmin ? <p className="text-sm text-muted">Only admins can change the newsletter settings.</p> : (
          <>
            <Switch checked={blog.subscribeOn} onChange={(v) => m.mutate({ subscribeOn: v })} label="Show a subscribe box on the blog" />
            <div><label className={label()} htmlFor="bs-mailbox">Sends from</label>
              <Select id="bs-mailbox" className="mt-1" value={n.mailboxId ?? ""} onChange={(e) => m.mutate({ mailboxId: e.target.value || null })}>
                <option value="">Pick a mailbox</option>{(mailboxes.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.address}</option>)}
              </Select></div>
            <div><label className={label()} htmlFor="bs-sender">Sender name</label><Input id="bs-sender" className="mt-1" value={sender} maxLength={120} onChange={(e) => setSender(e.target.value)} onBlur={() => sender !== n.senderName && m.mutate({ senderName: sender })} /></div>
            <div><label className={label()} htmlFor="bs-address">Contact address</label><Input id="bs-address" className="mt-1" value={address} maxLength={300} onChange={(e) => setAddress(e.target.value)} onBlur={() => address !== n.senderAddress && m.mutate({ senderAddress: address })} placeholder="1 George St, Sydney NSW 2000" /><p className="mt-1 text-xs text-subtle">The law asks for the sender and a way to reach you in every email. It shows at the bottom of each one.</p></div>
            <p className={cn("text-sm", n.ready ? "text-good" : "text-muted")}>{n.ready ? (blog.subscribeOn ? "Ready. Visitors can subscribe; they confirm by email first." : "Ready. Turn on the subscribe box to take subscribers.") : `To finish: ${n.problems.join(" ")}`}</p>
          </>
        )}
      </Card>
    </div>
  );
}

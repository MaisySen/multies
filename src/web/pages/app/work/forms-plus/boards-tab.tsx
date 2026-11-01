/**
 * R93: feedback boards in Work > Forms. Admins make boards, change statuses, approve, merge duplicates; members vote
 * and post. A list (Top, New, status, search) and a Roadmap view (Planned, In progress, Done).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { useDialogs } from "@/web/components/ui/confirm";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { IconArrowUp, IconExternalLink, IconMegaphone, IconPlus } from "@/web/components/ui/icon";
import { PUBLIC_STATUSES, ROADMAP_COLUMNS, SETTABLE_STATUSES, STATUS_LABELS, type PostStatus } from "@/shared/forms-plus";

export interface BoardRow { id: string; name: string; description: string; slug: string; url: string; isPublic: boolean; allowIdeas: boolean; moderate: boolean; posts: number; pending: number }
export interface PostRow { id: string; title: string; body: string; status: PostStatus; statusLabel: string; author: string; votes: number; voted: boolean; createdAt: string; authorEmail?: string | null }

export const statusTone = (s: PostStatus) => (s === "done" ? "ok" : s === "progress" || s === "planned" ? "brand" : s === "pending" ? "warn" : s === "closed" ? "neutral" : "neutral") as "ok" | "brand" | "warn" | "neutral";

export function VoteButton({ votes, voted, onClick, busy, label }: { votes: number; voted: boolean; onClick: () => void; busy?: boolean; label: string }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} aria-pressed={voted} aria-label={`${voted ? "Remove your vote for" : "Vote for"} ${label}, ${votes} ${votes === 1 ? "vote" : "votes"}`}
      className={`flex h-14 w-12 shrink-0 flex-col items-center justify-center rounded-lg border text-[13px] font-semibold tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60 ${voted ? "border-brand bg-brand/10 text-brand" : "border-line hover:bg-hover"}`} data-testid="vote">
      <IconArrowUp className="h-4 w-4" />{votes}
    </button>
  );
}

function BoardDialog({ board, onClose }: { board: Partial<BoardRow>; onClose: () => void }) {
  const qc = useQueryClient();
  const [b, setB] = useState<Partial<BoardRow>>({ isPublic: true, allowIdeas: true, moderate: true, ...board });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: b.name, description: b.description ?? "", isPublic: b.isPublic, allowIdeas: b.allowIdeas, moderate: b.moderate };
      if (b.id) await api.patch(`/forms-plus/boards/${b.id}`, body); else await api.post("/forms-plus/boards", body);
      await qc.invalidateQueries({ queryKey: ["fp-boards"] });
      onClose();
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const row = (key: "isPublic" | "allowIdeas" | "moderate", title: string, line: string) => (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
      <div><div className="text-[13px] font-medium">{title}</div><div className="text-[12px] text-muted">{line}</div></div>
      <Switch checked={!!b[key]} onChange={(v) => setB({ ...b, [key]: v })} label={title} />
    </div>
  );
  return (
    <Dialog open onClose={onClose} title={b.id ? "Board settings" : "New feedback board"} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy} disabled={!b.name?.trim()} data-testid="board-save">Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name">{(fp) => <Input {...fp} value={b.name ?? ""} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder="Product ideas" />}</Field>
        <Field label="Intro" hint="Shown at the top of the board.">{(fp) => <Textarea {...fp} value={b.description ?? ""} onChange={(e) => setB({ ...b, description: e.target.value })} className="min-h-16" />}</Field>
        {row("isPublic", "Public", "Anyone with the link can read, vote and follow the roadmap.")}
        {row("allowIdeas", "Visitors can post ideas", "Turn off to collect votes on your own posts only.")}
        {row("moderate", "Approve new ideas first", "Ideas from visitors wait until an admin approves them.")}
      </div>
    </Dialog>
  );
}

function MergeDialog({ from, posts, onClose, onDone }: { from: PostRow; posts: PostRow[]; onClose: () => void; onDone: () => void }) {
  const [into, setInto] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const r = await api.post<{ moved: number }>(`/forms-plus/posts/${from.id}/merge`, { intoId: into }); toast.success(`Merged. ${r.moved} ${r.moved === 1 ? "vote" : "votes"} moved over.`); onDone(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Merge into another post" description={`"${from.title}" becomes a link to the post you pick. Its votes move over; nobody is counted twice.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void go()} loading={busy} disabled={!into} data-testid="merge-go">Merge</Button></>}>
      <Field label="Merge into">{(fp) => (
        <Select {...fp} value={into} onChange={(e) => setInto(e.target.value)} data-testid="merge-into">
          <option value="">Pick a post</option>
          {posts.filter((p) => p.id !== from.id && p.status !== "pending").map((p) => <option key={p.id} value={p.id}>{p.title} ({p.votes})</option>)}
        </Select>
      )}</Field>
    </Dialog>
  );
}

function BoardView({ board, onBack }: { board: BoardRow; onBack: () => void }) {
  const qc = useQueryClient();
  const { confirm, dialogs } = useDialogs();
  const [view, setView] = useState<"list" | "roadmap">("list");
  const [sort, setSort] = useState<"top" | "new">("top");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [title, setTitle] = useState("");
  const [merging, setMerging] = useState<PostRow | null>(null);
  const [editing, setEditing] = useState(false);
  const key = ["fp-board", board.id, sort, status, q];
  const data = useQuery({ queryKey: key, queryFn: () => api.get<{ canManage: boolean; posts: PostRow[]; more: boolean }>(`/forms-plus/boards/${board.id}?sort=${sort}&status=${status}&q=${encodeURIComponent(q)}`) });
  const road = useQuery({ queryKey: ["fp-road", board.id], enabled: view === "roadmap", queryFn: () => api.get<{ roadmap: Record<string, PostRow[]> }>(`/forms-plus/boards/${board.id}/roadmap`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["fp-board", board.id] }); void qc.invalidateQueries({ queryKey: ["fp-road", board.id] }); void qc.invalidateQueries({ queryKey: ["fp-boards"] }); };
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); refresh(); } catch (e) { showError(e as Error); } };
  const manage = !!data.data?.canManage;
  const add = () => run(async () => { await api.post(`/forms-plus/boards/${board.id}/posts`, { title }); setTitle(""); });
  return (
    <div className="space-y-4" data-testid="board-view">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>All boards</Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{board.name}</h2>
        {board.isPublic && <a href={board.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] hover:bg-hover max-sm:min-h-11"><IconExternalLink className="h-3.5 w-3.5" />Open</a>}
        {board.isPublic && <CopyButton value={board.url} label="Copy link" />}
        {manage && <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Settings</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="View" className="inline-flex rounded-lg border border-line p-0.5">
          {(["list", "roadmap"] as const).map((v) => <button key={v} role="tab" type="button" aria-selected={view === v} onClick={() => setView(v)} className={`h-8 rounded-md px-3 text-[13px] font-medium max-sm:min-h-11 ${view === v ? "bg-fill text-fg" : "text-muted hover:text-fg"}`}>{v === "list" ? "Posts" : "Roadmap"}</button>)}
        </div>
        {view === "list" && (
          <>
            <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as "top" | "new")} className="h-8 w-28 text-[13px]"><option value="top">Top</option><option value="new">New</option></Select>
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-44 text-[13px]"><option value="">Any status</option>{(manage ? ["pending", ...PUBLIC_STATUSES] : PUBLIC_STATUSES).map((s) => <option key={s} value={s}>{STATUS_LABELS[s as PostStatus]}</option>)}</Select>
            <Input aria-label="Search posts" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-8 min-w-0 flex-1 text-[13px] sm:max-w-56" />
          </>
        )}
      </div>
      {view === "list" && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (title.trim().length >= 3) void add(); }}>
          <Input aria-label="New idea" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add an idea or request" maxLength={160} className="min-w-0 flex-1" data-testid="board-new-post" />
          <Button type="submit" disabled={title.trim().length < 3}><IconPlus className="h-4 w-4" />Add</Button>
        </form>
      )}
      {view === "roadmap" ? (
        road.isPending ? <Skeleton className="h-48" /> : road.isError ? <Card className="p-6 text-center text-[13px]">Couldn't load the roadmap. <Button size="sm" variant="ghost" onClick={() => void road.refetch()}>Try again</Button></Card> : (
          <div className="grid gap-3 md:grid-cols-3" data-testid="roadmap">
            {ROADMAP_COLUMNS.map((col) => (
              <section key={col} className="rounded-xl bg-fill/60 p-2.5" aria-label={STATUS_LABELS[col]}>
                <h3 className="mb-2 flex items-center justify-between px-1 text-[13px] font-semibold">{STATUS_LABELS[col]}<span className="font-normal text-muted">{road.data!.roadmap[col]?.length ?? 0}</span></h3>
                <div className="space-y-2">
                  {(road.data!.roadmap[col] ?? []).map((p) => <Card key={p.id} className="p-3"><div className="break-words text-[14px] font-medium">{p.title}</div><div className="mt-1 text-[12px] text-muted">{p.votes} {p.votes === 1 ? "vote" : "votes"}</div></Card>)}
                  {!road.data!.roadmap[col]?.length && <p className="px-1 py-3 text-[12.5px] text-muted">Nothing here yet.</p>}
                </div>
              </section>
            ))}
          </div>
        )
      ) : data.isPending ? <Skeleton className="h-48" /> : data.isError ? (
        <Card className="p-6 text-center text-[13px]">Couldn't load the posts. <Button size="sm" variant="ghost" onClick={() => void data.refetch()}>Try again</Button></Card>
      ) : !data.data!.posts.length ? (
        <Card><EmptyState icon={<IconMegaphone />} title={q || status ? "No posts match" : "No posts yet"} body={q || status ? "Try another search or status." : "Add the first idea above, or share the board link so people can post and vote."} /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {data.data!.posts.map((p) => (
            <div key={p.id} className="flex gap-3 p-3.5" data-testid="board-post">
              <VoteButton votes={p.votes} voted={p.voted} label={p.title} onClick={() => void run(() => api.post(`/forms-plus/posts/${p.id}/vote`, { on: !p.voted }))} />
              <div className="min-w-0 flex-1">
                <div className="break-words text-[14px] font-medium">{p.title}</div>
                {p.body && <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-[13px] text-muted">{p.body}</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-subtle">
                  <Badge tone={statusTone(p.status)}>{p.statusLabel}</Badge>
                  <span>{manage && p.authorEmail ? `${p.author} (${p.authorEmail})` : p.author}, {timeAgo(p.createdAt)}</span>
                </div>
              </div>
              {manage && (
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {p.status === "pending" ? <Button size="sm" onClick={() => void run(() => api.patch(`/forms-plus/posts/${p.id}`, { status: "open" }))} data-testid="approve">Approve</Button> : (
                    <Select aria-label={`Status of ${p.title}`} value={p.status} onChange={(e) => void run(() => api.patch(`/forms-plus/posts/${p.id}`, { status: e.target.value }))} className="h-8 w-36 text-[12.5px]" data-testid="post-status">
                      {SETTABLE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                    </Select>
                  )}
                  <div className="flex gap-1">
                    {p.status !== "pending" && <Button size="sm" variant="ghost" onClick={() => setMerging(p)}>Merge</Button>}
                    <Button size="sm" variant="ghost" className="text-bad" onClick={() => void (async () => { if (await confirm({ title: `Delete "${p.title}"?`, description: "Its votes go too. This can't be undone.", confirmLabel: "Delete", tone: "danger" })) await run(() => api.del(`/forms-plus/posts/${p.id}`)); })()}>Delete</Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
      {merging && <MergeDialog from={merging} posts={data.data?.posts ?? []} onClose={() => setMerging(null)} onDone={() => { setMerging(null); refresh(); }} />}
      {editing && <BoardDialog board={board} onClose={() => { setEditing(false); refresh(); }} />}
      {dialogs}
    </div>
  );
}

export function BoardsTab() {
  const q = useQuery({ queryKey: ["fp-boards"], queryFn: () => api.get<{ boards: BoardRow[]; canCreate: boolean }>("/forms-plus/boards") });
  const [making, setMaking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const current = q.data?.boards.find((b) => b.id === open);
  if (current) return <BoardView board={current} onBack={() => setOpen(null)} />;
  return (
    <div className="space-y-3">
      {q.data?.canCreate && <div className="flex justify-end"><Button onClick={() => setMaking(true)} data-testid="new-board"><IconPlus className="h-4 w-4" />New board</Button></div>}
      {q.isPending ? <Skeleton className="h-40" /> : q.isError ? (
        <Card className="p-6 text-center text-[13px]">Couldn't load your boards. <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>Try again</Button></Card>
      ) : !q.data!.boards.length ? (
        <Card><EmptyState icon={<IconMegaphone />} title="No feedback boards yet" body="Collect ideas from customers and your team, let people vote, and show what is planned on a public roadmap."
          action={q.data!.canCreate ? <Button onClick={() => setMaking(true)}>New board</Button> : undefined} /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {q.data!.boards.map((b) => (
            <button key={b.id} type="button" onClick={() => setOpen(b.id)} className="flex w-full items-center gap-3 p-4 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand" data-testid="board-row">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium">{b.name}</div>
                <div className="mt-0.5 text-[12.5px] text-muted">{b.isPublic ? "Public" : "Members only"} · {b.posts} {b.posts === 1 ? "post" : "posts"}</div>
              </div>
              {b.pending > 0 && <Badge tone="warn">{b.pending} to approve</Badge>}
            </button>
          ))}
        </Card>
      )}
      {making && <BoardDialog board={{}} onClose={() => setMaking(false)} />}
    </div>
  );
}

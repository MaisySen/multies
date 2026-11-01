/**
 * R93: the public feedback board at /fb/<slug>. Anyone can read, vote (one vote per email, remembered on this device
 * so it can be taken back) and post an idea; every write carries the spam shield. Emails are never shown.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { IconMegaphone, IconPlus } from "@/web/components/ui/icon";
import { Honeypot, useShield } from "@/web/lib/use-shield";
import { PUBLIC_STATUSES, ROADMAP_COLUMNS, STATUS_LABELS, isEmail, type PostStatus } from "@/shared/forms-plus";
import { statusTone, VoteButton, type PostRow } from "./boards-tab";

interface PublicBoard { board: { name: string; description: string; slug: string; allowIdeas: boolean; moderate: boolean; workspace: string }; posts: PostRow[]; more: boolean }
type Mine = Record<string, { voteId: string; token: string }>;
const store = (slug: string) => `fb:${slug}`;
const readMine = (slug: string): { email: string; name: string; votes: Mine } => { try { return { email: "", name: "", votes: {}, ...JSON.parse(localStorage.getItem(store(slug)) ?? "{}") }; } catch { return { email: "", name: "", votes: {} }; } };

function WhoDialog({ title, onClose, onDone, initial }: { title: string; onClose: () => void; onDone: (v: { email: string; name: string }) => void; initial: { email: string; name: string } }) {
  const [email, setEmail] = useState(initial.email);
  const [name, setName] = useState(initial.name);
  const ok = isEmail(email.trim());
  return (
    <Dialog open onClose={onClose} title={title} description="We count one vote per person. Your email is never shown."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!ok} onClick={() => onDone({ email: email.trim(), name: name.trim() })} data-testid="who-ok">Vote</Button></>}>
      <div className="space-y-3">
        <Field label="Email">{(fp) => <Input {...fp} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="who-email" />}</Field>
        <Field label="Name" hint="Optional.">{(fp) => <Input {...fp} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

function IdeaDialog({ slug, moderate, who, onClose, onDone }: { slug: string; moderate: boolean; who: { email: string; name: string }; onClose: () => void; onDone: (r: { pending: boolean; who: { email: string; name: string }; vote?: { postId: string; voteId: string; token: string } }) => void }) {
  const shield = useShield("idea", "/pub/forms/shield");
  const [f, setF] = useState({ title: "", body: "", email: who.email, name: who.name });
  const [busy, setBusy] = useState(false);
  const ok = f.title.trim().length >= 3 && isEmail(f.email.trim());
  const send = async () => {
    setBusy(true);
    try {
      const r = await shield.send((s) => api.post<{ pending: boolean; post: PostRow | null; voteId?: string; token?: string }>(`/pub/forms/boards/${slug}/posts`, { ...f, email: f.email.trim(), shield: s }));
      onDone({ pending: r.pending, who: { email: f.email.trim(), name: f.name.trim() }, vote: r.post && r.voteId && r.token ? { postId: r.post.id, voteId: r.voteId, token: r.token } : undefined });
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Share an idea" description={moderate ? "The team reads every idea. It shows on the board once approved." : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void send()} loading={busy} disabled={!ok} data-testid="idea-send">Post idea</Button></>}>
      <div className="relative space-y-3">
        <Honeypot {...shield.honeypot} />
        <Field label="Title">{(fp) => <Input {...fp} value={f.title} maxLength={160} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="What would make this better?" data-testid="idea-title" />}</Field>
        <Field label="Details" hint="Optional.">{(fp) => <Textarea {...fp} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} className="min-h-24" />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email" hint="Never shown.">{(fp) => <Input {...fp} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} data-testid="idea-email" />}</Field>
          <Field label="Name" hint="Optional. Only your first name shows.">{(fp) => <Input {...fp} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        </div>
      </div>
    </Dialog>
  );
}

export function PublicBoardPage() {
  const { slug = "" } = useParams();
  const qc = useQueryClient();
  const [view, setView] = useState<"posts" | "roadmap">("posts");
  const [sort, setSort] = useState<"top" | "new">("top");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [mine, setMine] = useState(() => readMine(slug));
  const [asking, setAsking] = useState<PostRow | null>(null);
  const [posting, setPosting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const shield = useShield("vote", "/pub/forms/shield");
  const q = useQuery({ queryKey: ["pub-board", slug, sort, status, search], retry: false, queryFn: () => api.get<PublicBoard>(`/pub/forms/boards/${slug}?sort=${sort}&status=${status}&q=${encodeURIComponent(search)}`) });
  const road = useQuery({ queryKey: ["pub-road", slug], enabled: view === "roadmap", queryFn: () => api.get<{ roadmap: Record<string, PostRow[]> }>(`/pub/forms/boards/${slug}/roadmap`) });
  useEffect(() => { if (q.data) document.title = `${q.data.board.name} | Multies`; }, [q.data]);
  const save = (m: typeof mine) => { setMine(m); try { localStorage.setItem(store(slug), JSON.stringify(m)); } catch { /* private mode */ } };
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["pub-board", slug] }); void qc.invalidateQueries({ queryKey: ["pub-road", slug] }); };
  const vote = async (p: PostRow, who = { email: mine.email, name: mine.name }) => {
    const had = mine.votes[p.id];
    if (!had && !who.email) { setAsking(p); return; }
    setBusy(p.id);
    try {
      if (had) {
        // The token from the vote proves it is this person's; a vote already gone counts as taken back.
        const res = await fetch(`/api/pub/forms/boards/${slug}/posts/${p.id}/votes/${had.voteId}`, { method: "DELETE", headers: { "x-vote-token": had.token } });
        if (!res.ok && res.status !== 404) throw new Error("Couldn't take your vote back. Try again.");
        const { [p.id]: _gone, ...rest } = mine.votes; void _gone;
        save({ ...mine, votes: rest });
      } else {
        const r = await shield.send((s) => api.post<{ voteId: string | null; token: string | null; already: boolean }>(`/pub/forms/boards/${slug}/posts/${p.id}/votes`, { ...who, shield: s }));
        save({ ...mine, ...who, votes: r.voteId && r.token ? { ...mine.votes, [p.id]: { voteId: r.voteId, token: r.token } } : mine.votes });
        if (r.already) setNote("You had already voted for this one.");
      }
      refresh();
    } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  const b = q.data?.board;
  return (
    <main className="min-h-dvh bg-bg px-4 py-8 text-fg sm:py-12">
      <div className="mx-auto max-w-3xl space-y-5">
        {q.isPending ? <Skeleton className="h-64" /> : !b ? (
          <Card className="p-8 text-center"><h1 className="text-lg font-semibold">This board isn't available</h1><p className="mt-1 text-[13px] text-muted">It may be private or closed.</p></Card>
        ) : (
          <>
            <header>
              <p className="text-[12.5px] text-muted">{b.workspace}</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{b.name}</h1>
              {b.description && <p className="mt-2 whitespace-pre-wrap text-[14px] text-muted">{b.description}</p>}
            </header>
            <div className="flex flex-wrap items-center gap-2">
              <div role="tablist" aria-label="View" className="inline-flex rounded-lg border border-line p-0.5">
                {(["posts", "roadmap"] as const).map((v) => <button key={v} role="tab" type="button" aria-selected={view === v} onClick={() => setView(v)} className={`h-9 rounded-md px-3 text-[13px] font-medium max-sm:min-h-11 ${view === v ? "bg-fill text-fg" : "text-muted hover:text-fg"}`}>{v === "posts" ? "Ideas" : "Roadmap"}</button>)}
              </div>
              {b.allowIdeas && <Button className="ml-auto" onClick={() => setPosting(true)} data-testid="idea-new"><IconPlus className="h-4 w-4" />Share an idea</Button>}
            </div>
            {note && <p role="status" className="rounded-lg bg-fill px-3 py-2 text-[13px]">{note}</p>}
            <Honeypot {...shield.honeypot} />
            {view === "roadmap" ? (
              road.isPending ? <Skeleton className="h-48" /> : road.isError ? <Card className="p-6 text-center text-[13px]">Couldn't load the roadmap. <Button size="sm" variant="ghost" onClick={() => void road.refetch()}>Try again</Button></Card> : (
                <div className="grid gap-3 md:grid-cols-3" data-testid="pub-roadmap">
                  {ROADMAP_COLUMNS.map((col) => (
                    <section key={col} className="rounded-xl bg-fill/60 p-2.5" aria-label={STATUS_LABELS[col]}>
                      <h2 className="mb-2 flex justify-between px-1 text-[13px] font-semibold">{STATUS_LABELS[col]}<span className="font-normal text-muted">{road.data!.roadmap[col]?.length ?? 0}</span></h2>
                      <div className="space-y-2">
                        {(road.data!.roadmap[col] ?? []).map((p) => <Card key={p.id} className="p-3"><div className="break-words text-[14px] font-medium">{p.title}</div><div className="mt-1 text-[12px] text-muted">{p.votes} {p.votes === 1 ? "vote" : "votes"}</div></Card>)}
                        {!road.data!.roadmap[col]?.length && <p className="px-1 py-3 text-[12.5px] text-muted">Nothing here yet.</p>}
                      </div>
                    </section>
                  ))}
                </div>
              )
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as "top" | "new")} className="h-9 w-28 text-[13px]"><option value="top">Top</option><option value="new">New</option></Select>
                  <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 w-40 text-[13px]"><option value="">Any status</option>{PUBLIC_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}</Select>
                  <Input aria-label="Search ideas" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="col-span-2 h-9 min-w-0 flex-1 text-[13px]" />
                </div>
                {!q.data!.posts.length ? (
                  <Card><EmptyState icon={<IconMegaphone />} title={search || status ? "No ideas match" : "No ideas yet"} body={search || status ? "Try another search or status." : b.allowIdeas ? "Be the first to share one." : "Check back soon."} /></Card>
                ) : (
                  <Card className="divide-y divide-line">
                    {q.data!.posts.map((p) => (
                      <article key={p.id} className="flex gap-3 p-3.5" data-testid="pub-post">
                        <VoteButton votes={p.votes} voted={!!mine.votes[p.id]} busy={busy === p.id} label={p.title} onClick={() => void vote(p)} />
                        <div className="min-w-0 flex-1">
                          <h2 className="break-words text-[14.5px] font-medium">{p.title}</h2>
                          {p.body && <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-[13px] text-muted">{p.body}</p>}
                          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-subtle"><Badge tone={statusTone(p.status as PostStatus)}>{p.statusLabel}</Badge><span>{p.author}, {timeAgo(p.createdAt)}</span></div>
                        </div>
                      </article>
                    ))}
                  </Card>
                )}
              </>
            )}
          </>
        )}
      </div>
      {asking && <WhoDialog title={`Vote for "${asking.title}"`} initial={{ email: mine.email, name: mine.name }} onClose={() => setAsking(null)} onDone={(who) => { const p = asking; setAsking(null); void vote(p, who); }} />}
      {posting && b && <IdeaDialog slug={slug} moderate={b.moderate} who={{ email: mine.email, name: mine.name }} onClose={() => setPosting(false)} onDone={(r) => {
        setPosting(false);
        save({ ...mine, ...r.who, votes: r.vote ? { ...mine.votes, [r.vote.postId]: { voteId: r.vote.voteId, token: r.vote.token } } : mine.votes });
        setNote(r.pending ? "Thanks. Your idea shows here once the team approves it." : "Thanks. Your idea is up.");
        refresh();
      }} />}
    </main>
  );
}

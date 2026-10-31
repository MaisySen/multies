/**
 * R117: Planner v2. Week, month and list views of every post (drafts and posts waiting for approval included), weekly
 * time slots shown as dashed free slots (click to fill), drag a post that has not gone out to another day or slot
 * (with Undo, and a Move dialog for the keyboard), filters by account, campaign and status. Phones get a day list.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Input, Select } from "@/web/components/ui/input";
import { Dialog } from "@/web/components/ui/dialog";
import { IconCalendarDays, IconChevronRight, IconClock, IconMove, IconPlus, IconRefresh, IconTrash, IconBack } from "@/web/components/ui/icon";
import type { SocialPostView } from "@/shared/integrations";
import { freeSlots, networkLabel, slotTimes, type SlotRule, type SlotView } from "@/shared/social-p2";
import { POST_STATUS, postsKey, useSocialPosts, whenText } from "./apps-social";
import { monthGrid } from "./social";

export const slotsKey = ["social", "slots"] as const;
export function useSlots() {
  return useQuery({ queryKey: slotsKey, queryFn: () => api.get<{ slots: SlotView[] }>("/social/slots").then((r) => r.slots), staleTime: 60_000 });
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const timeText = (d: Date | string) => new Date(d).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const TONE_DOT: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", brand: "bg-brand", neutral: "bg-subtle" };
const MOVABLE = new Set(["scheduled", "draft", "changes", "review"]);
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const dayName = (wd: number, style: "short" | "long" = "short") => new Date(2026, 10, 1 + ((wd + 7) % 7)).toLocaleDateString(undefined, { weekday: style });

function weekStart(d: Date) { const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); return s; }
function addDays(d: Date, n: number) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
/** The same clock time on another day (a drop on a day keeps the post's time). */
export function onDay(post: Date, day: Date) { return new Date(day.getFullYear(), day.getMonth(), day.getDate(), post.getHours(), post.getMinutes()); }

type Filters = { account: string; campaign: string; status: string };
function matches(p: SocialPostView, f: Filters) {
  if (p.status === "canceled") return false;
  if (f.account && !p.targets.some((t) => t.accountId === f.account)) return false;
  if (f.campaign && (p.campaign ?? "") !== f.campaign) return false;
  if (f.status === "scheduled" && !(p.status === "scheduled" || p.status === "sending")) return false;
  if (f.status === "sent" && !(p.status === "done" || p.status === "partial")) return false;
  if (f.status === "failed" && !(p.status === "failed" || p.status === "partial")) return false;
  if (f.status === "drafts" && !["draft", "changes", "rejected", "review"].includes(p.status)) return false;
  return true;
}

function useMove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, runAt }: { id: string; runAt: string; from: string; quiet?: boolean }) => api.post<{ post: SocialPostView }>(`/social/posts/${id}/move`, { runAt }),
    onMutate: async ({ id, runAt }) => {
      await qc.cancelQueries({ queryKey: postsKey });
      const before = qc.getQueryData<SocialPostView[]>(postsKey);
      qc.setQueryData<SocialPostView[]>(postsKey, (list) => list?.map((p) => (p.id === id ? { ...p, runAt } : p)));
      return { before };
    },
    onError: (e, _v, c) => { if (c?.before) qc.setQueryData(postsKey, c.before); toast.error(errorMessage(e, "Couldn't move the post.")); },
    onSuccess: (_r, v, _c) => {
      if (v.quiet) { toast.success("Move undone"); return; }
      toast.success(`Moved to ${whenText(v.runAt)}`, { action: { label: "Undo", onClick: () => undo.current?.({ id: v.id, runAt: v.from, from: v.runAt, quiet: true }) } });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: postsKey }),
  });
}
const undo: { current: ((v: { id: string; runAt: string; from: string; quiet?: boolean }) => void) | null } = { current: null };

function PostChip({ p, draggable, onMove }: { p: SocialPostView; draggable: boolean; onMove?: (p: SocialPostView) => void }) {
  const st = POST_STATUS[p.status];
  return (
    <div className="group flex min-w-0 items-center gap-1" data-testid="planner-post" data-status={p.status} data-id={p.id}>
      <Link to={`/app/social/posts#post-${p.id}`} draggable={draggable} title={`${st.label}: ${p.text}`}
        onDragStart={(e) => { e.dataTransfer.setData("text/x-post", p.id); e.dataTransfer.effectAllowed = "move"; }}
        className={cn("flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-fill px-1.5 py-1 text-[12px] leading-tight transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 motion-reduce:transition-none",
          draggable && "cursor-grab active:cursor-grabbing")}>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[st.tone])} aria-hidden />
        <span className="shrink-0 tabular-nums text-muted">{timeText(p.runAt)}</span>
        <span className="min-w-0 truncate">{p.text || "(image only)"}</span>
        <span className="sr-only">, {st.label}{p.campaign ? `, ${p.campaign}` : ""}</span>
      </Link>
      {draggable && onMove && (
        <button type="button" onClick={() => onMove(p)} aria-label={`Move post: ${p.text.slice(0, 40)}`} data-testid="planner-move"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted opacity-0 transition-opacity duration-150 hover:bg-hover hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 group-hover:opacity-100 max-lg:opacity-100">
          <IconMove className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

function FreeSlot({ at, account }: { at: Date; account: string }) {
  const q = new URLSearchParams({ at: at.toISOString(), ...(account ? { account } : {}) });
  return (
    <Link to={`/app/social/new?${q}`} data-testid="free-slot" aria-label={`Free slot ${whenText(at.toISOString())}, write a post`}
      className="flex items-center gap-1.5 rounded-md border border-dashed border-line px-1.5 py-1 text-[12px] text-subtle transition-colors duration-150 hover:border-brand hover:bg-brand-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">
      <IconPlus className="h-3 w-3" aria-hidden /><span className="tabular-nums">{timeText(at)}</span><span>Free</span>
    </Link>
  );
}

function MoveDialog({ post, onClose, onMove, rules, posts }: { post: SocialPostView | null; onClose: () => void; onMove: (iso: string) => void; rules: SlotRule[]; posts: SocialPostView[] }) {
  const p2 = (n: number) => String(n).padStart(2, "0");
  const local = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const [at, setAt] = useState("");
  const next = post ? freeSlots(rules, posts.filter((x) => x.id !== post.id).map((x) => ({ runAt: x.runAt, accountIds: x.targets.map((t) => t.accountId), status: x.status })), post.targets.map((t) => t.accountId), new Date())[0] : undefined;
  const value = at || (post ? local(new Date(post.runAt)) : "");
  return (
    <Dialog open={!!post} onClose={() => { setAt(""); onClose(); }} title="Move post" description={post ? `Now ${whenText(post.runAt)}.` : undefined}
      footer={<><Button variant="ghost" onClick={() => { setAt(""); onClose(); }}>Cancel</Button><Button data-testid="move-save" onClick={() => { onMove(new Date(value).toISOString()); setAt(""); }}>Move</Button></>}>
      <div className="space-y-3">
        <label className="block text-[13px] font-medium" htmlFor="move-at">New time</label>
        <Input id="move-at" type="datetime-local" value={value} onChange={(e) => setAt(e.target.value)} className="h-9 w-auto text-sm" />
        {next && <Button variant="outline" size="sm" onClick={() => setAt(local(next))} data-testid="move-next-slot"><IconClock className="h-4 w-4" aria-hidden />Next free slot, {whenText(next.toISOString())}</Button>}
      </div>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- time slots dialog */

let lineSeq = 0;
interface SlotLine { key: string; account: string; minute: number; days: number[] }
function toLines(slots: SlotView[]): SlotLine[] {
  const m = new Map<string, SlotLine>();
  for (const s of slots) {
    const k = `${s.accountId ?? ""}|${s.minute}`;
    const cur = m.get(k) ?? { key: k, account: s.accountId ?? "", minute: s.minute, days: [] };
    cur.days.push(s.weekday);
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => a.minute - b.minute);
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function SlotsDialog({ open, onClose, accounts }: { open: boolean; onClose: () => void; accounts: { id: string; name: string }[] }) {
  const qc = useQueryClient();
  const slots = useSlots();
  const [lines, setLines] = useState<SlotLine[] | null>(null);
  const cur = lines ?? toLines(slots.data ?? []);
  const save = useMutation({
    mutationFn: () => api.put<{ slots: SlotView[] }>("/social/slots", {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      slots: cur.flatMap((l) => l.days.map((weekday) => ({ accountId: l.account || null, weekday, minute: l.minute }))),
    }),
    onSuccess: () => { toast.success("Time slots saved"); void qc.invalidateQueries({ queryKey: slotsKey }); void qc.invalidateQueries({ queryKey: ["social", "slots", "next"] }); setLines(null); onClose(); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't save the time slots.")),
  });
  const set = (k: string, patch: Partial<SlotLine>) => setLines(cur.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  return (
    <Dialog open={open} onClose={() => { setLines(null); onClose(); }} title="Weekly time slots" description="Times you like to post. Free ones show as dashed boxes in the planner, Schedule offers the next one, and evergreen posts fill them."
      footer={<><Button variant="ghost" onClick={() => { setLines(null); onClose(); }}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()} data-testid="slots-save">Save slots</Button></>}>
      {slots.isPending ? <Skeleton className="h-24 rounded-lg" /> : (
        <div className="space-y-3" data-testid="slots-dialog">
          {!cur.length && <p className="rounded-lg bg-fill px-3 py-4 text-center text-[13px] text-muted">No time slots yet. Add the times you usually post.</p>}
          {cur.map((l) => (
            <div key={l.key} className="space-y-2 rounded-lg border border-line p-3" data-testid="slot-line">
              <div className="flex flex-wrap items-center gap-2">
                <Input type="time" aria-label="Time" value={hhmm(l.minute)} onChange={(e) => { const [h, m] = e.target.value.split(":").map(Number); if (Number.isFinite(h) && Number.isFinite(m)) set(l.key, { minute: h! * 60 + m! }); }} className="h-9 w-auto text-sm" />
                <Select aria-label="Account" value={l.account} onChange={(e) => set(l.key, { account: e.target.value })} className="h-9 w-auto max-w-[14rem] text-sm">
                  <option value="">All accounts</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
                <Button variant="ghost" size="sm" className="ml-auto text-bad hover:text-bad" aria-label={`Remove the ${hhmm(l.minute)} slot`} onClick={() => setLines(cur.filter((x) => x.key !== l.key))}><IconTrash className="h-4 w-4" aria-hidden /></Button>
              </div>
              <div className="flex flex-wrap gap-1" role="group" aria-label={`Days for ${hhmm(l.minute)}`}>
                {WEEKDAYS.map((wd) => {
                  const on = l.days.includes(wd);
                  return (
                    <button key={wd} type="button" aria-pressed={on} onClick={() => set(l.key, { days: on ? l.days.filter((d) => d !== wd) : [...l.days, wd] })}
                      className={cn("min-h-9 min-w-11 rounded-md border px-2 text-[12.5px] font-medium", on ? "border-brand bg-brand-soft text-fg" : "border-line text-muted hover:bg-hover")}>
                      {dayName(wd)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <Button variant="outline" size="sm" data-testid="slot-add" onClick={() => setLines([...cur, { key: `new${++lineSeq}`, account: "", minute: 9 * 60, days: [1, 2, 3, 4, 5] }])}><IconPlus className="h-4 w-4" aria-hidden />Add a time</Button>
        </div>
      )}
    </Dialog>
  );
}

/* ---------------------------------------------------------------- planner */

type View = "week" | "month" | "list";

export function PlannerV2({ canManage, accounts }: { canManage: boolean; accounts: { id: string; name: string }[] }) {
  const posts = useSocialPosts();
  const slots = useSlots();
  const move = useMove();
  undo.current = (v) => move.mutate(v);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view: View = (["week", "month", "list"] as const).find((v) => v === params.get("view")) ?? "week";
  const setView = (v: View) => setParams((p) => { const n = new URLSearchParams(p); n.set("view", v); return n; }, { replace: true });
  const [slotsOpen, setSlotsOpen] = useState(params.get("slots") === "1");
  const [anchor, setAnchor] = useState(() => new Date());
  const [filters, setFilters] = useState<Filters>({ account: "", campaign: "", status: "" });
  const [moving, setMoving] = useState<SocialPostView | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const [phoneDay, setPhoneDay] = useState(() => dayKey(new Date()));
  const all = posts.data ?? [];
  const shown = useMemo(() => all.filter((p) => matches(p, filters)).sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt)), [all, filters]);
  const campaigns = useMemo(() => [...new Set(all.map((p) => p.campaign).filter((c): c is string => !!c))].sort(), [all]);
  const rules = (slots.data ?? []) as SlotRule[];
  const byDay = useMemo(() => { const m = new Map<string, SocialPostView[]>(); for (const p of shown) { const k = dayKey(new Date(p.runAt)); m.set(k, [...(m.get(k) ?? []), p]); } return m; }, [shown]);
  const busy = useMemo(() => all.map((p) => ({ runAt: p.runAt, accountIds: p.targets.map((t) => t.accountId), status: p.status })), [all]);
  const today = dayKey(new Date());
  const ws = weekStart(anchor);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const freeByDay = useMemo(() => {
    const m = new Map<string, Date[]>();
    if (!rules.length) return m;
    const from = new Date(Math.max(Date.now() + 10 * 60_000, ws.getTime()));
    for (const s of slotTimes(rules, from, 8)) {
      if (s.at.getTime() > addDays(ws, 7).getTime()) continue;
      if (filters.account && s.accountId && s.accountId !== filters.account) continue;
      const ids = s.accountId ? [s.accountId] : filters.account ? [filters.account] : [];
      const taken = busy.some((b) => ["scheduled", "sending", "done", "partial", "review"].includes(b.status) && Math.abs(new Date(b.runAt).getTime() - s.at.getTime()) < 5 * 60_000 && (!ids.length || b.accountIds.some((x) => ids.includes(x))));
      if (taken) continue;
      const k = dayKey(s.at);
      if (!(m.get(k) ?? []).some((d) => d.getTime() === s.at.getTime())) m.set(k, [...(m.get(k) ?? []), s.at]);
    }
    return m;
  }, [rules, busy, ws.getTime(), filters.account]); // eslint-disable-line react-hooks/exhaustive-deps

  const canMove = (p: SocialPostView) => MOVABLE.has(p.status) && canManage;
  const drop = (e: React.DragEvent, day: Date, exact?: Date) => {
    e.preventDefault(); setDropDay(null);
    const id = e.dataTransfer.getData("text/x-post");
    const p = all.find((x) => x.id === id);
    if (!p || !canMove(p)) return;
    const to = exact ?? onDay(new Date(p.runAt), day);
    if (to.getTime() < Date.now() + 60_000) { toast.error("That time has passed. Pick a later day."); return; }
    if (to.getTime() === new Date(p.runAt).getTime()) return;
    move.mutate({ id: p.id, runAt: to.toISOString(), from: p.runAt });
  };
  const dropProps = (day: Date) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes("text/x-post")) { e.preventDefault(); setDropDay(dayKey(day)); } },
    onDragLeave: () => setDropDay((d) => (d === dayKey(day) ? null : d)),
    onDrop: (e: React.DragEvent) => drop(e, day),
  });

  const label = view === "month" ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : `${ws.toLocaleDateString(undefined, { day: "numeric", month: "short" })} to ${addDays(ws, 6).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
  const step = (n: number) => setAnchor((a) => (view === "month" ? new Date(a.getFullYear(), a.getMonth() + n, 1) : addDays(a, 7 * n)));
  const tab = "inline-flex min-h-9 items-center rounded-md px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-sm:min-h-11";

  const dayCell = (d: Date, compact: boolean) => {
    const k = dayKey(d);
    const items = byDay.get(k) ?? [];
    const free = freeByDay.get(k) ?? [];
    const merged = [...items.map((p) => ({ t: new Date(p.runAt).getTime(), p })), ...free.map((f) => ({ t: f.getTime(), f }))].sort((a, b) => a.t - b.t);
    return merged.map((x) => ("p" in x && x.p ? <PostChip key={x.p.id} p={x.p} draggable={canMove(x.p)} onMove={setMoving} /> : <FreeSlot key={`f${x.t}`} at={(x as { f: Date }).f} account={filters.account} />)).slice(0, compact ? 4 : 50);
  };

  return (
    <div data-testid="planner-v2">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-lg bg-fill p-1" role="group" aria-label="View" data-testid="planner-views">
          {(["week", "month", "list"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={cn(tab, view === v ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")} data-testid={`view-${v}`}>
              {v === "week" ? "Week" : v === "month" ? "Month" : "List"}
            </button>
          ))}
        </div>
        {view !== "list" && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" aria-label={view === "month" ? "Previous month" : "Previous week"} onClick={() => step(-1)}><IconBack className="h-4 w-4" aria-hidden /></Button>
            <Button variant="outline" size="sm" onClick={() => setAnchor(new Date())}>Today</Button>
            <Button variant="ghost" size="sm" aria-label={view === "month" ? "Next month" : "Next week"} onClick={() => step(1)}><IconChevronRight className="h-4 w-4" aria-hidden /></Button>
            <h2 className="ml-1 text-[15px] font-semibold" aria-live="polite" data-testid="planner-range">{label}</h2>
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2" data-testid="planner-filters">
          <Select aria-label="Account" value={filters.account} onChange={(e) => setFilters({ ...filters, account: e.target.value })} className="h-9 w-auto max-w-[12rem] text-sm">
            <option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          {campaigns.length > 0 && (
            <Select aria-label="Campaign" value={filters.campaign} onChange={(e) => setFilters({ ...filters, campaign: e.target.value })} className="h-9 w-auto max-w-[12rem] text-sm" data-testid="filter-campaign">
              <option value="">All campaigns</option>{campaigns.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          )}
          <Select aria-label="Status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} className="h-9 w-auto text-sm">
            <option value="">Every status</option><option value="scheduled">Scheduled</option><option value="drafts">Drafts and waiting</option><option value="sent">Sent</option><option value="failed">Failed</option>
          </Select>
          {canManage && <Button variant="outline" size="sm" onClick={() => setSlotsOpen(true)} data-testid="open-slots"><IconClock className="h-4 w-4" aria-hidden />Time slots</Button>}
        </div>
      </div>

      {posts.isPending ? <Skeleton className="h-96 rounded-xl" />
        : posts.error ? (
          <Card className="p-5"><p className="text-sm text-bad" role="alert">{errorMessage(posts.error, "Couldn't load posts.")}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void posts.refetch()}><IconRefresh className="h-4 w-4" aria-hidden />Try again</Button></Card>
        ) : (<>
          {!rules.length && canManage && view !== "list" && (
            <p className="mb-3 rounded-lg bg-fill px-3 py-2.5 text-[13px] text-muted" data-testid="no-slots">Add weekly time slots and free ones show here as dashed boxes. <button type="button" className="font-medium text-fg underline underline-offset-2" onClick={() => setSlotsOpen(true)}>Set time slots</button></p>
          )}
          {view === "week" && (<>
            <div className="hidden gap-2 lg:grid lg:grid-cols-7" data-testid="week-grid">
              {weekDays.map((d) => (
                <section key={dayKey(d)} aria-label={d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} {...dropProps(d)} data-testid="week-day" data-day={dayKey(d)}
                  className={cn("min-h-[16rem] min-w-0 rounded-xl border border-line bg-surface p-2 transition-colors duration-150", dropDay === dayKey(d) && "border-brand bg-brand-soft/40")}>
                  <h3 className={cn("mb-2 flex items-baseline gap-1.5 px-1 text-[12.5px] font-medium", dayKey(d) === today ? "text-brand-hover" : "text-muted")}>
                    <span>{d.toLocaleDateString(undefined, { weekday: "short" })}</span><span className="text-[15px] font-semibold tabular-nums text-fg">{d.getDate()}</span>
                  </h3>
                  <div className="space-y-1.5">{dayCell(d, false)}</div>
                </section>
              ))}
            </div>
            <div className="lg:hidden" data-testid="day-list">
              <div className="-mx-1 mb-3 flex gap-1 overflow-x-auto px-1" role="tablist" aria-label="Day">
                {weekDays.map((d) => {
                  const k = dayKey(d); const n = (byDay.get(k) ?? []).length;
                  return (
                    <button key={k} type="button" role="tab" aria-selected={phoneDay === k} onClick={() => setPhoneDay(k)}
                      className={cn("flex min-h-14 min-w-12 flex-col items-center justify-center rounded-lg border px-2 text-[12px]", phoneDay === k ? "border-brand bg-brand-soft text-fg" : "border-line text-muted")}>
                      <span>{d.toLocaleDateString(undefined, { weekday: "short" })}</span><span className="text-[15px] font-semibold tabular-nums text-fg">{d.getDate()}</span>
                      <span className={cn("mt-0.5 h-1 w-1 rounded-full", n ? "bg-brand" : "bg-transparent")} aria-hidden />
                    </button>
                  );
                })}
              </div>
              {(() => { const d = weekDays.find((x) => dayKey(x) === phoneDay) ?? weekDays[0]!; const cells = dayCell(d, false); return cells.length ? <Card className="space-y-1.5 p-2">{cells}</Card> : <p className="rounded-lg bg-fill px-3 py-4 text-center text-[13px] text-muted">Nothing on {d.toLocaleDateString(undefined, { weekday: "long" })}. <Link to="/app/social/new" className="font-medium text-fg underline underline-offset-2">Write a post</Link></p>; })()}
            </div>
          </>)}
          {view === "month" && (() => {
            const cells = monthGrid(anchor.getFullYear(), anchor.getMonth());
            return (
              <div className="overflow-x-auto">
                <div className="grid min-w-[720px] grid-cols-7 gap-px overflow-hidden rounded-xl border border-line bg-line" data-testid="month-grid">
                  {cells.slice(0, 7).map((d) => <div key={`h${d.getDay()}`} className="bg-fill px-2 py-1.5 text-[12px] font-medium text-muted">{d.toLocaleDateString(undefined, { weekday: "short" })}</div>)}
                  {cells.map((d) => (
                    <div key={dayKey(d)} {...dropProps(d)} data-testid="month-day" className={cn("min-h-[6.5rem] min-w-0 bg-surface p-1.5", d.getMonth() !== anchor.getMonth() && "bg-fill/60", dropDay === dayKey(d) && "bg-brand-soft/50")}>
                      <p className={cn("mb-1 text-[12px] tabular-nums", dayKey(d) === today ? "font-semibold text-brand-hover" : "text-muted")}>{d.getDate()}</p>
                      <div className="space-y-1">{(byDay.get(dayKey(d)) ?? []).slice(0, 3).map((p) => <PostChip key={p.id} p={p} draggable={canMove(p)} onMove={setMoving} />)}
                        {(byDay.get(dayKey(d)) ?? []).length > 3 && <p className="px-1 text-[11.5px] text-muted">{(byDay.get(dayKey(d)) ?? []).length - 3} more</p>}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
          {view === "list" && (() => {
            const from = new Date(); from.setHours(0, 0, 0, 0);
            const upcoming = shown.filter((p) => Date.parse(p.runAt) >= from.getTime() || ["draft", "changes", "review"].includes(p.status));
            const days = [...new Set(upcoming.map((p) => dayKey(new Date(p.runAt))))];
            return upcoming.length ? (
              <ul className="space-y-4" data-testid="list-view">
                {days.map((k) => {
                  const ps = upcoming.filter((p) => dayKey(new Date(p.runAt)) === k);
                  return (
                    <li key={k}>
                      <h3 className={cn("mb-1.5 px-1 text-[13px] font-semibold", k === today ? "text-brand-hover" : "text-muted")}>{new Date(ps[0]!.runAt).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}</h3>
                      <Card className="divide-y divide-line">
                        {ps.map((p) => (
                          <div key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-[13px]">
                            <span className="w-16 shrink-0 tabular-nums text-muted">{timeText(p.runAt)}</span>
                            <span className="min-w-0 flex-1 truncate">{p.text || "(image only)"}</span>
                            <span className="text-[12px] text-muted">{[...new Set(p.targets.map((t) => networkLabel(t.app)))].join(", ")}</span>
                            <span className="text-[12px] font-medium">{POST_STATUS[p.status].label}</span>
                            {canMove(p) && <Button variant="ghost" size="sm" onClick={() => setMoving(p)} aria-label={`Move post: ${p.text.slice(0, 40)}`}><IconMove className="h-4 w-4" aria-hidden /></Button>}
                          </div>
                        ))}
                      </Card>
                    </li>
                  );
                })}
              </ul>
            ) : <Card><EmptyState icon={<IconCalendarDays />} title="Nothing coming up" body="Scheduled posts, drafts and posts waiting for approval show here by day." action={<Button onClick={() => navigate("/app/social/new")}><IconPlus className="h-4 w-4" aria-hidden />New post</Button>} /></Card>;
          })()}
        </>)}
      <MoveDialog post={moving} rules={rules} posts={all} onClose={() => setMoving(null)} onMove={(iso) => { if (moving) move.mutate({ id: moving.id, runAt: iso, from: moving.runAt }); setMoving(null); }} />
      <SlotsDialog open={slotsOpen} onClose={() => { setSlotsOpen(false); if (params.get("slots")) setParams((p) => { const n = new URLSearchParams(p); n.delete("slots"); return n; }, { replace: true }); }} accounts={accounts} />
    </div>
  );
}

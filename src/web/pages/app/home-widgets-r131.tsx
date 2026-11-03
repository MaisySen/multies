/**
 * R131 Home widgets (flag HOME_WIDGETS_R131) on Home, Overview (/app). Drag to arrange with mouse or keyboard,
 * sizes, show or hide, quick links, a workspace default an admin sets, and a reorder sheet on phones.
 * Every widget reads existing data through existing routes and has its own loading, empty and Retry state,
 * so one slow or failing widget never holds up Home. Widgets below the fold read when scrolled near.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatCount } from "@/web/lib/format-count";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { displayFirstName } from "@/shared/display-name";
import { builtinLayout, isSafeLinkUrl, MAX_LINKS, moveItem, normalizeLayout, WIDGET_INFO, WIDGET_IDS, WIDGET_SIZES, type HomeLayout, type HomeWidgetsView, type LayoutItem, type QuickLink, type WidgetId, type WidgetSize } from "@/shared/home-widgets-r131";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { dayPart } from "@/web/lib/format";
import { useMe } from "@/web/lib/queries";
import { useCounts } from "@/web/lib/counts";
import { useMyWork, type MyWorkItem } from "@/web/lib/search";
import { nextMeeting } from "@/web/lib/today";
import { PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { LoadError, LoadErrorInline } from "@/web/components/load-error-t1g";
import { IconArrowDown, IconArrowUp, IconBell, IconCalendar, IconChat, IconCheck, IconDashboard, IconExternalLink, IconEyeOff, IconGrip, IconInbox, IconLink, IconMail, IconMegaphone, IconPlus, IconSliders, IconTasks, IconTrash, IconWorkflow, IconClipboardList, IconGauge, IconTimer } from "@/web/components/ui/icon";
import { money } from "@/shared/invoices";
import { hoursText } from "@/shared/bill-time-td4";
import { ApiError } from "@/web/lib/api";

export const homeWidgetsKey = ["home-widgets"] as const;
const CACHE = "home-widgets-r131";

function cachedLayout(): HomeLayout | undefined {
  try { const raw = localStorage.getItem(CACHE); return raw ? normalizeLayout(JSON.parse(raw), WIDGET_IDS) : undefined; } catch { return undefined; }
}

export function useHomeWidgets() {
  return useQuery({
    queryKey: homeWidgetsKey,
    queryFn: async () => {
      const v = await api.get<HomeWidgetsView>("/home-widgets");
      try { localStorage.setItem(CACHE, JSON.stringify(v.layout)); } catch { /* private mode */ }
      return v;
    },
    staleTime: 60_000,
  });
}

function useIsPhone() {
  const q = "(max-width: 639px)";
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia?.(q).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return;
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return !!m;
}

/** Start a widget's read when it is on screen or near it; Home's first paint stays as fast as before. */
function useNear<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setNear(true); }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

const SPAN: Record<WidgetSize, string> = { small: "md:col-span-1 xl:col-span-2", medium: "md:col-span-1 xl:col-span-3", wide: "md:col-span-2 xl:col-span-6" };
const SIZE_LABEL: Record<WidgetSize, string> = { small: "Small", medium: "Medium", wide: "Wide" };
const ICON: Record<WidgetId, ReactNode> = {
  tasks: <IconTasks />, calendar: <IconCalendar />, inbox: <IconInbox />, links: <IconLink />, overview: <IconGauge />,
  social: <IconMegaphone />, feeds: <IconWorkflow />, dashboards: <IconDashboard />, billing: <IconTimer />,
};
const OPEN: Partial<Record<WidgetId, string>> = { tasks: "/app/my-work", calendar: "/app/my-work", inbox: "/app/mail", social: "/app/social/inbox", feeds: "/app/automations", dashboards: "/app/dashboards", billing: "/app/contacts/invoices?tab=time" };

/* ---------- widget bodies ---------- */

function Rows({ items, empty }: { items: MyWorkItem[]; empty: string }) {
  if (!items.length) return <Empty text={empty} />;
  return (
    <ul className="divide-y divide-line">
      {items.map((it) => (
        <li key={it.id}>
          <Link to={it.url} className="block px-4 py-2.5 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none max-sm:py-3">
            <span className="block truncate text-[13.5px] text-fg">{it.title}</span>
            {it.subtitle && <span className="block truncate text-xs text-subtle">{it.subtitle}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-4 py-6 text-center text-[13px] text-muted" data-testid="widget-empty">{text}</p>;
}

function Loading() {
  return <div className="space-y-2.5 px-4 py-4" data-testid="widget-loading"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div>;
}

function TasksWidget({ on }: { on: boolean }) {
  const { data, error, refetch, isPending } = useMyWork() as unknown as { data?: import("@/web/lib/search").MyWork; error: unknown; refetch: () => unknown; isPending: boolean };
  if (!on || (isPending && !data)) return <Loading />;
  if (error && !data) return <LoadError compact onRetry={refetch} />;
  const items = [...(data?.overdue ?? []).map((i) => ({ ...i, subtitle: i.subtitle ? `Overdue · ${i.subtitle}` : "Overdue" })), ...(data?.dueToday ?? [])].slice(0, 6);
  return <Rows items={items} empty="Nothing due today. Nice work." />;
}

function CalendarWidget({ on }: { on: boolean }) {
  const { data, error, refetch, isPending } = useMyWork() as unknown as { data?: import("@/web/lib/search").MyWork; error: unknown; refetch: () => unknown; isPending: boolean };
  if (!on || (isPending && !data)) return <Loading />;
  if (error && !data) return <LoadError compact onRetry={refetch} />;
  const meetings = data?.meetings ?? [];
  const next = nextMeeting(meetings);
  if (!meetings.length) return <Empty text="No meetings today." />;
  return (
    <div>
      {next && (
        <div className="hairline-b px-4 py-3">
          <p className="text-xs text-subtle">Next</p>
          <Link to={next.item.url} className="mt-0.5 block truncate text-[14px] font-medium text-fg hover:underline">{next.item.title}</Link>
          {next.item.subtitle && <p className="truncate text-xs text-subtle">{next.item.subtitle}</p>}
        </div>
      )}
      <Rows items={meetings.filter((m) => m.id !== next?.item.id).slice(0, 4)} empty="Nothing else today." />
    </div>
  );
}

function InboxWidget({ on }: { on: boolean }) {
  const q = useCounts(on);
  if (!on || (q.isPending && !q.data)) return <Loading />;
  if (q.error && !q.data) return <LoadError compact onRetry={q.refetch} />;
  const c = q.data!;
  const tiles: { label: string; n: number; to: string; icon: ReactNode }[] = [
    { label: "Unread mail", n: c.mail.inbox, to: "/app/mail", icon: <IconMail /> },
    { label: "Chat", n: c.chat.unread, to: "/app/chat", icon: <IconChat /> },
    { label: "Notifications", n: c.notifications.unread, to: "/app/notifications", icon: <IconBell /> },
    { label: "Triage", n: c.triage, to: "/app/triage", icon: <IconClipboardList /> },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 p-3">
      {tiles.map((t) => (
        <Link key={t.label} to={t.to} className="rounded-lg bg-fill px-3 py-2.5 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span className="flex items-center gap-1.5 text-xs text-muted [&_svg]:h-3.5 [&_svg]:w-3.5">{t.icon}{t.label}</span>
          <span className="mt-0.5 block text-[20px] font-semibold tabular-nums text-fg">{formatCount(t.n)}</span>
        </Link>
      ))}
    </div>
  );
}

type SocialItem = Pick<import("@/shared/social-p2b").InboxItemView, "id" | "text" | "authorName" | "app">;
function SocialWidget({ on }: { on: boolean }) {
  const q = useQuery({ queryKey: ["home-widgets", "social"], enabled: on, staleTime: 60_000, queryFn: () => api.get<{ items: SocialItem[] }>("/social/inbox?status=open&view=mine&limit=5") });
  if (!on || q.isPending) return <Loading />;
  if (q.error) return <LoadError compact onRetry={q.refetch} />;
  const items = (q.data?.items ?? []).slice(0, 5);
  if (!items.length) return <Empty text="No open comments or messages for you." />;
  return <Rows items={items.map((i) => ({ id: i.id, title: i.text || "Message", subtitle: [i.authorName, i.app].filter(Boolean).join(" · "), url: "/app/social/inbox", at: null }))} empty="" />;
}

interface Run { id: string; flowName: string | null; status: string; startedAt: string }
const RUN_STATUS: Record<string, string> = { done: "Done", succeeded: "Done", failed: "Failed", running: "Running", waiting: "Waiting", waiting_approval: "Needs approval", cancelled: "Stopped" };
function FeedsWidget({ on }: { on: boolean }) {
  const q = useQuery({ queryKey: ["home-widgets", "feeds"], enabled: on, staleTime: 60_000, queryFn: () => api.get<{ runs: Run[] }>("/flows/runs?limit=5") });
  if (!on || q.isPending) return <Loading />;
  if (q.error) return <LoadError compact onRetry={q.refetch} />;
  const runs = q.data?.runs ?? [];
  if (!runs.length) return <Empty text="No runs yet. Watch a page or a feed in Automations to see new items here." />;
  return <Rows items={runs.map((r) => ({ id: r.id, title: r.flowName || "Automation", subtitle: `${RUN_STATUS[r.status] ?? r.status} · ${new Date(r.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`, url: `/app/automations/runs/${encodeURIComponent(r.id)}`, at: r.startedAt }))} empty="" />;
}

/* TD4: hours still to bill per client, owners and admins only (the server offers this widget to them alone). */
interface BillGroup { key: string; name: string; clientId: string | null; projectId: string; projects: number; seconds: number; amountCents: number; currency: string; missingRate: boolean }
function BillingWidget({ on }: { on: boolean }) {
  const q = useQuery({ queryKey: ["home-widgets", "billing"], enabled: on, staleTime: 60_000, retry: (n, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && n < 2,
    queryFn: () => api.get<{ clients: BillGroup[]; totalSeconds: number; more: number }>("/bill-time/summary") });
  if (!on || q.isPending) return <Loading />;
  if (q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404)) return <Empty text="Only owners and admins can see time to bill." />;
  if (q.error) return <LoadError compact onRetry={q.refetch} />;
  const list = q.data?.clients ?? [];
  if (!list.length) return <Empty text="No time waiting to be billed." />;
  return (
    <div data-testid="bill-widget">
      <ul className="divide-y divide-line">
        {list.map((g) => (
          <li key={g.key}>
            <Link to={`/app/contacts/invoices?tab=time&project=${encodeURIComponent(g.projectId)}`} className="flex min-h-11 items-center gap-3 px-4 py-2.5 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-fg">{g.name}</span>
                <span className="block truncate text-xs text-subtle">{g.clientId ? (g.projects === 1 ? "1 project" : `${g.projects} projects`) : "No client set yet"}</span>
              </span>
              <span className="shrink-0 text-right tabular-nums">
                <span className="block text-[13.5px] font-medium text-fg">{g.missingRate && !g.amountCents ? "Set a rate" : money(g.amountCents, g.currency)}</span>
                <span className="block text-xs text-subtle">{hoursText(Math.round(g.seconds / 3.6))}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-4 py-2 text-xs text-subtle">{hoursText(Math.round((q.data?.totalSeconds ?? 0) / 3.6))} in the last 12 months{q.data?.more ? `, ${q.data.more} more clients` : ""}. Value before tax, before rounding.</p>
    </div>
  );
}

interface Dash { id: string; name: string; shared: boolean; widgetCount: number }
function DashboardsWidget({ on }: { on: boolean }) {
  const q = useQuery({ queryKey: ["home-widgets", "dashboards"], enabled: on, staleTime: 60_000, queryFn: () => api.get<{ dashboards: Dash[] }>("/dashboards") });
  if (!on || q.isPending) return <Loading />;
  if (q.error) return <LoadError compact onRetry={q.refetch} />;
  const list = (q.data?.dashboards ?? []).slice(0, 6);
  if (!list.length) return <Empty text="No dashboards yet. Make one in Tasks, Dashboards." />;
  return (
    <div className="grid grid-cols-2 gap-2 p-3">
      {list.map((d) => (
        <Link key={d.id} to={`/app/dashboards/${d.id}`} className="min-w-0 rounded-lg bg-fill px-3 py-2.5 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span className="block truncate text-[13.5px] font-medium text-fg">{d.name}</span>
          <span className="block text-xs text-subtle">{d.widgetCount === 1 ? "1 chart" : `${d.widgetCount} charts`}{d.shared ? " · Shared" : ""}</span>
        </Link>
      ))}
    </div>
  );
}

function LinksWidget({ links, onAdd, onRemove }: { links: QuickLink[]; onAdd: () => void; onRemove: (id: string) => void }) {
  return (
    <div className="p-3">
      {links.length ? (
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={l.id} className="group flex items-center gap-1">
              <a href={l.url} target="_blank" rel="noopener noreferrer" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-[13.5px] text-fg hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <IconExternalLink className="h-3.5 w-3.5 shrink-0 text-subtle" /><span className="truncate">{l.title}</span>
              </a>
              <button type="button" onClick={() => onRemove(l.id)} aria-label={`Remove ${l.title}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent max-sm:h-11 max-sm:w-11"><IconTrash className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      ) : <p className="px-2 py-3 text-center text-[13px] text-muted" data-testid="widget-empty">Add the links you open every day.</p>}
      {links.length < MAX_LINKS && <Button className="mt-2 w-full" size="sm" variant="secondary" onClick={onAdd} data-testid="links-add"><IconPlus className="h-4 w-4" />Add link</Button>}
    </div>
  );
}

/* ---------- the card ---------- */

function WidgetCard({ item, editing, index, count, overview, links, onMove, onSize, onHide, onAddLink, onRemoveLink }: {
  item: LayoutItem; editing: boolean; index: number; count: number; overview: ReactNode; links: QuickLink[];
  onMove: (by: -1 | 1) => void; onSize: (s: WidgetSize) => void; onHide: () => void; onAddLink: () => void; onRemoveLink: (id: string) => void;
}) {
  const s = useSortable({ id: item.id, disabled: !editing });
  const [nearRef, near] = useNear<HTMLDivElement>();
  const info = WIDGET_INFO[item.id];
  const style = { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  const body = (() => {
    switch (item.id) {
      case "tasks": return <TasksWidget on={near} />;
      case "calendar": return <CalendarWidget on={near} />;
      case "inbox": return <InboxWidget on={near} />;
      case "social": return <SocialWidget on={near} />;
      case "feeds": return <FeedsWidget on={near} />;
      case "dashboards": return <DashboardsWidget on={near} />;
      case "billing": return <BillingWidget on={near} />;
      case "links": return <LinksWidget links={links} onAdd={onAddLink} onRemove={onRemoveLink} />;
      case "overview": return <div className="p-4">{near ? overview : <Loading />}</div>;
    }
  })();
  const open = OPEN[item.id];
  return (
    <section
      ref={(el) => { s.setNodeRef(el); nearRef.current = el as HTMLDivElement | null; }}
      style={style}
      aria-labelledby={`hw-${item.id}`}
      data-testid={`widget-${item.id}`}
      className={cn("elev-1 col-span-1 min-w-0 overflow-hidden rounded-[var(--radius-r14)] bg-surface transition-shadow duration-150 motion-reduce:transition-none", SPAN[item.size], editing && "ring-1 ring-line-strong", s.isDragging && "z-10 shadow-lg ring-2 ring-accent")}
    >
      <header className="hairline-b flex min-h-12 items-center gap-2 px-4 py-2.5">
        {editing && (
          <button type="button" {...s.attributes} {...s.listeners} aria-label={`Drag ${info.title}`} aria-roledescription="sortable widget" className="-ml-1 grid h-8 w-8 cursor-grab touch-none place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing" data-testid={`drag-${item.id}`}>
            <IconGrip className="h-4 w-4" />
          </button>
        )}
        <span className="text-subtle [&_svg]:h-4 [&_svg]:w-4" aria-hidden="true">{ICON[item.id]}</span>
        <h2 id={`hw-${item.id}`} className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">{info.title}</h2>
        {!editing && open ? <Link to={open} className="rounded-md px-1.5 py-1 text-[12.5px] font-medium text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Open</Link> : null}
      </header>
      {editing ? (
        <div className="flex min-h-24 flex-col items-center justify-center gap-3 px-4 py-4 text-center" data-testid={`placeholder-${item.id}`}>
          <p className="text-[13px] text-muted">{info.blurb}</p>
          <div className="flex flex-wrap items-center justify-center gap-1">
            <button type="button" onClick={() => { onMove(-1); if (index - 1 === 0) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-testid="down-${item.id}"]`)?.focus()); }} disabled={index === 0} aria-label={`Move ${info.title} up`} className="grid h-9 w-9 place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid={`up-${item.id}`}><IconArrowUp className="h-4 w-4" /></button>
            <button type="button" onClick={() => { onMove(1); if (index + 1 === count - 1) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-testid="up-${item.id}"]`)?.focus()); }} disabled={index === count - 1} aria-label={`Move ${info.title} down`} className="grid h-9 w-9 place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid={`down-${item.id}`}><IconArrowDown className="h-4 w-4" /></button>
            <Select aria-label={`Size of ${info.title}`} value={item.size} onChange={(e) => onSize(e.target.value as WidgetSize)} className="h-8 w-auto py-0 text-[13px]" data-testid={`size-${item.id}`}>
              {WIDGET_SIZES.map((sz) => <option key={sz} value={sz}>{SIZE_LABEL[sz]}</option>)}
            </Select>
            <button type="button" onClick={onHide} aria-label={`Hide ${info.title}`} className="grid h-8 w-8 place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid={`hide-${item.id}`}><IconEyeOff className="h-4 w-4" /></button>
          </div>
        </div>
      ) : body}
    </section>
  );
}

/* ---------- dialogs ---------- */

function LinkDialog({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (l: QuickLink) => void }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setTitle(""); setUrl(""); setErr(null); } }, [open]);
  const save = () => {
    const t = title.trim();
    let u = url.trim();
    if (u && !/^[a-z][a-z0-9+.-]*:/i.test(u)) u = `https://${u}`;
    if (!t) return setErr("Give the link a name.");
    if (!isSafeLinkUrl(u)) return setErr("Use a web address that starts with http or https.");
    onSave({ id: `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: t.slice(0, 60), url: u });
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add a quick link" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} data-testid="link-save">Add link</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label="Name">{(p) => <Input {...p} value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="Team handbook" data-testid="link-title" />}</Field>
        <Field label="Web address" error={err ?? undefined}>{(p) => <Input {...p} value={url} maxLength={500} inputMode="url" onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" data-testid="link-url" />}</Field>
      </form>
    </Dialog>
  );
}

/** Phones: one row per widget with Move up, Move down and a Show switch; no drag needed. */
function ReorderSheet({ open, items, onClose, onDone }: { open: boolean; items: LayoutItem[]; onClose: () => void; onDone: (items: LayoutItem[]) => void }) {
  const [list, setList] = useState(items);
  const [say, setSay] = useState("");
  useEffect(() => { if (open) setList(items); }, [open, items]);
  const move = (id: WidgetId, by: -1 | 1) => {
    const next = moveItem(list, id, by);
    setList(next);
    setSay(`${WIDGET_INFO[id].title} moved to place ${next.findIndex((x) => x.id === id) + 1} of ${next.length}`);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Arrange Home" description="Move widgets up or down and choose which ones show." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => onDone(list)} data-testid="sheet-done">Done</Button></>}>
      <p className="sr-only" aria-live="polite">{say}</p>
      <ul className="divide-y divide-line" data-testid="reorder-sheet">
        {list.map((it, i) => (
          <li key={it.id} className="flex items-center gap-2 py-1.5" data-testid={`sheet-${it.id}`}>
            <span className="text-subtle [&_svg]:h-4 [&_svg]:w-4" aria-hidden="true">{ICON[it.id]}</span>
            <span className={cn("min-w-0 flex-1 truncate text-[14px]", it.hidden ? "text-muted" : "text-fg")}>{WIDGET_INFO[it.id].title}</span>
            <button type="button" aria-label={`Move ${WIDGET_INFO[it.id].title} up`} disabled={i === 0} onClick={() => move(it.id, -1)} className="grid h-11 w-11 place-items-center rounded-lg text-subtle hover:bg-hover disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid={`sheet-up-${it.id}`}><IconArrowUp className="h-4 w-4" /></button>
            <button type="button" aria-label={`Move ${WIDGET_INFO[it.id].title} down`} disabled={i === list.length - 1} onClick={() => move(it.id, 1)} className="grid h-11 w-11 place-items-center rounded-lg text-subtle hover:bg-hover disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid={`sheet-down-${it.id}`}><IconArrowDown className="h-4 w-4" /></button>
            <label className="flex h-11 items-center gap-2 pl-1 text-[13px] text-muted">
              <input type="checkbox" role="switch" className="h-5 w-5 accent-[var(--color-accent,currentColor)]" checked={!it.hidden} onChange={(e) => setList((l) => l.map((x) => (x.id === it.id ? { ...x, hidden: !e.target.checked } : x)))} aria-label={`Show ${WIDGET_INFO[it.id].title}`} data-testid={`sheet-show-${it.id}`} />
              <span aria-hidden="true">Show</span>
            </label>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/* ---------- the page ---------- */

export function HomeWidgetsPage({ overview }: { overview: ReactNode }) {
  const me = useMe();
  const first = displayFirstName(me.data?.user.name, me.data?.user.email);
  const qc = useQueryClient();
  const q = useHomeWidgets();
  const phone = useIsPhone();
  const [draft, setDraft] = useState<HomeLayout | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [say, setSay] = useState("");
  const fallback = useMemo(() => cachedLayout() ?? builtinLayout(), []);
  const saved = q.data?.layout ?? fallback;
  const layout = draft ?? saved;
  const editing = draft !== null;
  const visible = layout.items.filter((i) => !i.hidden);
  const hidden = layout.items.filter((i) => i.hidden);

  const apply = (v: HomeWidgetsView) => { qc.setQueryData(homeWidgetsKey, v); try { localStorage.setItem(CACHE, JSON.stringify(v.layout)); } catch { /* ignore */ } };
  const save = useMutation({ mutationFn: (l: HomeLayout) => api.put<HomeWidgetsView>("/home-widgets", l), onSuccess: (v) => { apply(v); setDraft(null); setNote("Home saved."); } , onError: () => setNote("Couldn't save. Try again.") });
  const reset = useMutation({ mutationFn: () => api.del<HomeWidgetsView>("/home-widgets"), onSuccess: (v) => { apply(v); setDraft(null); setNote("Home is back to the default."); }, onError: () => setNote("Couldn't reset. Try again.") });
  const setDefault = useMutation({ mutationFn: (l: HomeLayout) => api.put<HomeWidgetsView>("/home-widgets/default", l), onSuccess: (v) => { apply(v); setNote("Saved as the workspace default. People who have not arranged their own Home now see it."); }, onError: () => setNote("Couldn't save the default. Try again.") });
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); }, [note]);
  // POL1: Escape leaves Customize without saving, unless a menu, a dialog or a keyboard drag has it.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"]') || document.activeElement?.getAttribute("aria-pressed") === "true") return;
      setDraft(null); setSay("Customize closed. Nothing changed.");
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="customize-home"]')?.focus());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing]);
  // POL1: when the saved layout can't be read, say so and keep Customize closed so it can't save over a layout we never saw.
  const layoutFailed = !!q.error && !q.data;

  const edit = (fn: (l: HomeLayout) => HomeLayout) => setDraft((d) => fn(d ?? saved));
  const update = (id: WidgetId, patch: Partial<LayoutItem>) => edit((l) => ({ ...l, items: l.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const moveVisible = (id: WidgetId, by: -1 | 1) => edit((l) => {
    const vis = l.items.filter((i) => !i.hidden);
    const next = moveItem(vis, id, by);
    setSay(`${WIDGET_INFO[id].title} moved to place ${next.findIndex((x) => x.id === id) + 1} of ${next.length}`);
    return { ...l, items: [...next, ...l.items.filter((i) => i.hidden)] };
  });
  // Quick links save at once, outside Customize: adding a link should not need two steps.
  const saveLinks = (links: QuickLink[]) => {
    if (editing) edit((l) => ({ ...l, links }));
    else save.mutate({ ...saved, links });
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const title = (id: unknown) => WIDGET_INFO[id as WidgetId]?.title ?? "Widget";
  const pos = (id: unknown) => visible.findIndex((x) => x.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${title(active.id)}, place ${pos(active.id)} of ${visible.length}.`,
    onDragOver: ({ active, over }) => (over ? `${title(active.id)} is over place ${pos(over.id)} of ${visible.length}.` : `${title(active.id)} is no longer over a place.`),
    onDragEnd: ({ active, over }) => (over ? `${title(active.id)} dropped at place ${pos(over.id)} of ${visible.length}.` : `${title(active.id)} dropped.`),
    onDragCancel: ({ active }) => `Moving ${title(active.id)} was cancelled.`,
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    edit((l) => {
      const vis = l.items.filter((i) => !i.hidden);
      const from = vis.findIndex((x) => x.id === e.active.id);
      const to = vis.findIndex((x) => x.id === e.over!.id);
      return { ...l, items: [...arrayMove(vis, from, to), ...l.items.filter((i) => i.hidden)] };
    });
  };

  const actions = editing ? (
    <div className="flex flex-wrap items-center gap-2">
      {hidden.length > 0 && (
        <Menu label="Add widget" trigger={<button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-fg hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="add-widget"><IconPlus className="h-4 w-4" />Add widget</button>}>
          {hidden.map((h) => <MenuItem key={h.id} icon={ICON[h.id]} hint={WIDGET_INFO[h.id].blurb} onSelect={() => update(h.id, { hidden: false })}>{WIDGET_INFO[h.id].title}</MenuItem>)}
        </Menu>
      )}
      <Button variant="ghost" size="sm" onClick={() => reset.mutate()} loading={reset.isPending} data-testid="reset-home">Reset to default</Button>
      {q.data?.canSetDefault && <Button variant="secondary" size="sm" onClick={() => setDefault.mutate(layout)} loading={setDefault.isPending} data-testid="set-default">Save as workspace default</Button>}
      <Button variant="secondary" size="sm" onClick={() => setDraft(null)} data-testid="cancel-home">Cancel</Button>
      <Button size="sm" onClick={() => save.mutate(layout)} loading={save.isPending} data-testid="done-home"><IconCheck className="h-4 w-4" />Done</Button>
    </div>
  ) : (
    <Button variant="secondary" size="sm" disabled={layoutFailed} onClick={() => (phone ? setSheetOpen(true) : setDraft(saved))} data-testid="customize-home"><IconSliders className="h-4 w-4" />Customize</Button>
  );

  return (
    <>
      <PageHeader title="Overview" description={editing ? "Drag widgets to arrange them, or use the arrows. Space picks up a widget and the arrow keys move it." : `Good ${dayPart()}${first ? `, ${first}` : ""}. Here's your day at a glance.`} actions={actions} />
      <p className="sr-only" aria-live="polite">{say}</p>
      {layoutFailed && <LoadErrorInline onRetry={() => q.refetch()} className="mb-4 rounded-lg bg-fill px-3 py-2" />}
      {note && <div role="status" className="mb-4 rounded-lg bg-fill px-3 py-2 text-[13px] text-fg" data-testid="home-note">{note}</div>}
      {visible.length === 0 ? (
        <div className="rounded-[var(--radius-r14)] border border-dashed border-line-strong px-6 py-12 text-center" data-testid="home-empty">
          <p className="text-[15px] font-semibold text-fg">Your Home is empty</p>
          <p className="mt-1 text-[13px] text-muted">Add widgets to see your tasks, meetings and inbox here.</p>
          <Button className="mt-4" size="sm" onClick={() => (phone ? setSheetOpen(true) : setDraft(saved))}><IconPlus className="h-4 w-4" />Add widgets</Button>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements, screenReaderInstructions: { draggable: "To pick up a widget, press space or enter. Use the arrow keys to move it. Press space or enter again to drop it, or escape to cancel." } }}>
          <SortableContext items={visible.map((v) => v.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6" data-testid="widget-grid">
              {visible.map((it, i) => (
                <WidgetCard key={it.id} item={it} index={i} count={visible.length} editing={editing} overview={overview} links={layout.links}
                  onMove={(by) => moveVisible(it.id, by)} onSize={(sz) => update(it.id, { size: sz })} onHide={() => update(it.id, { hidden: true })}
                  onAddLink={() => setLinkOpen(true)} onRemoveLink={(id) => saveLinks(layout.links.filter((l) => l.id !== id))} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      <LinkDialog open={linkOpen} onClose={() => setLinkOpen(false)} onSave={(l) => { setLinkOpen(false); saveLinks([...layout.links, l].slice(0, MAX_LINKS)); }} />
      <ReorderSheet open={sheetOpen} items={saved.items} onClose={() => setSheetOpen(false)} onDone={(items) => { setSheetOpen(false); save.mutate({ ...saved, items }); }} />
    </>
  );
}

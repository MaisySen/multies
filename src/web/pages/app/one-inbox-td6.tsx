/**
 * TD6 One inbox (flag INBOX_TD6): notifications, mail and assistant replies in one list, sorted Important and Noise by
 * rules (src/shared/inbox-td6.ts). Done, snooze, read and unread, bulk select, move with a remembered choice, filters by
 * source and keys j k o e s u x m and ?. Every action is optimistic and rolls back on an error. Works fully with AI off.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconArrowRightLeft, IconCheck, IconCheckCircle, IconClock, IconInbox, IconKeyboard, IconMail, IconRead, IconTrash, IconWifiOff } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { isTypingTarget } from "@/web/lib/shortcuts";
import { backLabel, dayLabel, pickedDateIso, SNOOZE_LABELS, type SnoozePreset } from "@/web/lib/triage";
import { DateInput } from "@/web/components/ui/input";
import { Button } from "@/web/components/ui/button";
import { Card, EmptyState, PageHeader } from "@/web/components/ui/misc";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { CaughtUpArt } from "@/web/components/illustrations";
import { KindTile } from "@/web/components/premium4-r39";
import { LoadErrorInline } from "@/web/components/load-error-t1g";
import { useConfig } from "@/web/lib/queries";
import { INBOX_KEYS, INBOX_SOURCE_LABELS, INBOX_SOURCES, inboxKeyAction, type InboxKind, type InboxLane, type InboxSource, type InboxView } from "@/shared/inbox-td6";

export interface OneItem {
  kind: InboxKind; id: string; source: InboxSource; lane: InboxLane; reason: string; remembered: boolean;
  title: string; who: string | null; at: string; read: boolean; view: InboxView; snoozedUntil: string | null; link: string;
}
interface OnePage {
  items: OneItem[]; counts: { important: number; noise: number; importantUnread: number; noiseUnread: number };
  sources: Record<InboxSource, number>; lane: InboxLane; view: InboxView; source: InboxSource | "all";
}
type Rule = { key: string; label: string; lane: InboxLane };
type SnoozeBody = { preset: SnoozePreset } | { until: string };

const VIEWS: { v: InboxView; label: string }[] = [{ v: "inbox", label: "Inbox" }, { v: "later", label: "Later" }, { v: "done", label: "Done" }];
const TILE_KIND: Record<InboxSource, string> = { mail: "email", chat: "chat", mention: "mention", task: "assignment", assistant: "approval", other: "status" };
const keyOf = (i: { kind: string; id: string }) => `${i.kind}:${i.id}`;

function useOnline() {
  const [on, setOn] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return on;
}

function groups(items: OneItem[], view: InboxView) {
  const out: { label: string; items: OneItem[] }[] = [];
  for (const it of items) {
    const label = view === "later" && it.snoozedUntil ? backLabel(it.snoozedUntil) : dayLabel(it.at);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(it); else out.push({ label, items: [it] });
  }
  return out;
}

export function OneInboxPage() {
  const config = useConfig();
  if (config.isPending) return <Card className="p-0"><SkeletonRows rows={6} label="Loading" /></Card>;
  if (!config.data?.inboxTd6) return <EmptyState icon={<IconInbox />} title="Page not found" body="This page is not available in this workspace." />;
  return <OneInbox />;
}

function OneInbox() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const online = useOnline();
  const [lane, setLane] = useState<InboxLane>("important");
  const [view, setView] = useState<InboxView>("inbox");
  const [source, setSource] = useState<InboxSource | "all">("all");
  const [focus, setFocus] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const key = useMemo(() => ["one-inbox", "list", lane, view, source] as const, [lane, view, source]);
  const q = useQuery({ queryKey: key, retry: 1, queryFn: () => api.get<OnePage>(`/one-inbox?lane=${lane}&view=${view}${source !== "all" ? `&source=${source}` : ""}`) });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const ids = useMemo(() => items.map(keyOf), [items]);
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ["one-inbox"] }), [qc]);
  useEffect(() => { setPicked(new Set()); setFocus(null); setSnoozeFor(null); }, [lane, view, source]);

  /** Optimistic change of the loaded page, rolled back when the server says no. */
  const optimistic = useCallback(async (change: (p: OnePage) => OnePage, call: () => Promise<unknown>) => {
    const before = qc.getQueryData<OnePage>(key);
    if (before) qc.setQueryData<OnePage>(key, change(before));
    try { await call(); void refresh(); return true; } catch (e) { if (before) qc.setQueryData(key, before); showError(e as Error); return false; }
  }, [qc, key, refresh]);
  const without = (gone: Set<string>) => (p: OnePage): OnePage => ({ ...p, items: p.items.filter((i) => !gone.has(keyOf(i))) });
  const refs = (list: OneItem[]) => list.map((i) => ({ kind: i.kind, id: i.id }));

  const moveFocusPast = useCallback((gone: Set<string>) => {
    const rest = ids.filter((x) => !gone.has(x));
    const at = focus ? ids.indexOf(focus) : -1;
    const next = ids.slice(at + 1).find((x) => !gone.has(x)) ?? rest[rest.length - 1] ?? null;
    setFocus(next);
  }, [ids, focus]);

  const done = useCallback(async (list: OneItem[]) => {
    if (!list.length) return;
    const gone = new Set(list.map(keyOf));
    moveFocusPast(gone);
    const ok = await optimistic(without(gone), () => api.post("/one-inbox/act", { action: "done", items: refs(list) }));
    if (ok) {
      setPicked(new Set());
      toast.success(list.length === 1 ? "Marked done" : `${list.length} marked done`, { id: "one-inbox-undo", action: { label: "Undo", onClick: () => void api.post("/one-inbox/act", { action: "undone", items: refs(list) }).then(refresh, (e: Error) => showError(e)) } });
    }
  }, [optimistic, refresh, moveFocusPast]);

  const snooze = useCallback(async (list: OneItem[], body: SnoozeBody) => {
    setSnoozeFor(null);
    if (!list.length) return;
    const gone = new Set(list.map(keyOf));
    moveFocusPast(gone);
    const ok = await optimistic(view === "later" ? (p) => p : without(gone), () => api.post("/one-inbox/act", { action: "snooze", items: refs(list), ...body }));
    if (ok) { setPicked(new Set()); toast.success(list.length === 1 ? "Snoozed" : `${list.length} snoozed`, { id: "one-inbox-undo", action: { label: "Undo", onClick: () => void api.post("/one-inbox/act", { action: "undone", items: refs(list) }).then(refresh, (e: Error) => showError(e)) } }); }
  }, [optimistic, view, refresh, moveFocusPast]);

  const restore = useCallback(async (it: OneItem) => {
    const gone = new Set([keyOf(it)]);
    moveFocusPast(gone);
    await optimistic(without(gone), () => api.post("/one-inbox/act", { action: "undone", items: refs([it]) }));
  }, [optimistic, moveFocusPast]);

  const setRead = useCallback(async (list: OneItem[], read: boolean) => {
    if (!list.length) return;
    const ks = new Set(list.map(keyOf));
    await optimistic((p) => ({ ...p, items: p.items.map((i) => (ks.has(keyOf(i)) ? { ...i, read } : i)) }), () => api.post("/one-inbox/act", { action: read ? "read" : "unread", items: refs(list) }));
  }, [optimistic]);

  const move = useCallback(async (it: OneItem) => {
    const to: InboxLane = it.lane === "important" ? "noise" : "important";
    const gone = new Set([keyOf(it)]);
    moveFocusPast(gone);
    let saved: { key: string; label: string } | null = null;
    const ok = await optimistic(without(gone), async () => { saved = await api.post<{ key: string; label: string }>("/one-inbox/move", { kind: it.kind, id: it.id, lane: to }); });
    if (ok && saved) {
      const s: { key: string; label: string } = saved;
      toast.success(`Moved to ${to === "important" ? "Important" : "Noise"}. More from ${s.label.toLowerCase().startsWith("a ") ? "this source" : s.label} goes there too.`,
        { id: "one-inbox-undo", action: { label: "Undo", onClick: () => void api.del("/one-inbox/rules", { key: s.key }).then(refresh, (e: Error) => showError(e)) } });
    }
  }, [optimistic, refresh, moveFocusPast]);

  const open = useCallback((it: OneItem) => {
    if (!it.read) void api.post("/one-inbox/act", { action: "read", items: refs([it]) }).then(refresh, () => undefined);
    nav(it.link);
  }, [nav, refresh]);

  const focused = items.find((i) => keyOf(i) === focus) ?? null;
  const selected = items.filter((i) => picked.has(keyOf(i)));
  const target = selected.length ? selected : focused ? [focused] : [];
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const handler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  handler.current = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target) || snoozeFor) return;
    if (e.key === "Escape") { if (showKeys) setShowKeys(false); else if (picked.size) setPicked(new Set()); return; }
    const a = inboxKeyAction(e);
    if (!a) return;
    const at = focus ? ids.indexOf(focus) : -1;
    e.preventDefault();
    if (a === "next") setFocus(ids[Math.min(at + 1, ids.length - 1)] ?? null);
    else if (a === "prev") setFocus(ids[Math.max(at - 1, 0)] ?? null);
    else if (a === "open" && focused) open(focused);
    else if (a === "done" && view !== "done") void done(target);
    else if (a === "snooze" && view !== "done") void snooze(target, { preset: "tomorrow" });
    else if (a === "toggle-read" && target.length) void setRead(target, !target.every((i) => i.read));
    else if (a === "select" && focus) toggle(focus);
    else if (a === "move" && focused) void move(focused);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => handler.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  useEffect(() => { if (focus) document.getElementById(`one-${focus.replace(":", "-")}`)?.scrollIntoView({ block: "nearest" }); }, [focus]);

  const c = q.data?.counts;
  const grouped = groups(items, view);
  return (
    <div>
      <PageHeader title="One inbox" description="Mail, chat, mentions, tasks and assistant replies in one place. Important first; the rest waits in Noise."
        actions={<div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setShowRules((v) => !v)} aria-expanded={showRules}>Saved choices</Button>
          <Button size="sm" variant="secondary" onClick={() => setShowKeys((v) => !v)} aria-expanded={showKeys}><IconKeyboard className="h-4 w-4" />Keys</Button>
        </div>} />
      {!online && <p role="status" data-testid="one-inbox-offline" className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-fill px-3 py-2 text-[13px] text-muted"><IconWifiOff className="h-4 w-4" />You are offline. This is the last list we loaded; changes wait until you are back.</p>}
      {showKeys && <KeysCard onClose={() => setShowKeys(false)} />}
      {showRules && <RulesCard />}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg bg-fill p-0.5" role="tablist" aria-label="Important or Noise">
          {(["important", "noise"] as InboxLane[]).map((l) => (
            <button key={l} role="tab" aria-selected={lane === l} data-testid={`one-lane-${l}`} onClick={() => setLane(l)}
              className={cn("rounded-md px-3.5 py-1.5 text-[13px] transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11",
                lane === l ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>
              {l === "important" ? "Important" : "Noise"}
              <span className="ml-1.5 tabular-nums text-subtle" data-testid={`one-lane-count-${l}`}>{c ? (l === "important" ? c.importantUnread : c.noiseUnread) || "" : ""}</span>
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg bg-fill p-0.5" role="tablist" aria-label="Inbox, Later or Done">
          {VIEWS.map(({ v, label }) => (
            <button key={v} role="tab" aria-selected={view === v} data-testid={`one-view-${v}`} onClick={() => setView(v)}
              className={cn("rounded-md px-3 py-1.5 text-[13px] transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11",
                view === v ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>{label}</button>
          ))}
        </div>
      </div>
      <div className="-mx-4 mb-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&>*]:shrink-0" role="group" aria-label="Filter by source">
        {(["all", ...INBOX_SOURCES] as (InboxSource | "all")[]).map((s) => (
          <button key={s} onClick={() => setSource(s)} aria-pressed={source === s} data-testid={`one-source-${s}`}
            className={cn("rounded-full border px-3 py-1 text-[12.5px] tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11 max-sm:px-3.5", source === s ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-line-strong hover:text-fg")}>
            {INBOX_SOURCE_LABELS[s]}{s !== "all" && q.data?.sources?.[s] ? ` ${q.data.sources[s]}` : ""}
          </button>
        ))}
      </div>
      {selected.length > 0 && (
        <div role="toolbar" aria-label="Selected items" data-testid="one-bulk" className="sticky top-0 z-[2] mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-2 text-[13px] shadow-card">
          <span className="font-medium tabular-nums">{selected.length} selected</span>
          {view !== "done" && <Button size="sm" variant="secondary" onClick={() => void done(selected)}><IconCheck className="h-4 w-4" />Done</Button>}
          {view !== "done" && <Button size="sm" variant="secondary" onClick={() => void snooze(selected, { preset: "tomorrow" })}><IconClock className="h-4 w-4" />Snooze until tomorrow</Button>}
          <Button size="sm" variant="secondary" onClick={() => void setRead(selected, true)}><IconRead className="h-4 w-4" />Mark read</Button>
          <Button size="sm" variant="secondary" onClick={() => void setRead(selected, false)}><IconMail className="h-4 w-4" />Mark unread</Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
        </div>
      )}
      {q.isPending ? <Card className="p-0"><SkeletonRows rows={6} label="Loading your inbox" /></Card>
        : q.isError && !q.data ? <Card className="p-4" data-testid="one-inbox-error"><LoadErrorInline onRetry={() => q.refetch()} /></Card>
        : !items.length ? (
          <EmptyState icon={view === "later" ? <IconClock /> : <IconCheckCircle />} art={<CaughtUpArt />}
            title={view === "inbox" ? (lane === "important" ? "You are all caught up" : "No noise right now") : view === "later" ? "Nothing snoozed" : "Nothing done yet"}
            body={view === "inbox" ? (lane === "important" ? "Mentions, work for you, mail from people you know and assistant replies show here." : "Newsletters, automated mail and updates land here, out of your way.") : view === "later" ? "Press S on an item to snooze it until tomorrow. It comes back unread." : "Press E on an item to mark it done."}
            action={view !== "inbox" ? <Button size="sm" variant="secondary" onClick={() => setView("inbox")}>Back to inbox</Button> : lane === "important" ? <Button size="sm" variant="secondary" onClick={() => setLane("noise")}>Look at Noise</Button> : undefined} />
        ) : (
          <Card className="p-0">
            <div data-testid="one-inbox-list" role="region" aria-label={`${lane === "important" ? "Important" : "Noise"} items`}>
              {grouped.map((g) => (
                <section key={g.label} aria-label={g.label}>
                  <h2 className="sticky top-0 z-[1] border-b border-line bg-elevated/90 px-4 py-1.5 text-[11.5px] font-medium uppercase tracking-wide text-subtle backdrop-blur">{g.label}</h2>
                  <ul>
                    {g.items.map((it) => {
                      const k = keyOf(it);
                      return (
                        <li key={k} id={`one-${k.replace(":", "-")}`} data-testid="one-row" data-kind={it.kind} data-id={it.id} aria-current={focus === k ? "true" : undefined} onMouseEnter={() => setFocus(k)}
                          className={cn("group relative flex flex-wrap items-start gap-3 border-b border-line py-3 pl-2.5 pr-4 last:border-0 sm:flex-nowrap transition-colors duration-150 motion-reduce:transition-none", focus === k && "bg-fill")}>
                          <input type="checkbox" aria-label={`Select ${it.title}`} checked={picked.has(k)} onChange={() => toggle(k)} className="mt-3 h-4 w-4 shrink-0 accent-brand max-sm:h-5 max-sm:w-5" />
                          <span className={cn("mt-4 h-2 w-2 shrink-0 rounded-full", it.read ? "bg-transparent" : "bg-brand")} aria-hidden />
                          <KindTile kind={TILE_KIND[it.source]} actor={it.who} />
                          <button onClick={() => open(it)} className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                            <span className={cn("block truncate text-[14px] leading-snug", !it.read && "font-semibold")}>{it.title}</span>
                            <span className="text-[12px] text-subtle">
                              {it.who ? `${it.who} · ` : ""}{INBOX_SOURCE_LABELS[it.source]} · {it.reason} · {timeAgo(it.at)}
                              {it.snoozedUntil ? ` · back ${timeAgo(it.snoozedUntil).replace(/ ago$/, "")}` : ""}{it.read ? "" : " · unread"}
                            </span>
                          </button>
                          <div className={cn("flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none max-sm:-mt-2 max-sm:basis-full max-sm:justify-end max-sm:opacity-100 [@media(hover:none)]:opacity-100", focus === k && "opacity-100")}>
                            {view !== "done" && <IconBtn label="Done (E)" onClick={() => void done([it])}><IconCheck /></IconBtn>}
                            {view !== "done" && <IconBtn label="Snooze (S)" onClick={() => setSnoozeFor(snoozeFor === k ? null : k)}><IconClock /></IconBtn>}
                            {view !== "inbox" && <IconBtn label="Back to inbox" onClick={() => void restore(it)}><IconInbox /></IconBtn>}
                            <IconBtn label={it.read ? "Mark unread (U)" : "Mark read (U)"} onClick={() => void setRead([it], !it.read)}>{it.read ? <IconMail /> : <IconRead />}</IconBtn>
                            <IconBtn label={it.lane === "important" ? "Move to Noise (M)" : "Move to Important (M)"} onClick={() => void move(it)}><IconArrowRightLeft /></IconBtn>
                          </div>
                          {snoozeFor === k && <SnoozeMenu onPick={(b) => void snooze([it], b)} onClose={() => setSnoozeFor(null)} />}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </Card>
        )}
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-11 max-sm:w-11 [&_svg]:h-4 [&_svg]:w-4">
      {children}
    </button>
  );
}

function SnoozeMenu({ onPick, onClose }: { onPick: (b: SnoozeBody) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [date, setDate] = useState("");
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("mousedown", onDown); };
  }, [onClose]);
  const min = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return (
    <div ref={ref} role="menu" aria-label="Snooze until" data-testid="one-snooze-menu" className="absolute right-4 top-12 z-10 w-56 rounded-xl border border-line bg-bg p-1 shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150">
      {(Object.keys(SNOOZE_LABELS) as SnoozePreset[]).map((p) => (
        <button key={p} role="menuitem" onClick={() => onPick({ preset: p })} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-fill focus-visible:bg-fill focus-visible:outline-none">
          <IconClock className="h-3.5 w-3.5 text-subtle" />{SNOOZE_LABELS[p]}
        </button>
      ))}
      <form className="mt-1 flex items-center gap-1 border-t border-line px-1.5 pt-1.5" onSubmit={(e) => { e.preventDefault(); const iso = pickedDateIso(date); if (iso) onPick({ until: iso }); }}>
        <label className="sr-only" htmlFor="one-snooze-date">Pick a date</label>
        <DateInput id="one-snooze-date" min={min} value={date} onChange={(e) => setDate(e.target.value)} className="h-8 min-w-0 flex-1 text-[12.5px]" />
        <Button size="sm" type="submit" disabled={!date}>Snooze</Button>
      </form>
    </div>
  );
}

function KeysCard({ onClose }: { onClose: () => void }) {
  return (
    <Card className="mb-3 p-4" data-testid="one-keys">
      <div className="mb-2 flex items-center justify-between"><h2 className="text-[14px] font-medium">Keys</h2><Button size="sm" variant="ghost" onClick={onClose}>Close</Button></div>
      <ul className="grid gap-1.5 text-[13px] sm:grid-cols-3">
        {INBOX_KEYS.map((k) => <li key={k.key} className="flex items-center gap-2"><kbd className="min-w-6 rounded border border-line bg-fill px-1.5 text-center text-[12px]">{k.key}</kbd>{k.label}</li>)}
      </ul>
    </Card>
  );
}

function RulesCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["one-inbox", "rules"], queryFn: async () => (await api.get<{ rules: Rule[] }>("/one-inbox/rules")).rules });
  const remove = async (key: string) => {
    try { await api.del("/one-inbox/rules", { key }); await qc.invalidateQueries({ queryKey: ["one-inbox"] }); toast.success("Choice removed"); } catch (e) { showError(e as Error); }
  };
  return (
    <Card className="mb-3 p-4" data-testid="one-rules">
      <h2 className="mb-1 text-[14px] font-medium">Saved choices</h2>
      <p className="mb-2 text-[13px] text-muted">When you move an item, more from the same sender or source goes to the same place.</p>
      {q.isPending ? <SkeletonRows rows={2} label="Loading saved choices" /> : q.isError ? <LoadErrorInline onRetry={() => q.refetch()} />
        : !q.data?.length ? <p className="text-[13px] text-subtle">No saved choices yet. Press M on an item to move it.</p> : (
          <ul className="divide-y divide-line">
            {q.data.map((r) => (
              <li key={r.key} className="flex items-center gap-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                <span className="text-subtle">{r.lane === "important" ? "Important" : "Noise"}</span>
                <IconBtn label={`Remove the choice for ${r.label}`} onClick={() => void remove(r.key)}><IconTrash /></IconBtn>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}

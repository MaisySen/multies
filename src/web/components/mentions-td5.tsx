/**
 * TD5 universal mentions (MENTIONS_TD5) in the web app: the @ picker for people and records, record chips resolved for
 * the reader, and the References panel ("Mentioned in", "Mentions") shown on every record page.
 * Nothing renders HTML from text: titles come from the server already checked for this reader, and are escaped here.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Link } from "react-router";
import { LoadErrorInline } from "@/web/components/load-error-t1g";
import { LOAD_ERROR_TITLE } from "@/web/lib/load-errors-t1g";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { Avatar, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { initials } from "@/web/lib/format";
import {
  atQuery, displayTitle, labelsToTokens, parseRefs, REF_LABELS, REF_TOKEN_RE, refKey, refToken, SOURCE_LABELS, tokensToLabels,
  type RefItem, type RefType, type ResolvedRef,
} from "@/shared/mentions-td5";

export const useMentionsOn = () => !!useConfig().data?.mentionsTd5;

interface PickItem { kind: "person" | "record"; type: string; id: string; title: string; subtitle: string; at: string | null }
const quick = { retry: 1, refetchOnWindowFocus: false } as const;

function useDebounced<T>(v: T, ms = 150): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** Records the reader may see for an @ query (people come from the caller, who already has them). */
export function useRecordSearch(q: string | null, enabled: boolean) {
  const dq = useDebounced(q ?? "", 150);
  return useQuery({
    queryKey: ["mentions-td5", "search", dq],
    queryFn: () => api.get<{ people: PickItem[]; records: PickItem[] }>(`/mentions/search?q=${encodeURIComponent(dq)}&limit=8`),
    enabled: enabled && q !== null, staleTime: 30_000, ...quick,
  });
}

/** Titles of record tokens, resolved for this reader ("restricted" and "deleted" carry no title). */
export function useResolved(keys: string[], enabled = true) {
  const sorted = useMemo(() => [...new Set(keys)].sort().slice(0, 50), [keys]);
  return useQuery({
    queryKey: ["mentions-td5", "resolve", sorted.join(",")],
    queryFn: () => api.post<{ items: Record<string, ResolvedRef> }>("/mentions/resolve", { refs: sorted }).then((r) => r.items),
    enabled: enabled && sorted.length > 0, staleTime: 30_000, ...quick,
  });
}

export interface PickPerson { key: string; name: string; insert: string; hint?: string; onPick?: () => void }

/**
 * The @ picker for a text box: people first, then records the reader can see, newest first. Arrows move, Enter or Tab
 * picks, Escape closes. A record goes in as an @[Title] label and turns into its token with toTokens() on save.
 */
export function useMentionPicker(ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>, value: string, setValue: (v: string) => void, people: PickPerson[], opts: { enabled: boolean; above?: boolean; testId?: string; initialMap?: Record<string, string> }) {
  const [at, setAt] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const map = useRef<Record<string, string>>({});
  useEffect(() => { if (opts.initialMap) map.current = { ...opts.initialMap }; }, [opts.initialMap]);
  const search = useRecordSearch(at ? at.query.trim() : null, opts.enabled);
  const q = (at?.query ?? "").trim().toLowerCase();
  const peopleHits = at ? people.filter((p) => !q || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().includes(q)).slice(0, 5) : [];
  const records = at && opts.enabled ? (search.data?.records ?? []) : [];
  const items: ({ kind: "person"; p: PickPerson } | { kind: "record"; r: PickItem })[] = [...peopleHits.map((p) => ({ kind: "person" as const, p })), ...records.map((r) => ({ kind: "record" as const, r }))];
  // Escape dismisses this @word; it reopens once the word changes (a sync queued before the Escape does not undo it).
  const dismissed = useRef<{ start: number; query: string } | null>(null);
  const close = () => { if (at) dismissed.current = at; else { const el = ref.current; if (el) dismissed.current = atQuery(el.value, el.selectionStart ?? el.value.length); } setAt(null); };
  const sync = () => {
    const el = ref.current;
    if (!el) return;
    const next = atQuery(el.value, el.selectionStart ?? el.value.length);
    const d = dismissed.current;
    setAt(next && d && d.start === next.start && d.query === next.query ? null : next);
    setActive(0);
  };
  const pick = (i: number) => {
    const el = ref.current;
    const it = items[i];
    if (!el || !at || !it) return;
    const caret = el.selectionStart ?? value.length;
    let word: string;
    if (it.kind === "person") { word = it.p.insert; it.p.onPick?.(); } else {
      const shown = tokensToLabels(refToken({ type: it.r.type as RefType, id: it.r.id }), { [`${it.r.type}:${it.r.id}`]: it.r.title });
      const label = Object.keys(shown.map)[0]!;
      let final = label;
      for (let n = 2; map.current[final] && map.current[final] !== shown.map[label]; n++) final = `${label.slice(0, -1)} ${n}]`;
      map.current[final] = shown.map[label]!;
      word = `${final} `;
    }
    const next = value.slice(0, at.start) + word + value.slice(caret);
    setValue(next);
    setAt(null);
    requestAnimationFrame(() => { el.focus(); const pos = at.start + word.length; el.setSelectionRange(pos, pos); });
  };
  const onKeyDown = (e: ReactKeyboardEvent): boolean => {
    if (!at || !items.length) { if (at && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return true; } return false; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % items.length); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return true; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(Math.min(active, items.length - 1)); return true; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return true; }
    return false;
  };
  const loading = !!at && opts.enabled && search.isFetching && !records.length;
  const failed = !!at && opts.enabled && search.isError;
  const open = !!at && (items.length > 0 || loading || failed);
  const list = open ? (
    <div className={cn("absolute left-0 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-elevated p-1 shadow-pop", opts.above === false ? "top-full mt-1" : "bottom-full mb-1")} data-testid={opts.testId ?? "mention-picker-td5"}>
      <ul role="listbox" aria-label="Mention a person or a record" className="max-h-72 overflow-y-auto">
        {items.map((it, i) => (
          <li key={it.kind === "person" ? `p:${it.p.key}` : `r:${it.r.type}:${it.r.id}`} role="option" aria-selected={i === active} id={`mention-opt-${i}`}
            onMouseDown={(e) => { e.preventDefault(); pick(i); }} onMouseEnter={() => setActive(i)}
            className={cn("flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-150 max-sm:min-h-11", i === active && "bg-hover")}>
            {it.kind === "person"
              ? <><Avatar label={initials(it.p.name)} className="h-5 w-5 text-[9px]" /><span className="truncate">{it.p.name}</span>{it.p.hint && <span className="ml-auto shrink-0 text-[11.5px] text-subtle">{it.p.hint}</span>}</>
              : <><span className="shrink-0 rounded bg-fill px-1.5 py-0.5 text-[11px] font-medium text-muted">{REF_LABELS[it.r.type as RefType] ?? "Item"}</span><span className="truncate">{it.r.title}</span><span className="ml-auto max-w-[40%] shrink-0 truncate text-[11.5px] text-subtle">{it.r.subtitle.replace(/^(Task|Project|Doc|Contact|Deal|Meeting|Form|Invoice)( · )?/, "")}</span></>}
          </li>
        ))}
        {loading && <li className="px-2 py-1.5" aria-busy="true"><Skeleton className="h-4 w-40" /></li>}
        {failed && !items.length && <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-[12.5px] text-muted" role="alert">{LOAD_ERROR_TITLE}.<button type="button" className="rounded px-2 py-1 text-brand-hover hover:bg-hover" onMouseDown={(e) => { e.preventDefault(); void search.refetch(); }}>Retry</button></li>}
      </ul>
    </div>
  ) : null;
  const toTokens = (text: string) => labelsToTokens(text, map.current);
  const reset = () => { map.current = {}; setAt(null); };
  return { onKeyDown, sync, list, open, toTokens, reset, activeId: open && items.length ? `mention-opt-${active}` : undefined };
}

/** For editing saved text: tokens become @[Title] labels (titles resolved for this reader), with the map back. */
export function useEditableTokens(text: string, enabled: boolean) {
  const keys = useMemo(() => (enabled ? parseRefs(text, 50).map(refKey) : []), [text, enabled]);
  const res = useResolved(keys, enabled);
  return useMemo(() => {
    if (!enabled || !keys.length) return { text, map: {} as Record<string, string>, ready: true };
    if (!res.data) return { text, map: {}, ready: !res.isFetching };
    const titles = Object.fromEntries(Object.entries(res.data).map(([k, v]) => [k, displayTitle(v)]));
    return { ...tokensToLabels(text, titles), ready: true };
  }, [enabled, keys, res.data, res.isFetching, text]);
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeUrl = (u: string) => (u.startsWith("/app/") ? u : "#");

/** In already escaped HTML (renderNotes output), escaped record tokens become chips. Titles are escaped here. */
export function chipsInHtml(html: string, resolved: Record<string, ResolvedRef> | undefined): string {
  return html.replace(/&lt;#([a-z]+):([A-Za-z0-9_.@-]{1,200})&gt;/g, (_m, type: string, id: string) => {
    const r = resolved?.[`${type}:${id}`];
    if (!r) return `<span class="ref-chip ref-chip-muted">${escHtml(REF_LABELS[type as RefType] ?? "Item")}</span>`;
    if (r.state !== "ok") return `<span class="ref-chip ref-chip-muted" data-state="${r.state}">${escHtml(displayTitle(r))}</span>`;
    return `<a class="ref-chip" href="${escHtml(safeUrl(r.url))}" data-ref="${escHtml(type)}">${escHtml(r.title)}</a>`;
  });
}

/** Keys of all record tokens in some texts. */
export function tokenKeys(...texts: (string | null | undefined)[]): string[] {
  return texts.flatMap((t) => parseRefs(t ?? "", 50).map(refKey));
}

/** One record chip (chat, comments): a link for readers with access, a muted "Restricted item" or "Deleted item" otherwise. */
export function RefChip({ r, fallbackType }: { r: ResolvedRef | undefined; fallbackType?: string }) {
  if (!r) return <span className="ref-chip ref-chip-muted">{REF_LABELS[fallbackType as RefType] ?? "Item"}</span>;
  if (r.state !== "ok") return <span className="ref-chip ref-chip-muted" data-state={r.state} data-testid="ref-chip-muted">{displayTitle(r)}</span>;
  return <Link to={safeUrl(r.url)} className="ref-chip" data-testid="ref-chip" title={r.subtitle}>{r.title}</Link>;
}

/** Plain text with record tokens as chips (comments). Never renders HTML from the text. */
export function MentionText({ text, resolved }: { text: string; resolved: Record<string, ResolvedRef> | undefined }) {
  const parts = text.split(new RegExp(`(${REF_TOKEN_RE.source})`, "g"));
  const out: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const m = /^<#([a-z]+):(.+)>$/.exec(p);
    if (m) { out.push(<RefChip key={i} r={resolved?.[`${m[1]}:${m[2]}`]} fallbackType={m[1]} />); i += 2; continue; }
    if (p) out.push(<span key={i}>{p}</span>);
  }
  return <>{out}</>;
}

/** A comment's text: record tokens as chips for this reader when mentions are on; exactly the text otherwise. */
export function CommentText({ text }: { text: string }) {
  const on = useMentionsOn();
  const keys = useMemo(() => (on ? tokenKeys(text) : []), [on, text]);
  const res = useResolved(keys, on);
  if (!on || !keys.length) return <>{text}</>;
  return <MentionText text={text} resolved={res.data} />;
}

// ---------------------------------------------------------------- References panel

type Page = { items: RefItem[]; next: string | null; total: number };

function useOnline() {
  const [on, setOn] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return on;
}

function RefList({ type, id, dir, label, stamp }: { type: RefType; id: string; dir: "in" | "out"; label: string; stamp?: string | number }) {
  const q = useInfiniteQuery({
    queryKey: ["mentions-td5", "refs", type, id, dir],
    queryFn: ({ pageParam }) => api.get<Page>(`/mentions/refs/${type}/${encodeURIComponent(id)}?dir=${dir}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "" as string,
    getNextPageParam: (p) => p.next ?? undefined,
    refetchInterval: () => (typeof document !== "undefined" && document.visibilityState === "visible" ? 30_000 : false),
    refetchOnWindowFocus: true, retry: 1,
  });
  // The record changed (its text was saved): read the panel again, keeping what is shown until the answer is in.
  const seenStamp = useRef(stamp);
  const { refetch } = q;
  useEffect(() => { if (stamp !== undefined && stamp !== seenStamp.current) { seenStamp.current = stamp; void refetch(); } }, [stamp, refetch]);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;
  const offline = !useOnline();
  return (
    <section aria-label={label} className="min-w-0">
      <h4 className="mb-1 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">{label}{total > 0 && <span className="rounded-full bg-fill px-1.5 text-[11px] font-medium normal-case tracking-normal text-muted">{total}</span>}</h4>
      {offline && <p role="status" className="mb-1.5 flex items-center gap-1.5 rounded-md bg-fill px-3 py-2 text-[12.5px] text-muted" data-testid={`refs-${dir}-offline`}>You are offline. References refresh when you are back online.</p>}
      {q.isPending ? (
        <div className="space-y-1.5" aria-busy="true" data-testid={`refs-${dir}-loading`}><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-3/4" /></div>
      ) : q.isError && !items.length ? (
        <div data-testid={`refs-${dir}-error`}><LoadErrorInline className="rounded-md border border-line px-3 py-2" onRetry={() => q.refetch()} /></div>
      ) : !items.length ? (
        <p className="rounded-md border border-dashed border-line px-3 py-2 text-[12.5px] text-subtle" data-testid={`refs-${dir}-empty`}>
          {dir === "in" ? "Nothing mentions this yet. Type @ in a chat, task or comment to link it." : "This does not mention anything yet. Type @ in its text to link a record."}
        </p>
      ) : (
        <ul className="space-y-1" data-testid={`refs-${dir}`}>
          {items.map((it) => (
            <li key={it.key}>
              {it.record.state === "ok" ? (
                <Link to={safeUrl(it.record.url)} className="flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 max-sm:min-h-11">
                  <span className="shrink-0 rounded bg-fill px-1.5 py-0.5 text-[11px] font-medium text-muted">{it.record.type === "channel" ? "Chat" : REF_LABELS[it.record.type as RefType]}</span>
                  <span className="truncate font-medium">{it.record.title}</span>
                  <span className="ml-auto shrink-0 text-[11.5px] text-subtle">{dir === "in" ? SOURCE_LABELS[it.via] : it.record.subtitle}</span>
                </Link>
              ) : (
                <div className="flex min-h-9 items-center gap-2 px-2 py-1.5 text-[13px] text-subtle max-sm:min-h-11">
                  <span className="shrink-0 rounded bg-fill px-1.5 py-0.5 text-[11px] font-medium">{it.record.type === "channel" ? "Chat" : REF_LABELS[it.record.type as RefType]}</span>
                  <span className="italic">{displayTitle(it.record)}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && <Button size="sm" variant="ghost" className="mt-1" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Show more</Button>}
    </section>
  );
}

/** "Mentioned in" and "Mentions" for one record. Hidden when the flag is off. */
export function ReferencesPanel({ type, id, className, stamp }: { type: RefType; id: string; className?: string; stamp?: string | number }) {
  const on = useMentionsOn();
  if (!on || !id) return null;
  return (
    <div className={cn("mt-6 border-t border-line pt-4", className)} data-testid="references-panel">
      <h3 className="mb-3 text-[13px] font-semibold">References</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <RefList type={type} id={id} dir="in" label="Mentioned in" stamp={stamp} />
        <RefList type={type} id={id} dir="out" label="Mentions" stamp={stamp} />
      </div>
    </div>
  );
}

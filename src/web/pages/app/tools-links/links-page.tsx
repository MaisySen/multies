/**
 * R87: Tools > Links. Short links (with QR and click stats), a link in bio page, team go links and the link domain, as
 * four tabs on one page. Hidden unless GET /api/tools lists the "links" feature.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { IconChart, IconClose, IconEdit, IconExternalLink, IconFileUp, IconLink, IconLock, IconPlus, IconSearch, IconTrash, IconClock } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import type { ShortLinkInfo } from "@/shared/links";
import { STATUS, compact as compact_, isTyping, linksKey, plainUrl, shortHost, useLinkStats, useShortLinks } from "./data";
import { LinkDialog } from "./link-dialog";
import { QrPanel } from "./qr-panel";
import { StatsView } from "./stats";
import { ImportDialog } from "./import-dialog";

const BioEditor = lazy(() => import("./bio-editor").then((m) => ({ default: m.BioEditor })));
const GoLinksTab = lazy(() => import("./go-links").then((m) => ({ default: m.GoLinksTab })));
const DomainTab = lazy(() => import("./domain").then((m) => ({ default: m.DomainTab })));

const TABS = [["links", "Short links"], ["bio", "Bio page"], ["go", "Go links"], ["domain", "Domain"]] as const;
type Tab = (typeof TABS)[number][0];
const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

export function LinksPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([k]) => k === params.get("tab"))?.[0] ?? "links") as Tab;
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); p.set("tab", t); p.delete("link"); setParams(p, { replace: true }); };
  const [creating, setCreating] = useState(params.get("new") === "1");
  const list = useShortLinks();
  const base = list.data?.base ?? `${location.origin}/l`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
      if (e.key === "n" && tab === "links") { e.preventDefault(); setCreating(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    setTab(TABS[next][0]); tabRefs.current[next]?.focus();
  };

  return (
    <ToolsFrame entryKey="links" title="Links" wide usage={false} testId="links-page"
      description="Short links with QR codes and click stats, a link in bio page, and go links for your team."
      actions={tab === "links" ? <Button onClick={() => setCreating(true)} data-testid="links-new" title="New link (N)"><IconPlus className="h-4 w-4" />New link</Button> : undefined}>
      <div role="tablist" aria-label="Links" className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1">
        {TABS.map(([k, label], i) => (
          <button key={k} ref={(el) => { tabRefs.current[i] = el; }} role="tab" type="button" id={`links-tab-${k}`} aria-selected={tab === k} aria-controls={`links-panel-${k}`} tabIndex={tab === k ? 0 : -1}
            onClick={() => setTab(k)} onKeyDown={(e) => onTabKey(e, i)} data-testid={`links-tab-${k}`}
            className={cn("relative -mb-px h-10 shrink-0 whitespace-nowrap rounded-t-lg px-3 text-[13.5px] font-medium transition-colors max-sm:h-11", ring, tab === k ? "text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand" : "text-muted hover:text-fg")}>{label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`links-panel-${tab}`} aria-labelledby={`links-tab-${tab}`}>
        {tab === "links" && <ShortLinksTab onNew={() => setCreating(true)} />}
        <Suspense fallback={<div className="space-y-3 pt-2" aria-busy="true"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-40 rounded-xl" /></div>}>
          {tab === "bio" && <BioEditor />}
          {tab === "go" && <GoLinksTab />}
          {tab === "domain" && <DomainTab />}
        </Suspense>
      </div>
      <LinkDialog open={creating} onClose={() => { setCreating(false); if (params.get("new")) { const p = new URLSearchParams(params); p.delete("new"); setParams(p, { replace: true }); } }} base={base}
        onSaved={(l) => { const p = new URLSearchParams(params); p.set("link", l.id); p.delete("new"); setParams(p, { replace: true }); }} />
    </ToolsFrame>
  );
}

function ShortLinksTab({ onNew }: { onNew: () => void }) {
  const [params, setParams] = useSearchParams();
  const list = useShortLinks();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [importing, setImporting] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const openId = params.get("link");
  const setOpen = (id: string | null) => { const p = new URLSearchParams(params); if (id) p.set("link", id); else p.delete("link"); setParams(p, { replace: true }); };
  const links = useMemo(() => list.data?.links ?? [], [list.data]);
  const tags = useMemo(() => [...new Set(links.flatMap((l) => l.tags))].sort(), [links]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return links.filter((l) => (!tag || l.tags.includes(tag)) && (!s || `${l.code} ${l.url} ${l.title ?? ""} ${l.tags.join(" ")}`.toLowerCase().includes(s)));
  }, [links, q, tag]);
  const open = links.find((l) => l.id === openId) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !isTyping(e) && !document.querySelector("dialog[open]")) { e.preventDefault(); search.current?.focus(); }
      if (e.key === "Escape" && openId && !document.querySelector("dialog[open]")) setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (list.isError) return (
    <Card className="mt-4 p-6 text-center" data-testid="links-error"><p className="font-medium">Couldn't load your links</p><p className="mt-1 text-sm text-muted">{errorMessage(list.error)}</p><Button variant="outline" className="mt-4" onClick={() => void list.refetch()}>Try again</Button></Card>
  );

  return (
    <div className={cn("pt-4", open && "2xl:grid 2xl:grid-cols-[minmax(0,1fr)_420px] 2xl:gap-5")}>
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-48 flex-1">
            <span className="sr-only">Search links</span>
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <input ref={search} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search links" data-testid="links-search"
              className={cn("h-9 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm placeholder:text-subtle max-sm:h-11", ring)} />
          </label>
          {tags.length > 0 && (
            <div className="w-40 max-sm:flex-1">
              <Select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag" data-testid="links-tag">
                <option value="">All tags</option>{tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </div>
          )}
          <Button variant="outline" onClick={() => setImporting(true)} data-testid="links-import"><IconFileUp className="h-4 w-4" />Import CSV</Button>
        </div>
        {list.isLoading ? (
          <Card className="divide-y divide-line" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="flex items-center gap-3 p-4"><Skeleton className="h-9 w-9 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="w-1/3" /><Skeleton className="h-3 w-2/3" /></div><Skeleton className="h-6 w-14" /></div>)}</Card>
        ) : !links.length ? (
          <Card><EmptyState icon={<IconLink />} title="Make your first short link" body="Turn a long address into a short link with a QR code, then see who clicks, from where and on what device." action={<div className="flex flex-wrap justify-center gap-2"><Button onClick={onNew} data-testid="links-empty-new"><IconPlus className="h-4 w-4" />New link</Button><Button variant="outline" onClick={() => setImporting(true)}>Import CSV</Button></div>} /></Card>
        ) : !shown.length ? (
          <Card><EmptyState icon={<IconSearch />} title="No links match" body="Try other words or clear the tag filter." action={<Button variant="outline" onClick={() => { setQ(""); setTag(""); }}>Clear</Button>} /></Card>
        ) : (
          <Card className="overflow-hidden" data-testid="links-list">
            <div className={cn("hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_72px_96px_88px] gap-3 border-b border-line bg-fill/60 px-4 py-2 text-[12px] font-medium text-muted md:grid", open && "2xl:hidden")} aria-hidden>
              <span>Link</span><span>Opens</span><span className="text-right">Clicks</span><span>Status</span><span />
            </div>
            <ul className="divide-y divide-line">
              {shown.map((l) => <LinkRow key={l.id} l={l} compact={!!open} active={l.id === openId} onOpen={() => setOpen(l.id === openId ? null : l.id)} />)}
            </ul>
          </Card>
        )}
        {links.length > 0 && <p className="text-[12px] text-subtle">{links.length} {links.length === 1 ? "link" : "links"} on {plainUrl(list.data?.base ?? "")}/. Press N for a new link, / to search.</p>}
      </div>
      {open && <LinkPanel key={open.id} l={open} onClose={() => setOpen(null)} base={list.data?.base ?? ""} />}
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}

function LinkRow({ l, active, compact, onOpen }: { l: ShortLinkInfo; active: boolean; compact: boolean; onOpen: () => void }) {
  const st = STATUS[l.status];
  const wide = "md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_72px_96px_88px]";
  return (
    <li className={cn("group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-3 transition-colors", wide, compact && "2xl:grid-cols-[minmax(0,1fr)_auto]", active ? "bg-brand-soft" : "hover:bg-hover/50")} data-testid="link-row">
      <button type="button" onClick={onOpen} aria-expanded={active} className={cn("min-w-0 rounded-md text-left after:absolute after:inset-0 after:content-['']", ring)}>
        <span className="flex items-center gap-1.5 font-medium text-brand-hover" title={l.shortUrl}><span className="truncate">/{l.code}</span>{l.hasPassword && <IconLock className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />}{l.expiresAt && <IconClock className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />}</span>
        <span className="block truncate text-[12.5px] text-muted">{l.title || shortHost(l.url)}</span>
      </button>
      <span className={cn("col-span-2 row-start-2 min-w-0 truncate text-[13px] text-muted md:col-span-1 md:row-start-auto", !l.title && "max-md:hidden", compact && "2xl:hidden")} title={l.url}>{shortHost(l.url)}{l.tags.length > 0 && <span className="ml-2 hidden xl:inline">{l.tags.slice(0, 2).map((t) => <span key={t} className="mr-1 rounded bg-fill px-1.5 py-0.5 text-[11.5px]">{t}</span>)}</span>}</span>
      <span className="justify-self-end text-right text-[13px] tabular-nums md:text-sm"><span className="font-medium">{compact_(l.clicks)}</span><span className={cn("text-muted md:hidden", compact && "2xl:inline")}> {l.clicks === 1 ? "click" : "clicks"}</span></span>
      <span className={cn("hidden md:block", compact && "2xl:hidden")}><Badge tone={st.tone} dot>{st.label}</Badge></span>
      <span className={cn("relative z-10 hidden justify-end md:flex", compact && "2xl:hidden")}><CopyButton value={l.shortUrl} toastText="Short link copied" /></span>
    </li>
  );
}

function LinkPanel({ l, onClose, base }: { l: ShortLinkInfo; onClose: () => void; base: string }) {
  const qc = useQueryClient();
  const [view, setView] = useState<"details" | "qr" | "stats">("details");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [days, setDays] = useState(30);
  const stats = useLinkStats(view === "stats" ? l.id : null, days);
  const toggle = useMutation({
    mutationFn: () => api.patch(`/links/${l.id}`, { enabled: !l.enabled }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: linksKey }); toast.success(l.enabled ? "Link turned off" : "Link turned on", { action: { label: "Undo", onClick: () => void api.patch(`/links/${l.id}`, { enabled: l.enabled }).then(() => qc.invalidateQueries({ queryKey: linksKey })) } }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/links/${l.id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: linksKey }); toast.success("Link deleted"); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const st = STATUS[l.status];
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => { panelRef.current?.focus(); }, []);
  return (
    <aside ref={panelRef} tabIndex={-1} aria-label="Link details" data-testid="link-panel"
      className="fixed inset-0 z-50 overflow-y-auto bg-surface p-4 outline-none max-sm:pb-24 sm:left-auto sm:w-[440px] sm:border-l sm:border-line sm:p-5 sm:shadow-pop 2xl:sticky 2xl:inset-auto 2xl:top-2 2xl:z-auto 2xl:w-auto 2xl:max-h-[calc(100dvh-5rem)] 2xl:rounded-xl 2xl:border 2xl:p-4 2xl:shadow-card">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] font-semibold text-brand-hover" title={l.shortUrl}>{plainUrl(l.shortUrl)}</p>
          <p className="mt-0.5 flex items-center gap-2 text-[12.5px] text-muted"><Badge tone={st.tone} dot>{st.label}</Badge>{compact_(l.clicks)} {l.clicks === 1 ? "click" : "clicks"}</p>
        </div>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close" title="Close (Esc)"><IconClose className="h-4 w-4" /></Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <CopyButton value={l.shortUrl} label="Copy link" toastText="Short link copied" className="h-8 px-3 text-[13px]" />
        <a href={l.shortUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-fill px-3 text-[13px] text-muted hover:bg-hover hover:text-fg max-sm:min-h-11"><IconExternalLink className="h-3.5 w-3.5" aria-hidden />Open</a>
      </div>
      <div role="tablist" aria-label="Link" className="mt-4 inline-flex rounded-lg bg-fill p-0.5">
        {([["details", "Details"], ["qr", "QR code"], ["stats", "Stats"]] as const).map(([k, label]) => (
          <button key={k} role="tab" type="button" aria-selected={view === k} onClick={() => setView(k)} data-testid={`panel-${k}`}
            className={cn("h-8 rounded-md px-3 text-[13px] font-medium transition-colors max-sm:h-10", ring, view === k ? "bg-surface text-fg shadow-[var(--shadow-e1)]" : "text-muted hover:text-fg")}>{label}</button>
        ))}
      </div>
      <div className="mt-4">
        {view === "details" && (
          <div className="space-y-4">
            <dl className="space-y-3 text-sm">
              <div><dt className="text-[12px] text-muted">Opens</dt><dd className="break-all">{l.url}</dd></div>
              {l.title && <div><dt className="text-[12px] text-muted">Title</dt><dd>{l.title}</dd></div>}
              {l.tags.length > 0 && <div><dt className="text-[12px] text-muted">Tags</dt><dd className="flex flex-wrap gap-1">{l.tags.map((t) => <span key={t} className="rounded bg-fill px-1.5 py-0.5 text-[12px]">{t}</span>)}</dd></div>}
              <div className="grid grid-cols-2 gap-3">
                <div><dt className="text-[12px] text-muted">Stops working</dt><dd>{l.expiresAt ? new Date(l.expiresAt).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "Never"}</dd></div>
                <div><dt className="text-[12px] text-muted">Click limit</dt><dd>{l.maxClicks ? `${l.clicks} of ${l.maxClicks}` : "None"}</dd></div>
                <div><dt className="text-[12px] text-muted">Password</dt><dd>{l.hasPassword ? "Yes" : "No"}</dd></div>
                <div><dt className="text-[12px] text-muted">Made by</dt><dd className="truncate">{l.createdByName ?? "Someone"}, {new Date(l.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</dd></div>
              </div>
            </dl>
            {l.canEdit ? (
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                <Button variant="outline" onClick={() => setEditing(true)} data-testid="link-edit"><IconEdit className="h-4 w-4" />Edit</Button>
                <Button variant="outline" onClick={() => toggle.mutate()} loading={toggle.isPending} data-testid="link-toggle">{l.enabled ? "Turn off" : "Turn on"}</Button>
                <Button variant="danger" onClick={() => setDeleting(true)} data-testid="link-delete"><IconTrash className="h-4 w-4" />Delete</Button>
              </div>
            ) : <p className="border-t border-line pt-4 text-[13px] text-muted">Only the person who made this link or an admin can change it.</p>}
            <button type="button" onClick={() => setView("stats")} className={cn("flex w-full items-center gap-2 rounded-lg border border-line p-3 text-left text-sm hover:bg-hover/50", ring)}><IconChart className="h-4 w-4 text-muted" aria-hidden />See clicks by day, country and device</button>
          </div>
        )}
        {view === "qr" && <QrPanel value={l.shortUrl} name={l.code} />}
        {view === "stats" && <StatsView data={stats.data} loading={stats.isLoading} error={stats.isError} days={days} onDays={setDays} csvHref={`/api/links/${l.id}/clicks.csv`} onRetry={() => void stats.refetch()} />}
      </div>
      <LinkDialog open={editing} onClose={() => setEditing(false)} base={base} link={l} />
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => del.mutate()} busy={del.isPending} title="Delete this link?" description={`${plainUrl(l.shortUrl)} stops working and its click stats are deleted. This can't be undone. To pause it instead, turn it off.`} confirmLabel="Delete link" />
    </aside>
  );
}

export { Dialog };

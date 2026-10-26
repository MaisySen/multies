/**
 * R39 page history: a panel beside the doc with every saved version, a compare view against the page now, Save version
 * (a named version, kept for good), name a version, and Restore (the page as it is now is saved first, so a restore can
 * be undone). A side panel on desktop and a full sheet on phones (the list, then the compare view with a back button).
 * Keyboard: up and down move through the list, Enter opens the compare view on phones, Escape closes.
 * Server: services/suite/doc-versions-r39.ts. rea: files/teardowns/rea/docs-chat/gap-r39.md.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconBack, IconBookmark, IconClose, IconHistory, IconUndo } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { useDialogs } from "@/web/components/ui/confirm";
import { EmptyState, Skeleton } from "@/web/components/ui/misc";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { tone } from "@/web/components/app-bits";
import { colourFor } from "./doc-collab";
import { diffCounts, diffLines, type DiffOp } from "@/shared/line-diff-r39";

interface Author { type: string; id: string | null; name: string }
export interface DocVersion { id: string; docVersion: number; title: string; name: string | null; reason: "edit" | "restore"; words: number; author: Author; savedAt: string }
interface VersionList { doc: { id: string; title: string; version: number; words: number; updatedAt: string; editedBy: Author }; versions: DocVersion[] }
interface VersionDetail { version: DocVersion & { text: string }; current: { version: number; title: string }; sinceThen: { added: number; removed: number; titleChanged: boolean } }

const whenLabel = (iso: string) => {
  const d = new Date(iso); const now = new Date();
  const same = d.toDateString() === now.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (same) return `Today, ${time}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) })}, ${time}`;
};
const nameOf = (a: Author) => a.name || (a.type === "agent" ? "An agent" : a.type === "system" ? "Automation" : "Someone");

function Avatar({ who, size = 28 }: { who: Author; size?: number }) {
  const n = nameOf(who);
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-full font-semibold text-white" style={{ width: size, height: size, fontSize: size * 0.4, background: tone(colourFor(who.id ?? n)) }}>
      {n.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** The header button: opens the panel. Cmd or Ctrl, Option or Alt, Shift and H toggles it too. */
export function DocHistoryButton({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.shiftKey && e.code === "KeyH") { e.preventDefault(); onOpen(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
  return (
    <button type="button" aria-label="Page history" title="Page history (Ctrl or Cmd, Alt, Shift, H)" onClick={onOpen} data-testid="doc-history-button"
      className="inline-flex items-center justify-center gap-1 rounded px-1.5 py-1 transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-10 max-sm:min-w-10">
      <IconHistory className="h-4 w-4" /><span className="max-sm:hidden">History</span>
    </button>
  );
}

function DiffView({ ops }: { ops: DiffOp[] }) {
  if (!ops.length) return <p className="py-8 text-center text-[13px] text-subtle">This version is empty.</p>;
  return (
    <ol className="space-y-0.5 font-[inherit] text-[14px] leading-6" data-testid="doc-version-diff" aria-label="Changes from this version to the page now">
      {ops.map((o, i) => (
        <li key={i} data-op={o.type}
          className={cn("flex gap-2 rounded-md px-2 py-0.5",
            o.type === "add" && "bg-[color-mix(in_srgb,var(--color-ok)_14%,transparent)] text-fg",
            o.type === "del" && "bg-[color-mix(in_srgb,var(--color-bad)_12%,transparent)] text-muted line-through decoration-[color-mix(in_srgb,var(--color-bad)_60%,transparent)]",
            o.type === "same" && "text-muted")}>
          <span aria-hidden className={cn("w-3 shrink-0 select-none text-center font-semibold", o.type === "add" ? "text-ok" : o.type === "del" ? "text-bad" : "text-transparent")}>{o.type === "add" ? "+" : o.type === "del" ? "\u2212" : "·"}</span>
          <span className="sr-only">{o.type === "add" ? "Added since: " : o.type === "del" ? "Only in this version: " : ""}</span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{o.text || "\u00a0"}</span>
        </li>
      ))}
    </ol>
  );
}

export function DocHistoryPanel({ docId, open, onClose, currentText, beforeChange, onRestored }: {
  docId: string; open: boolean; onClose: () => void; currentText: string;
  /** Saves pending edits first, so the panel compares against the stored page. */
  beforeChange: () => Promise<void>;
  onRestored: (doc: unknown) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const { confirm, prompt, dialogs } = useDialogs();
  const [selected, setSelected] = useState<string | null>(null);
  const [phoneDetail, setPhoneDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = useQuery({ queryKey: ["doc-versions", docId], enabled: open, queryFn: () => api.get<VersionList>(`/docs/${docId}/versions`) });
  const versions = useMemo(() => list.data?.versions ?? [], [list.data]);
  const detail = useQuery({ queryKey: ["doc-version", docId, selected], enabled: open && !!selected, queryFn: () => api.get<VersionDetail>(`/docs/${docId}/versions/${selected}`) });

  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) { d.showModal(); setPhoneDetail(false); void beforeChange().then(() => qc.invalidateQueries({ queryKey: ["doc-versions", docId] })); }
    if (!open && d.open) d.close();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open && !selected && versions.length) setSelected(versions[0].id); }, [open, versions, selected]);

  const ops = useMemo(() => (detail.data ? diffLines(detail.data.version.text, currentText) : []), [detail.data, currentText]);
  const counts = useMemo(() => diffCounts(ops), [ops]);

  const move = useCallback((step: number) => {
    if (!versions.length) return;
    const i = Math.max(0, versions.findIndex((v) => v.id === selected));
    const next = versions[Math.min(versions.length - 1, Math.max(0, i + step))];
    setSelected(next.id);
    document.getElementById(`dver-${next.id}`)?.focus();
  }, [versions, selected]);

  const saveVersion = async () => {
    const name = await prompt({ title: "Save this version", label: "Name", description: "Give this moment a name. Named versions are kept for good.", placeholder: "Before the big rewrite", confirmLabel: "Save version", validate: () => null });
    if (name === null) return;
    try {
      await beforeChange();
      const r = await api.post<{ version: DocVersion }>(`/docs/${docId}/versions`, { name: name.trim() || undefined });
      await qc.invalidateQueries({ queryKey: ["doc-versions", docId] });
      setSelected(r.version.id);
      toast.success(`Saved as “${r.version.name}”`);
    } catch (e) { showError(e as Error); }
  };
  const rename = async (v: DocVersion) => {
    const name = await prompt({ title: v.name ? "Rename version" : "Name this version", label: "Name", description: "Named versions are kept for good. Leave it empty to remove the name.", initial: v.name ?? "", confirmLabel: "Save", validate: () => null });
    if (name === null) return;
    try { await api.patch(`/docs/${docId}/versions/${v.id}`, { name: name.trim() || null }); await qc.invalidateQueries({ queryKey: ["doc-versions", docId] }); } catch (e) { showError(e as Error); }
  };
  const restore = async (v: DocVersion) => {
    const ok = await confirm({ title: "Restore this version?", description: `The page goes back to ${v.name ? `“${v.name}”` : whenLabel(v.savedAt)}. The page as it is now is saved first, so you can undo this from the history.`, confirmLabel: "Restore" });
    if (!ok) return;
    setBusy(true);
    try {
      await beforeChange();
      const r = await api.post<{ doc: unknown; savedCurrentAs: string }>(`/docs/${docId}/versions/${v.id}/restore`, {});
      await qc.invalidateQueries({ queryKey: ["doc-versions", docId] });
      onRestored(r.doc);
      onClose();
      toast.success("Version restored", { action: { label: "Undo", onClick: () => void api.post<{ doc: unknown }>(`/docs/${docId}/versions/${r.savedCurrentAs}/restore`, {}).then((u) => { onRestored(u.doc); void qc.invalidateQueries({ queryKey: ["doc-versions", docId] }); }).catch((e: Error) => showError(e)) } });
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };

  const sel = versions.find((v) => v.id === selected) ?? null;
  return (
    <dialog ref={ref} onClose={(e) => { if (e.target === e.currentTarget) onClose(); }} aria-labelledby="doc-history-title" data-testid="doc-history-panel"
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
        if (e.key === "ArrowDown") { e.preventDefault(); move(1); } else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      }}
      className={cn(
        "m-0 ml-auto h-dvh max-h-none w-full max-w-[880px] border-l border-line max-sm:border-l-0 bg-elevated p-0 text-fg elev-3 backdrop:bg-black/30 backdrop:backdrop-blur-[2px]",
        "open:animate-pop-in max-sm:open:animate-sheet-up open:backdrop:animate-fade-in motion-reduce:open:animate-none",
      )}>
      {dialogs}
      {open && (
        <div className="flex h-full flex-col">
          <header className="flex items-start gap-3 border-b border-line px-5 pb-4 pt-5">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-[color-mix(in_srgb,var(--color-brand)_14%,transparent)] text-brand" aria-hidden><IconHistory className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <h2 id="doc-history-title" className="text-[22px] font-semibold tracking-tight">Page history</h2>
              <p className="text-[13px] text-muted max-sm:hidden">A version is kept for each editing session and before every restore. The last 50 stay, named ones for good.</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void saveVersion()} data-testid="doc-version-save"><IconBookmark className="h-4 w-4" /><span className="max-sm:hidden">Save version</span></Button>
            <button type="button" onClick={onClose} aria-label="Close page history" className="grid place-items-center rounded-full p-1.5 text-subtle transition-colors hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11"><IconClose className="h-4 w-4" /></button>
          </header>
          <div className="flex min-h-0 flex-1">
            {/* The list */}
            <nav aria-label="Saved versions" className={cn("w-[300px] shrink-0 overflow-y-auto border-r border-line p-2 max-sm:w-full max-sm:border-r-0", phoneDetail && "max-sm:hidden")}>
              {list.data && (
                <div className="mb-1 flex items-center gap-2.5 rounded-xl px-2.5 py-2" data-testid="doc-version-current">
                  <Avatar who={list.data.doc.editedBy} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[13.5px] font-medium">Current page<span className="rounded-full bg-[color-mix(in_srgb,var(--color-ok)_16%,transparent)] px-1.5 text-[11px] font-semibold text-ok">Now</span></div>
                    <div className="truncate text-[12px] text-subtle">{nameOf(list.data.doc.editedBy)} · {timeAgo(list.data.doc.updatedAt)} · {list.data.doc.words} words</div>
                  </div>
                </div>
              )}
              {list.isPending ? (
                <div className="space-y-2 p-2" aria-label="Loading versions">{[0, 1, 2, 3].map((i) => <div key={i} className="flex items-center gap-2.5"><Skeleton className="h-7 w-7 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-3 w-1/2" /></div></div>)}</div>
              ) : !versions.length ? (
                <EmptyState icon={<IconHistory />} art={<HistoryArt />} title="No earlier versions yet" className="py-10"
                  body="A version is kept when a new editing session starts and before every restore. Save one now to mark this moment."
                  action={<Button size="sm" onClick={() => void saveVersion()}>Save version</Button>} />
              ) : (
                <ul role="listbox" aria-label="Versions, newest first" className="space-y-0.5">
                  {versions.map((v) => (
                    <li key={v.id} role="presentation">
                      <button id={`dver-${v.id}`} role="option" aria-selected={v.id === selected} data-testid="doc-version-row"
                        onClick={() => { setSelected(v.id); setPhoneDetail(true); }}
                        className={cn("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                          v.id === selected ? "bg-[color-mix(in_srgb,var(--color-brand)_12%,transparent)]" : "hover:bg-hover")}>
                        <Avatar who={v.author} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-[13.5px]">
                            <span className={cn("truncate", v.name ? "font-semibold" : "font-medium")}>{v.name ?? whenLabel(v.savedAt)}</span>
                            {v.name && <IconBookmark className="h-3 w-3 shrink-0 text-brand" aria-label="Named" />}
                            {v.reason === "restore" && <span className="shrink-0 rounded-full bg-fill px-1.5 text-[11px] text-muted">Before restore</span>}
                          </div>
                          <div className="truncate text-[12px] text-subtle">{nameOf(v.author)}{v.name ? ` · ${whenLabel(v.savedAt)}` : ""} · {v.words} words</div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </nav>
            {/* The compare view */}
            <section aria-label="Compare with the page now" className={cn("min-w-0 flex-1 overflow-y-auto", !phoneDetail && "max-sm:hidden")}>
              {sel ? (
                <div className="flex min-h-full flex-col">
                  <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-elevated/95 px-5 py-3 backdrop-blur">
                    <button type="button" className="hidden rounded-full p-1.5 text-muted hover:bg-hover max-sm:grid max-sm:h-10 max-sm:w-10 max-sm:place-items-center" aria-label="Back to versions" onClick={() => setPhoneDetail(false)}><IconBack className="h-4 w-4" /></button>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-semibold">{sel.name ?? whenLabel(sel.savedAt)}</div>
                      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-subtle" data-testid="doc-version-counts">
                        <span className="max-sm:hidden">Compared with now:</span>
                        <span className="rounded-full bg-[color-mix(in_srgb,var(--color-ok)_14%,transparent)] px-1.5 font-medium text-ok">{counts.added} added</span>
                        <span className="rounded-full bg-[color-mix(in_srgb,var(--color-bad)_12%,transparent)] px-1.5 font-medium text-bad">{counts.removed} removed</span>
                        {detail.data?.sinceThen.titleChanged && <span>Title was “{detail.data.version.title}”</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-end">
                    <Button variant="ghost" size="sm" onClick={() => void rename(sel)}>{sel.name ? "Rename" : "Name"}</Button>
                    <Button size="sm" disabled={busy} onClick={() => void restore(sel)} data-testid="doc-version-restore"><IconUndo className="h-4 w-4" />Restore</Button>
                    </div>
                  </div>
                  <div className="px-5 py-4">
                    {detail.isPending ? <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-4" style={{ width: `${90 - i * 12}%` }} />)}</div> : <DiffView ops={ops} />}
                  </div>
                </div>
              ) : !list.isPending && (
                <p className="p-10 text-center text-[13px] text-subtle max-sm:hidden">Pick a version to see what changed since.</p>
              )}
            </section>
          </div>
        </div>
      )}
    </dialog>
  );
}

/** A drawn stack of pages with a clock, for the empty history. */
function HistoryArt() {
  return (
    <svg width="96" height="72" viewBox="0 0 96 72" fill="none" aria-hidden>
      <rect x="22" y="10" width="44" height="54" rx="7" fill="var(--color-fill)" />
      <rect x="28" y="4" width="44" height="54" rx="7" fill="var(--color-surface)" stroke="var(--color-line)" />
      <rect x="35" y="14" width="24" height="4" rx="2" fill="var(--color-line)" />
      <rect x="35" y="23" width="30" height="3" rx="1.5" fill="var(--color-line)" />
      <rect x="35" y="30" width="26" height="3" rx="1.5" fill="var(--color-line)" />
      <circle cx="68" cy="50" r="14" fill="color-mix(in srgb, var(--color-brand) 16%, var(--color-surface))" stroke="var(--color-brand)" strokeWidth="2" />
      <path d="M68 43v7l5 3" stroke="var(--color-brand)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

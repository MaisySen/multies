/**
 * R32: the selection bar on top of the mail list ("3 selected"), with Archive, Snooze, Move to, Mark read,
 * Mark unread and Delete for every selected conversation, and the checkbox each row shows on hover and on every
 * row once anything is selected. The page (webmail.tsx) owns the selection and runs the actions with Undo.
 */
import { useEffect, useRef } from "react";
import { AlarmClock, Archive, Ban, Check, FolderInput, Inbox, Mail, MailOpen, Trash2, X } from "lucide-react";
import { cn } from "@/web/lib/cn";
import type { BulkCall } from "@/web/lib/mail-selection";
import { moveTargets, useProviderFolders } from "./provider-folders";

type Act = (call: Omit<BulkCall, "ids">, label?: string) => void;

export function RowCheck({ checked, visible, label, onToggle }: { checked: boolean; visible: boolean; label: string; onToggle: (shift: boolean) => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} data-testid="mail-select"
      onClick={(e) => { e.stopPropagation(); onToggle(e.shiftKey); }}
      className={cn(
        "absolute left-1 top-3 z-[1] inline-flex h-6 w-6 items-center justify-center rounded-md transition-opacity duration-150 motion-reduce:transition-none focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60",
        visible || checked ? "opacity-100" : "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100",
      )}>
      <span className={cn("inline-flex h-4 w-4 items-center justify-center rounded-[5px] border transition-colors duration-150 motion-reduce:transition-none", checked ? "border-brand bg-brand text-brand-fg" : "border-line-strong bg-surface")}>
        {checked && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
      </span>
    </button>
  );
}

function BarBtn({ label, hint, onClick, children, danger }: { label: string; hint?: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={hint ? `${label} (${hint})` : label} aria-label={label}
      className={cn("inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 [&_svg]:h-4 [&_svg]:w-4", danger ? "hover:text-bad" : "hover:text-fg")}>
      {children}
    </button>
  );
}

const SNOOZE = [
  { preset: "later_today", label: "Later today" },
  { preset: "tomorrow", label: "Tomorrow" },
  { preset: "next_week", label: "Next week" },
] as const;

export function SnoozePresets({ onPick, onClose }: { onPick: (p: (typeof SNOOZE)[number]["preset"]) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc, true); };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" aria-label="Snooze until" data-testid="bulk-snooze-menu"
      className="absolute left-0 top-10 z-20 w-44 rounded-xl border border-line bg-surface p-1 shadow-lg">
      {SNOOZE.map((s) => (
        <button key={s.preset} type="button" role="menuitem" onClick={() => onPick(s.preset)}
          className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-hover focus:bg-hover focus:outline-none">{s.label}</button>
      ))}
    </div>
  );
}

export function BulkBar({ count, total, folder, connectionId, snoozeOpen, setSnoozeOpen, onAct, onSelectAll, onClear, more }: {
  count: number; total: number; folder: string; connectionId?: string | null;
  snoozeOpen: boolean; setSnoozeOpen: (v: boolean) => void;
  onAct: Act; onSelectAll: () => void; onClear: () => void;
  /** R33: more rows than are loaded. `offer` picks every one of them (one server job); `chosen` says it is picked. */
  more?: { all: boolean; offer: string; chosen: string; onAll: () => void };
}) {
  const { data } = useProviderFolders(connectionId);
  const remote = connectionId ? moveTargets(data, null).filter((t) => t.key.startsWith("f:")) : [];
  const standard = [{ key: "inbox", label: "Inbox" }, { key: "archive", label: "Archive" }, { key: "spam", label: "Spam" }].filter((t) => t.key !== folder);
  const inTrash = folder === "trash";
  return (
    <div role="toolbar" aria-label={`${count} selected`} data-testid="bulk-bar"
      className="sticky top-0 z-10 flex items-center gap-1 border-b border-line bg-surface/95 px-2 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-surface/80 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150">
      <BarBtn label="Clear selection" hint="Esc" onClick={onClear}><X /></BarBtn>
      <span className="min-w-0 truncate px-1 text-[13px] font-medium text-fg" aria-live="polite" data-testid="bulk-count">{more?.all ? more.chosen : `${count} selected`}</span>
      {!more?.all && count < total && <button type="button" onClick={onSelectAll} className="rounded-md px-1.5 py-0.5 text-[12.5px] text-brand hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">Select all {total}</button>}
      {more && !more.all && count >= total && <button type="button" onClick={more.onAll} data-testid="bulk-select-everything" className="rounded-md px-1.5 py-0.5 text-[12.5px] text-brand hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">{more.offer}</button>}
      <div className="ml-auto flex items-center gap-0.5">
        {folder === "archive" ? <BarBtn label="Move to Inbox" hint="E" onClick={() => onAct({ action: "inbox" })}><Inbox /></BarBtn>
          : <BarBtn label="Archive" hint="E" onClick={() => onAct({ action: "archive" })}><Archive /></BarBtn>}
        <div className="relative">
          <BarBtn label="Snooze" hint="H" onClick={() => setSnoozeOpen(!snoozeOpen)}><AlarmClock /></BarBtn>
          {snoozeOpen && <SnoozePresets onClose={() => setSnoozeOpen(false)} onPick={(preset) => { setSnoozeOpen(false); onAct({ action: "snooze", preset }); }} />}
        </div>
        <label className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg focus-within:ring-2 focus-within:ring-brand/60" title="Move to">
          <FolderInput className="h-4 w-4" aria-hidden />
          <select aria-label="Move to" value="" data-testid="bulk-move"
            onChange={(e) => {
              const to = e.target.value;
              if (!to) return;
              const label = [...standard, ...remote].find((t) => t.key === to)?.label;
              if (to.startsWith("f:")) onAct({ action: "move", to }, label);
              else onAct({ action: to as "inbox" | "archive" | "spam" });
            }}
            className="absolute inset-0 cursor-pointer opacity-0">
            <option value="">Move to</option>
            {standard.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            {remote.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        {folder !== "spam" && <BarBtn label="Report spam" onClick={() => onAct({ action: "spam" })}><Ban /></BarBtn>}
        <BarBtn label="Mark read" hint="U" onClick={() => onAct({ action: "read" })}><MailOpen /></BarBtn>
        <BarBtn label="Mark unread" onClick={() => onAct({ action: "unread" })}><Mail /></BarBtn>
        <BarBtn label={inTrash ? "Delete forever" : "Delete"} hint="#" danger onClick={() => onAct({ action: inTrash ? "delete" : "trash" })}><Trash2 /></BarBtn>
      </div>
    </div>
  );
}

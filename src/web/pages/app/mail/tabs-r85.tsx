/**
 * R85: Inbox tab style (Important and Other, Primary, Updates and Promotions, or no tabs), moving a thread to a tab
 * (menu, or drag a row onto a tab) which teaches its sender with Undo, and thread labels (chips and the Labels list).
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconClose, IconMove, IconTag } from "@/web/components/ui/icon";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { Popover } from "@/web/components/ui/popover";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { LABEL_MAX, TAB_STYLE_LABEL, TAB_STYLES, type TabStyle } from "@/shared/mail-rules-r85";
import type { SplitTab } from "@/shared/mail-splits";

/** The drag payload a mail row carries (its message id). */
export const MAIL_DRAG_TYPE = "application/x-multies-mail";
const STYLE_HINT: Record<TabStyle, string> = {
  classic: "Mail from people, then everything else.",
  categories: "People, then receipts and alerts, then offers and newsletters.",
  off: "One Inbox with everything in it.",
};

export interface TabSettings { style: TabStyle; chosen: boolean; defaultTab: string; senders: { address: string; tab: string }[] }
const settingsKey = ["mail", "tab-settings"] as const;

export function useTabSettings(enabled = true) {
  return useQuery({ queryKey: settingsKey, enabled, queryFn: () => api.get<TabSettings>("/mail/splits/settings"), staleTime: 60_000 });
}

/** Remembers which tab Inbox opens on, so the first list read needs no wait for the tabs. */
const DEFAULT_KEY = "multies:mail-default-tab";
export function storedDefaultTab(): string {
  try { return localStorage.getItem(DEFAULT_KEY) ?? "important"; } catch { return "important"; }
}
export function storeDefaultTab(id: string) {
  try { localStorage.setItem(DEFAULT_KEY, id); } catch { /* private mode */ }
}

/** Tab style choice and the senders the person has sorted, inside the Inbox tabs sheet. */
export function TabStyleSection({ tabs }: { tabs: SplitTab[] }) {
  const qc = useQueryClient();
  const s = useTabSettings();
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"] });
  const style = useMutation({
    mutationFn: (v: TabStyle) => api.put<TabSettings>("/mail/splits/style", { style: v }),
    onSuccess: (r) => { storeDefaultTab(r.defaultTab); toast.success(r.style === "off" ? "Inbox tabs are off" : `Tabs: ${TAB_STYLE_LABEL[r.style]}`); void refresh(); },
    onError: (e) => showError(e),
  });
  const forget = useMutation({
    mutationFn: (address: string) => api.post<TabSettings>("/mail/splits/pins/restore", { sender: address, senderTab: null }),
    onSuccess: () => { toast.success("Sender forgotten"); void refresh(); },
    onError: (e) => showError(e),
  });
  const name = (id: string) => tabs.find((t) => t.id === id)?.name ?? id;
  const current = s.data?.style;
  return (
    <div className="space-y-4" data-testid="tab-style">
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium">Tab style</legend>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tab style">
          {TAB_STYLES.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={current === v} disabled={!s.data || style.isPending} onClick={() => style.mutate(v)} data-testid={`tab-style-${v}`}
              className={cn("min-h-11 rounded-xl border p-3 text-left text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60",
                current === v ? "border-brand bg-brand-soft text-fg" : "border-line bg-surface hover:border-line-strong")}>
              <span className="block font-medium">{TAB_STYLE_LABEL[v]}</span>
              <span className="mt-0.5 block text-[12px] text-subtle">{STYLE_HINT[v]}</span>
            </button>
          ))}
        </div>
      </fieldset>
      {current !== "off" && (
        <div>
          <h3 className="mb-1 text-[13px] font-medium">Sorted by you</h3>
          {!s.data ? <div className="h-10 animate-pulse rounded-lg bg-fill" /> : s.data.senders.length === 0
            ? <p className="text-[13px] text-subtle">Move a message to a tab, from its toolbar or by dragging it onto the tab, and mail from that sender goes there next time.</p>
            : (
              <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-xl border border-line" aria-label="Senders you sorted">
                {s.data.senders.map((x) => (
                  <li key={x.address} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                    <span className="min-w-0 flex-1 truncate">{x.address}</span>
                    <span className="shrink-0 text-subtle">{name(x.tab)}</span>
                    <button type="button" onClick={() => forget.mutate(x.address)} className="grid h-8 w-8 place-items-center rounded-md text-subtle hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11" aria-label={`Forget ${x.address}`}><IconClose className="h-4 w-4" /></button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </div>
  );
}

/** Moves a thread to a tab and teaches its sender; the toast offers Undo. */
export function useTeachTab() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { messageId: string; tab: SplitTab }) => api.post<{ tab: string; threadId: string; sender: string | null; previous: { thread: string | null; sender?: string | null } }>("/mail/splits/teach", { messageId: v.messageId, tab: v.tab.id }),
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: ["mail"] });
      toast.success(`Moved to ${v.tab.name}`, {
        description: r.sender ? `New mail from ${r.sender} goes there too.` : undefined,
        action: {
          label: "Undo",
          onClick: () => {
            void api.post("/mail/splits/pins/restore", { threadId: r.threadId, thread: r.previous.thread, ...(r.sender ? { sender: r.sender, senderTab: r.previous.sender ?? null } : {}) })
              .then(() => { toast.success("Put back"); void qc.invalidateQueries({ queryKey: ["mail"] }); }, (e) => showError(e));
          },
        },
      });
    },
    onError: (e) => showError(e),
  });
}

/** "Move to tab" in the reader toolbar (works on a phone and from the keyboard, where dragging doesn't). */
export function MoveToTabMenu({ messageId, tabs, current }: { messageId: string; tabs: SplitTab[]; current?: string }) {
  const teach = useTeachTab();
  if (!tabs.length) return null;
  return (
    <Menu label="Move to tab" sheet trigger={
      <button type="button" className="grid place-items-center rounded-md p-2 text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11 max-sm:rounded-full" title="Move to tab" data-testid="move-to-tab">
        <IconMove className="h-4 w-4 max-sm:h-5 max-sm:w-5" />
      </button>}>
      <MenuLabel>Move to tab</MenuLabel>
      {tabs.map((t) => (
        <MenuItem key={t.id} checked={t.id === current} onSelect={() => { if (t.id !== current) teach.mutate({ messageId, tab: t }); }}>{t.name}</MenuItem>
      ))}
    </Menu>
  );
}

/** Label chips on a row or in the reader; with onRemove each chip has a remove button. */
export function LabelChips({ labels, onRemove, className }: { labels?: string[]; onRemove?: (l: string) => void; className?: string }) {
  if (!labels?.length) return null;
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-1", className)}>
      {labels.map((l) => (
        <span key={l} className="inline-flex max-w-[10rem] items-center gap-0.5 rounded-md bg-fill px-1.5 text-[11px] leading-5 text-muted" data-testid="mail-label">
          <IconTag className="h-3 w-3 shrink-0" aria-hidden /><span className="truncate">{l}</span>
          {onRemove && <button type="button" onClick={() => onRemove(l)} className="-mr-0.5 grid h-4 w-4 place-items-center rounded hover:text-fg" aria-label={`Remove label ${l}`}><IconClose className="h-3 w-3" /></button>}
        </span>
      ))}
    </span>
  );
}

export function useLabels(enabled = true) {
  return useQuery({ queryKey: ["mail", "labels"], enabled, queryFn: async () => (await api.get<{ labels: { label: string; threads: number }[] }>("/mail/labels")).labels, staleTime: 60_000 });
}

/** Add or remove a label on a thread, from the reader. */
export function useLabelEdit() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ["mail"] });
  const add = useMutation({ mutationFn: (v: { threadId: string; label: string }) => api.post("/mail/labels", v), onSuccess: () => { toast.success("Label added"); void done(); }, onError: (e) => showError(e) });
  const remove = useMutation({ mutationFn: (v: { threadId: string; label: string }) => api.del(`/mail/labels?${new URLSearchParams(v)}`), onSuccess: () => { toast.success("Label removed"); void done(); }, onError: (e) => showError(e) });
  return { add, remove };
}

/** The reader's label button: tick existing labels or name a new one. */
export function LabelMenu({ threadId, labels }: { threadId: string; labels: string[] }) {
  const all = useLabels();
  const { add, remove } = useLabelEdit();
  const [name, setName] = useState("");
  const names = [...new Set([...(all.data ?? []).map((l) => l.label), ...labels])].sort();
  const submit = (e: FormEvent) => { e.preventDefault(); const l = name.trim(); if (l) { add.mutate({ threadId, label: l }); setName(""); } };
  return (
    <Popover label="Labels" align="end" testId="label-menu" className="w-64 p-3"
      button={() => <span className="grid place-items-center rounded-md p-2 text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11 max-sm:rounded-full" title="Labels"><IconTag className="h-4 w-4 max-sm:h-5 max-sm:w-5" /></span>}>
      {names.length > 0 && (
        <ul className="mb-2 max-h-48 space-y-0.5 overflow-y-auto" aria-label="Labels">
          {names.map((l) => {
            const on = labels.includes(l);
            return (
              <li key={l}>
                <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1.5 text-[13px] hover:bg-hover max-sm:min-h-11">
                  <input type="checkbox" checked={on} onChange={() => (on ? remove : add).mutate({ threadId, label: l })} className="h-4 w-4 accent-[var(--color-brand)]" />
                  <span className="truncate">{l}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={submit} className="flex gap-1.5">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LABEL_MAX} placeholder="New label" aria-label="New label"
          className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-[13px] outline-none focus:border-brand/60 focus:ring-4 focus:ring-brand/10 max-sm:h-11" />
        <button type="submit" disabled={!name.trim()} className="h-9 rounded-lg bg-brand px-3 text-[13px] font-medium text-white disabled:opacity-50 max-sm:h-11">Add</button>
      </form>
    </Popover>
  );
}

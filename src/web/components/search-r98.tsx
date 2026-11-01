/**
 * R98 search in the command menu (SEARCH_R98): the filter row, instant top hits from the in memory index, the
 * "showing results for" line when the typo pass answered, and the empty, error and filter word states.
 */
import { useId, useRef, useState } from "react";
import { Command } from "cmdk";
import { IconBoardFolder, IconCalendar, IconClose, IconContacts, IconDocs, IconFile, IconHash, IconMessageCircle, IconSearch, IconStickyNote, IconTasks, IconUser, IconBriefcase, IconInbox, IconAttachment, IconZap, IconCheck, IconChevronDown } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { DATE_LABEL, TYPE_CHOICES, hasFilters, type DateChoice, type Filters, type IndexEntry, type TypeChoice } from "@/web/lib/search-r98";

export const R98_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  mail: IconInbox, tasks: IconTasks, docs: IconDocs, chat: IconMessageCircle, contacts: IconContacts, deals: IconBriefcase, attachments: IconAttachment,
  files: IconFile, notes: IconStickyNote, projects: IconBoardFolder, channels: IconHash,
};

const chip = "inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium transition-colors duration-150 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand max-sm:h-9 max-sm:px-3 max-sm:text-[13px]";
const chipOff = "border-line text-muted hover:bg-hover hover:text-fg";
const chipOn = "border-brand/40 bg-brand/10 text-fg";

interface Choice { value: string; label: string }

/** Whether a filter list is open: the menu ignores the Escape that closes the list (the dialog hears it first). */
export const filterMenuState = { open: false };
const markClosed = () => { setTimeout(() => { filterMenuState.open = false; }, 0); };

/**
 * A chip that opens a small list inside the menu (a listbox, not a native select, so the menu keeps one text box).
 * Keyboard: Enter, Space or Down opens it; arrows, Home and End move; Enter picks; Esc or Tab closes.
 */
function MenuChip({ label, icon: Icon, choices, value, active, onChange, testId }: { label: string; icon: React.ComponentType<{ className?: string }>; choices: Choice[]; value: string; active: boolean; onChange: (v: string) => void; testId: string }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = choices.find((c) => c.value === value) ?? choices[0];
  const show = () => {
    const b = btn.current;
    const dlg = b?.closest("[role=dialog]");
    if (!b || !dlg) return;
    const r = b.getBoundingClientRect(), d = dlg.getBoundingClientRect();
    const top = r.bottom - d.top + 4;
    setPos({ left: Math.max(8, Math.min(r.left - d.left, d.width - 248)), top, maxH: Math.max(140, Math.min(280, window.innerHeight - r.bottom - 16)) });
    setHi(Math.max(0, choices.findIndex((c) => c.value === value)));
    setOpen(true);
    filterMenuState.open = true;
  };
  const close = (refocus = true) => { setOpen(false); markClosed(); if (refocus) btn.current?.focus(); };
  const pick = (v: string) => { onChange(v); close(); };
  return (
    <>
      <button ref={btn} type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={`${label}: ${current.label}`}
        data-testid={testId} onMouseDown={(e) => e.preventDefault()} onClick={() => (open ? close() : show())}
        onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); show(); } }}
        className={cn(chip, active ? chipOn : chipOff)}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="max-w-[9rem] truncate">{active ? current.label : label}</span>
        <IconChevronDown className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
      </button>
      {open && pos && (
        <div role="listbox" id={listId} aria-label={label} tabIndex={-1} aria-activedescendant={`${listId}-${hi}`} data-testid={`${testId}-list`}
          ref={(el) => { if (el && document.activeElement !== el && !el.contains(document.activeElement)) el.focus(); }}
          style={{ left: pos.left, top: pos.top, maxHeight: pos.maxH }}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setOpen(false); markClosed(); } }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(choices.length - 1, h + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
            else if (e.key === "Home") { e.preventDefault(); setHi(0); }
            else if (e.key === "End") { e.preventDefault(); setHi(choices.length - 1); }
            else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(choices[hi].value); }
            else if (e.key === "Escape") { e.preventDefault(); close(); }
            else if (e.key === "Tab") close(false);
          }}
          className="absolute z-20 w-60 overflow-y-auto overscroll-contain rounded-lg border border-line-strong bg-surface p-1 shadow-pop outline-none animate-fade-in motion-reduce:animate-none max-sm:w-[min(15rem,calc(100vw-40px))]">
          {choices.map((c, i) => (
            <div key={c.value || "none"} id={`${listId}-${i}`} role="option" aria-selected={c.value === value}
              onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHi(i)} onClick={() => pick(c.value)}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-fg max-sm:min-h-[40px]", i === hi && "bg-hover")}>
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              {c.value === value && <IconCheck className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function FilterBar({ filters, onChange, people, projects, notes, problems }: {
  filters: Filters; onChange: (f: Filters) => void; people: { id: string; name: string }[]; projects: { id: string; name: string }[]; notes: boolean; problems: string[];
}) {
  const types = TYPE_CHOICES.filter((t) => t.id !== "notes" || notes);
  const set = (p: Partial<Filters>) => onChange({ ...filters, ...p });
  return (
    <div className="border-b border-line" data-testid="search-filters">
      <div role="toolbar" aria-label="Search filters" className="flex items-center gap-1.5 overflow-x-auto px-3 py-2 [scrollbar-width:none] max-sm:gap-2">
        <div role="radiogroup" aria-label="Type" className="flex items-center gap-1.5 max-sm:gap-2">
          {types.map((t, i) => (
            <button key={t.id} type="button" role="radio" aria-checked={filters.type === t.id} onMouseDown={(e) => e.preventDefault()} onClick={() => set({ type: t.id as TypeChoice })}
              title={`${t.label} (Alt ${i + 1})`} data-testid={`search-type-${t.id}`} className={cn(chip, filters.type === t.id ? chipOn : chipOff)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-line" aria-hidden />
        <MenuChip label="Person" icon={IconUser} testId="search-filter-person" active={!!filters.person} value={filters.person?.id ?? ""}
          choices={[{ value: "", label: "Anyone" }, ...(filters.person && !people.some((p) => p.id === filters.person!.id) ? [{ value: filters.person.id, label: filters.person.name }] : []), ...people.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => { const p = people.find((x) => x.id === v); set({ person: p ? { id: p.id, name: p.name } : null }); }} />
        <MenuChip label="Date" icon={IconCalendar} testId="search-filter-date" active={filters.date !== "any"} value={filters.date}
          choices={(Object.keys(DATE_LABEL) as DateChoice[]).filter((d) => d !== "custom" || filters.date === "custom").map((d) => ({ value: d, label: d === "custom" ? customLabel(filters) : DATE_LABEL[d] }))}
          onChange={(v) => set({ date: v as DateChoice, from: null, to: null })} />
        <MenuChip label="Project" icon={IconBoardFolder} testId="search-filter-project" active={!!filters.project} value={filters.project?.id ?? ""}
          choices={[{ value: "", label: "Any project" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => { const p = projects.find((x) => x.id === v); set({ project: p ? { id: p.id, name: p.name } : null }); }} />
        {hasFilters(filters) && (
          <button type="button" onClick={() => onChange({ type: "all", person: null, project: null, date: "any" })} data-testid="search-clear-filters"
            className={cn(chip, "border-transparent text-subtle hover:bg-hover hover:text-fg")}>
            <IconClose className="h-3.5 w-3.5" aria-hidden />Clear
          </button>
        )}
      </div>
      {problems.length > 0 && <p className="px-4 pb-2 text-xs text-subtle" role="status" data-testid="search-filter-problem">{problems.join(". ")}</p>}
    </div>
  );
}

function customLabel(f: Filters) {
  if (f.from && f.to) return `${f.from} to ${f.to}`;
  if (f.from) return `After ${f.from}`;
  if (f.to) return `Before ${f.to}`;
  return DATE_LABEL.custom;
}

const groupClass = "px-1.5 pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle";

/** Instant results from the index in this tab: they show while the server is still looking. */
export function TopHits({ hits, search, onOpen }: { hits: IndexEntry[]; search: string; onOpen: (url: string, title: string) => void }) {
  if (!hits.length) return null;
  return (
    <Command.Group heading={<span className="flex items-center gap-1.5"><IconZap className="h-3 w-3" aria-hidden />Top hits</span>} forceMount className={groupClass} data-testid="search-top-hits">
      {hits.map((h) => {
        const Icon = R98_ICONS[h.type] ?? IconSearch;
        return (
          <Command.Item key={`top:${h.type}:${h.id}`} value={`top ${h.type} ${h.id}`} keywords={[search]} forceMount onSelect={() => onOpen(h.url, h.title)}
            data-testid="search-top-hit" data-url={h.url}
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13.5px] text-muted data-[selected=true]:bg-hover data-[selected=true]:text-fg max-sm:min-h-[44px]">
            <Icon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-fg" title={h.title}>{h.title}</span>
            <span className="max-w-[45%] shrink-0 truncate text-xs text-subtle">{h.subtitle}</span>
          </Command.Item>
        );
      })}
    </Command.Group>
  );
}

/** "Showing results for invoice. Search for invoce instead": the typo pass answered. */
export function Corrected({ corrected, typed, onStrict }: { corrected: string; typed: string; onStrict: () => void }) {
  return (
    <p className="px-4 pt-2 pb-1 text-xs text-subtle" data-testid="search-corrected">
      Showing results for <span className="font-medium text-fg">{corrected}</span>.{" "}
      <button type="button" onClick={onStrict} className="text-brand-hover underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Search for “{typed}” instead</button>
    </p>
  );
}

/** R110 (R98 low): a bad filter (422) says so plainly instead of the generic line. */
export function searchErrorText(error?: unknown): string {
  const e = error as { status?: number } | null | undefined;
  return e && e.status === 422 ? "That filter is not valid. Change it and try again." : "Search is not answering right now. Commands below still work.";
}

export function SearchError({ onRetry, error }: { onRetry: () => void; error?: unknown }) {
  const bad = (error as { status?: number } | null | undefined)?.status === 422;
  return (
    <div role="alert" className="mx-3 my-2 flex items-center gap-2 rounded-lg border border-line bg-subtle/5 px-3 py-2 text-[13px] text-muted" data-testid="search-error">
      <span className="min-w-0 flex-1">{searchErrorText(error)}</span>
      {!bad && <button type="button" onClick={onRetry} className="shrink-0 rounded-md px-2 py-1 font-medium text-brand-hover hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand max-sm:min-h-[40px]">Try again</button>}
    </div>
  );
}

export function NoResults({ search, filtered, onClear }: { search: string; filtered: boolean; onClear: () => void }) {
  return (
    <div className="px-4 py-8 text-center text-sm text-muted" data-testid="search-empty">
      <p className="font-medium text-fg">No results for “{search}”</p>
      <p className="mt-1 text-xs text-subtle">{filtered ? "Nothing matches with these filters." : "Check the spelling, or try fewer words."} You only see what you can open.</p>
      {filtered && <button type="button" onClick={onClear} className="mt-3 rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-fg hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand max-sm:min-h-[40px]">Clear filters</button>}
    </div>
  );
}

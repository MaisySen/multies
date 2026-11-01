/**
 * R98 search in the command menu (SEARCH_R98): the filter row, instant top hits from the in memory index, the
 * "showing results for" line when the typo pass answered, and the empty, error and filter word states.
 */
import { Command } from "cmdk";
import { IconBoardFolder, IconCalendar, IconClose, IconContacts, IconDocs, IconFile, IconHash, IconMessageCircle, IconSearch, IconStickyNote, IconTasks, IconUser, IconBriefcase, IconInbox, IconAttachment, IconZap } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { DATE_LABEL, TYPE_CHOICES, hasFilters, type DateChoice, type Filters, type IndexEntry, type TypeChoice } from "@/web/lib/search-r98";

export const R98_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  mail: IconInbox, tasks: IconTasks, docs: IconDocs, chat: IconMessageCircle, contacts: IconContacts, deals: IconBriefcase, attachments: IconAttachment,
  files: IconFile, notes: IconStickyNote, projects: IconBoardFolder, channels: IconHash,
};

const chip = "inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium transition-colors duration-150 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand max-sm:h-9 max-sm:px-3 max-sm:text-[13px]";
const chipOff = "border-line text-muted hover:bg-hover hover:text-fg";
const chipOn = "border-brand/40 bg-brand/10 text-fg";

/** A native select dressed as a chip: keyboard and phone friendly, and screen readers name it. */
function SelectChip({ label, icon: Icon, value, active, onChange, children, testId }: { label: string; icon: React.ComponentType<{ className?: string }>; value: string; active: boolean; onChange: (v: string) => void; children: React.ReactNode; testId: string }) {
  return (
    <label className={cn(chip, "relative cursor-pointer", active ? chipOn : chipOff)} data-testid={testId}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()}
        className="max-w-[9.5rem] cursor-pointer appearance-none truncate bg-transparent pr-0.5 text-inherit outline-none [&>option]:bg-surface [&>option]:text-fg">
        {children}
      </select>
    </label>
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
        <SelectChip label="Person" icon={IconUser} testId="search-filter-person" active={!!filters.person} value={filters.person?.id ?? ""}
          onChange={(v) => { const p = people.find((x) => x.id === v); set({ person: p ? { id: p.id, name: p.name } : null }); }}>
          <option value="">Anyone</option>
          {filters.person && !people.some((p) => p.id === filters.person!.id) && <option value={filters.person.id}>{filters.person.name}</option>}
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectChip>
        <SelectChip label="Date" icon={IconCalendar} testId="search-filter-date" active={filters.date !== "any"} value={filters.date}
          onChange={(v) => set({ date: v as DateChoice, from: null, to: null })}>
          {(Object.keys(DATE_LABEL) as DateChoice[]).filter((d) => d !== "custom" || filters.date === "custom").map((d) => (
            <option key={d} value={d}>{d === "custom" ? customLabel(filters) : DATE_LABEL[d]}</option>
          ))}
        </SelectChip>
        <SelectChip label="Project" icon={IconBoardFolder} testId="search-filter-project" active={!!filters.project} value={filters.project?.id ?? ""}
          onChange={(v) => { const p = projects.find((x) => x.id === v); set({ project: p ? { id: p.id, name: p.name } : null }); }}>
          <option value="">Any project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectChip>
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
      <button type="button" onClick={onStrict} className="text-brand underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Search for “{typed}” instead</button>
    </p>
  );
}

export function SearchError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="mx-3 my-2 flex items-center gap-2 rounded-lg border border-line bg-subtle/5 px-3 py-2 text-[13px] text-muted" data-testid="search-error">
      <span className="min-w-0 flex-1">Search is not answering right now. Commands below still work.</span>
      <button type="button" onClick={onRetry} className="shrink-0 rounded-md px-2 py-1 font-medium text-brand hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand max-sm:min-h-[40px]">Try again</button>
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

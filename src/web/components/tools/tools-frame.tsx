/**
 * R69: one frame for every Tools screen that is its own page (Edit pages, Fill a form, Compare, Share links, Sign,
 * AI helpers, Workflows, Document templates, Mail merge), so they look and move like the tool screens on /app/tools:
 * on a wide screen the same rail of every tool on the left, on a phone a clear "All tools" link; a card with the tool's
 * own icon, name, one line and the runs left line. The list and features come from the shared GET /api/tools cache.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { IconArrowLeft, IconSearch } from "@/web/components/ui/icon";
import { tz } from "@/web/lib/format";
import { SECTIONS, buildEntries, noRunsLine, rememberRecent, resetWhen, runsLeft, runsLeftLabel, searchEntries, type Entry } from "./tool-directory";
import { ToolIcon } from "./tool-icon";
import { useToolsInfo } from "./use-tools-info";

const ring = "outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

/** Where an entry opens: its own page, or its screen on /app/tools. */
export const entryHref = (e: Entry) => e.to ?? `/app/tools?op=${encodeURIComponent(e.key)}`;

/** The runs left pill, the same words and colours as the tool screens. Null until GET /api/tools answers. */
/** R69: one plain line when the runs are used up, so nobody finds out only after pressing Save. */
export function NoRunsNote() {
  const info = useToolsInfo();
  const limits = info.data?.limits;
  const left = limits && info.data ? runsLeft(info.data.usage, limits) : null;
  if (!left || left.left > 0) return null;
  return <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-fg" role="status" data-testid="tools-no-runs">{noRunsLine(left, tz())} You can still open files and look; saving a new file needs a run.</p>;
}

export function RunsLeftPill({ className = "" }: { className?: string }) {
  const info = useToolsInfo();
  const limits = info.data?.limits;
  const left = limits && info.data ? runsLeft(info.data.usage, limits) : null;
  if (!left) return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-2.5 py-1 text-[12.5px] text-muted tabular-nums ${className}`}
      title={`Up to ${limits?.runsDaily} runs a day and ${limits?.runsMonthly} a month. ${left.per === "day" ? "Today's" : "This month's"} runs come back ${resetWhen(left, tz())}.`} data-testid="tools-usage">
      <span className={`h-1.5 w-1.5 rounded-full ${left.left === 0 ? "bg-bad" : left.left < 5 ? "bg-warn" : "bg-ok"}`} aria-hidden />
      {runsLeftLabel(left)}
    </span>
  );
}

/** The rail of every tool, for wide screens. */
function ToolsRail({ entries, active }: { entries: Entry[]; active: string }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const found = searchEntries(entries, query);
  const open = (e: Entry) => { rememberRecent(e.key); navigate(entryHref(e)); };
  return (
    <nav className="hidden lg:block" aria-label="All tools" data-testid="tools-rail">
      <div className="sticky top-2 max-h-[calc(100dvh-5rem)] space-y-2 overflow-y-auto pb-6 pr-1">
        <Link to="/app/tools" className={`flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-muted hover:text-fg ${ring}`} data-testid="tools-back-rail"><IconArrowLeft className="h-3.5 w-3.5" aria-hidden />All tools</Link>
        <label className="relative block">
          <span className="sr-only">Search tools</span>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tools" data-testid="tools-search-rail"
            onKeyDown={(e) => { if (e.key === "Enter" && found[0]) open(found[0]); if (e.key === "Escape") setQuery(""); }}
            className={`h-9 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-[14px] placeholder:text-subtle ${ring}`} />
        </label>
        {found.length ? SECTIONS.map((s) => {
          const list = found.filter((e) => e.section === s);
          if (!list.length) return null;
          return (
            <section key={s} aria-labelledby={`frame-sec-${s}`}>
              <h2 id={`frame-sec-${s}`} className="mb-1 mt-3 px-2 text-[11.5px] font-semibold uppercase tracking-wide text-subtle">{s}</h2>
              <div className="space-y-0.5">
                {list.map((e) => (
                  <Link key={e.key} to={entryHref(e)} onClick={() => rememberRecent(e.key)} aria-current={e.key === active ? "page" : undefined} data-testid={`rail-${e.key}`}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13.5px] transition-colors ${ring} ${e.key === active ? "bg-brand/10 font-semibold text-fg" : "text-fg/85 hover:bg-hover"}`}>
                    <ToolIcon e={e} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  </Link>
                ))}
              </div>
            </section>
          );
        }) : <p className="px-2 py-3 text-[13px] text-muted">No tool matches.</p>}
      </div>
    </nav>
  );
}

/**
 * The frame. `entryKey` is the tool's key in the Tools list (an op such as "organize", or a page such as "share");
 * `fallback` gives the icon and section while the list loads or when the entry is not in it.
 */
export function ToolsFrame({ entryKey, title, description, testId, actions, usage = true, wide, children }: {
  entryKey: string; title: string; description: ReactNode; testId?: string; actions?: ReactNode; usage?: boolean; wide?: boolean; children: ReactNode;
}) {
  const info = useToolsInfo();
  const entries = useMemo(() => buildEntries(info.data?.tools ?? [], info.data?.features ?? []), [info.data]);
  const entry = entries.find((e) => e.key === entryKey);
  return (
    <div className={`mx-auto w-full ${wide ? "max-w-7xl" : "max-w-6xl"} px-4 pb-8 pt-4 sm:px-6 sm:pt-6`} data-testid={testId}>
      <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-6">
        <ToolsRail entries={entries} active={entryKey} />
        <div className="min-w-0 space-y-5">
          <Link to="/app/tools" className={`-mb-2 flex min-h-11 w-fit items-center gap-1.5 rounded-lg pr-2 text-[14px] font-medium text-brand-hover lg:hidden ${ring}`} data-testid="tools-back"><IconArrowLeft className="h-4 w-4" aria-hidden />All tools</Link>
          <header className="flex items-start gap-3.5" data-testid="tools-frame-header">
            {entry ? <ToolIcon e={entry} size="lg" /> : <span className="h-11 w-11 shrink-0 rounded-xl bg-fill" aria-hidden />}
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
              <p className="mt-1 text-[14px] text-muted max-sm:line-clamp-2">{description}</p>
              {usage && <RunsLeftPill className="mt-2 sm:hidden" />}
            </div>
            {(actions || usage) && <div className="flex shrink-0 items-center gap-2 max-sm:hidden">{usage && <RunsLeftPill />}{actions}</div>}
          </header>
          {actions && <div className="flex flex-wrap items-center gap-2 sm:hidden">{actions}</div>}
          {usage && <NoRunsNote />}
          {children}
        </div>
      </div>
    </div>
  );
}

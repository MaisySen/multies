/**
 * OPS1: tabs for console pages. Two modes, one look:
 *
 * Path mode, one address per tab (/console/workspaces/:id/:tab?):
 *   const tabs = [{ id: "overview", label: "Overview" }, { id: "billing", label: "Billing", permission: "billing.read" }];
 *   const tab = useDetailTab(tabs);                      // the current tab id (first tab when the address has none)
 *   <DetailTabs tabs={tabs} base={`/console/workspaces/${id}`} />
 *   {tab === "billing" && <BillingTab id={id} />}
 *
 * Query mode, the tab in ?tab= (list pages with several lists, and detail pages whose path has no tab segment):
 *   const tab = useQueryTab(TABS);
 *   <QueryTabs tabs={TABS} label="Mail sections" testIdPrefix="console-mail-tab" keep={["orgId"]} />
 *   <TabPanel tabs={TABS} current={tab}>{tab === "domains" && <DomainsTab />}</TabPanel>
 * The first tab has no ?tab= at all. Switching tab starts that tab's list afresh: every other query parameter (search,
 * filters, sort, cursor) is dropped except the ones named in `keep` (a workspace scope, say).
 * Query mode is an ARIA tablist (role tab, aria-selected, arrow keys, Home and End move between tabs); each tab is
 * still a link, so it can be opened in a new tab or copied.
 *
 * In both modes tabs whose permission the role lacks are hidden; an address naming one falls back to the first tab.
 * The bar scrolls sideways on its own at phone width.
 */
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Link, NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import { cn } from "@/web/lib/cn";
import type { Permission } from "@/shared/operator-permissions";
import { useConsoleMe } from "../guard";

export interface DetailTab { id: string; label: string; permission?: Permission; /** Shown after the label (a count). */ badge?: ReactNode }

function visible<T extends DetailTab>(tabs: readonly T[], permissions: readonly Permission[]) {
  return tabs.filter((t) => !t.permission || permissions.includes(t.permission));
}

const tabClass = (on: boolean) => cn(
  "-mb-px inline-flex h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
  on ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg",
);

// ---------------------------------------------------------------- path mode

export function useDetailTab(tabs: DetailTab[]): string {
  const { tab } = useParams();
  const me = useConsoleMe();
  const shown = visible(tabs, me.permissions);
  return shown.find((t) => t.id === tab)?.id ?? shown[0]?.id ?? "";
}

export function DetailTabs({ tabs, base }: { tabs: DetailTab[]; base: string }) {
  const me = useConsoleMe();
  const current = useDetailTab(tabs);
  const shown = visible(tabs, me.permissions);
  return (
    <nav aria-label="Sections" className="mb-5 overflow-x-auto border-b border-line">
      <ul className="flex min-w-max gap-1">
        {shown.map((t, i) => (
          <li key={t.id}>
            <NavLink to={i === 0 ? base : `${base}/${t.id}`} replace aria-current={current === t.id ? "page" : undefined} className={tabClass(current === t.id)}>
              {t.label}{t.badge}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------- query mode

/** The current tab from ?tab= among the tabs this role may see (the first one when there is none or it is unknown). */
export function useQueryTab<T extends DetailTab>(tabs: readonly T[]): T["id"] {
  const [params] = useSearchParams();
  const me = useConsoleMe();
  const shown = visible(tabs, me.permissions);
  const asked = params.get("tab");
  return (shown.find((t) => t.id === asked)?.id ?? shown[0]?.id ?? "") as T["id"];
}

/** The address of a tab: only `keep` parameters carry over, and the first tab has no ?tab=. */
export function queryTabSearch(params: URLSearchParams, id: string, first: boolean, keep: readonly string[] = []): string {
  const next = new URLSearchParams();
  for (const k of keep) for (const v of params.getAll(k)) next.append(k, v);
  if (!first) next.set("tab", id);
  const s = next.toString();
  return s ? `?${s}` : "";
}

const tabDomId = (prefix: string, id: string) => `${prefix}-${id}`;

export function QueryTabs<T extends DetailTab>({ tabs, label = "Sections", testIdPrefix, keep, className }: {
  tabs: readonly T[];
  /** The tablist's accessible name. */
  label?: string;
  /** Each tab gets data-testid `${testIdPrefix}-${id}` (and the same DOM id, used by TabPanel). */
  testIdPrefix: string;
  /** Query parameters kept when switching tab (everything else resets). */
  keep?: readonly string[];
  className?: string;
}) {
  const me = useConsoleMe();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const current = useQueryTab(tabs);
  const shown = visible(tabs, me.permissions);
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  const href = (t: T) => ({ search: queryTabSearch(params, t.id, t.id === shown[0]?.id, keep) });
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const last = shown.length - 1;
    const to = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (to < 0) return;
    e.preventDefault();
    refs.current[to]?.focus();
    navigate(href(shown[to]!), { replace: true });
  };
  return (
    <div className={cn("overflow-x-auto border-b border-line", className)}>
      <ul role="tablist" aria-label={label} className="flex min-w-max gap-1">
        {shown.map((t, i) => {
          const on = t.id === current;
          return (
            <li key={t.id} role="presentation">
              <Link
                ref={(el) => { refs.current[i] = el; }}
                to={href(t)} replace role="tab" id={tabDomId(testIdPrefix, t.id)} aria-selected={on} aria-current={on ? "page" : undefined}
                aria-controls={`${testIdPrefix}-panel`} tabIndex={on ? 0 : -1} onKeyDown={(e) => onKeyDown(e, i)}
                data-testid={`${testIdPrefix}-${t.id}`} className={tabClass(on)}
              >
                {t.label}{t.badge}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The panel under QueryTabs, labelled by the current tab. Remounts on a tab change so each tab starts fresh. */
export function TabPanel({ testIdPrefix, current, children, className, testId }: { testIdPrefix: string; current: string; children: ReactNode; className?: string; testId?: string }) {
  return (
    <div key={current} role="tabpanel" id={`${testIdPrefix}-panel`} aria-labelledby={tabDomId(testIdPrefix, current)} className={className} data-testid={testId}>
      {children}
    </div>
  );
}

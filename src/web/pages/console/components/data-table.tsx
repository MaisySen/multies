/**
 * OPS1: the one list for the operator console: search, filter chips and sort in the address bar, a table, and
 * Load more (keyset pages from the server's { items, nextCursor }). Loading, empty and error states are built in.
 *
 * Usage:
 *   <DataTable<Workspace>
 *     label="Workspaces" path="/workspaces"                       // GET /api/console/workspaces
 *     search={{ placeholder: "Search workspaces" }}
 *     filters={[{ key: "plan", label: "Plan", options: [{ value: "", label: "Any" }, { value: "pro", label: "Pro" }] }]}
 *     defaultSort="createdAt:desc"
 *     columns={[
 *       { key: "name", header: "Name", cell: (w) => w.name, sort: "name" },
 *       { key: "owner", header: "Owner", cell: (w) => w.ownerEmail, secondary: true },   // hidden below sm
 *       { key: "created", header: "Created", cell: (w) => <RelTime at={w.createdAt} />, sort: "createdAt", align: "right" },
 *     ]}
 *     rowKey={(w) => w.id} rowHref={(w) => `/console/workspaces/${w.id}`}
 *     empty={{ title: "No workspaces match", body: "Try another search or clear the filters." }}
 *   />
 *
 * `params` adds fixed query values (not shown in the address bar). `actions` renders beside the filters.
 * `empty.action` replaces the empty card's "Clear search and filters" button (pass null for no button, say when the
 * toolbar already offers the same thing). `embedded` is for a table that is one section of a page: its empty state is
 * the one-line EmptyRow instead of the big card. When the server answers `recentOnly` (an unscoped list over a busy
 * table that only looked at its newest rows), one quiet line under the table says so (`recentNote` rewords it).
 * On phones the table keeps `minWidth` (default 560 px) and scrolls sideways inside its own box, so cells never squash;
 * mark less important columns `secondary` to hide them below sm. The first click on a sortable column sorts text
 * columns A to Z and date or number columns newest or largest first (`sortFirst` overrides).
 * Errors show the server's own message at once; a 403 reads "You don't have access to this page" (LoadError).
 *
 * Hand-built console tables: use `consoleTable` below for the same scroll box, minimum width and secondary columns;
 * `<table {...tableProps(420)}>` picks another minimum width (0 for none).
 */
import type { CSSProperties, ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { consoleApi, consoleKeys } from "@/web/lib/console-api";
import { Button } from "@/web/components/ui/button";
import { Card, EmptyState, tableStyles as T } from "@/web/components/ui/misc";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { IconChevronDown, IconChevronUp, IconSearch } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { FilterBar, filterQuery, useUrlParams, type FilterDef } from "./filter-bar";
import { EmptyRow, LoadError } from "./states";

/** The minimum width a console table keeps on phones before it scrolls sideways in its own box. */
export const TABLE_MIN_WIDTH = 560;

/** Class names for a hand-built console table: the same look, scroll box and phone behaviour as DataTable. */
export const consoleTable = {
  ...T,
  /**
   * The scroll box. `relative` keeps absolutely positioned bits inside the table (an sr-only header, say) in the box:
   * without it they escape the box's clipping and widen the whole page on phones.
   */
  wrap: cn(T.wrap, "relative"),
  /** The table itself, TABLE_MIN_WIDTH wide at least so it scrolls in its box (T.wrap) instead of squashing on phones. */
  table: cn(T.table, "min-w-[560px]"),
  /** Add to the th and td of a column that can go on phones. */
  secondary: "hidden sm:table-cell",
};

/** The props for a hand-built console table with its own minimum width in px (0 for none): `<table {...tableProps(420)}>`. */
export function tableProps(minWidth: number = TABLE_MIN_WIDTH, className?: string): { className: string; style?: CSSProperties } {
  return { className: cn(T.table, className), style: minWidth ? { minWidth } : undefined };
}

/** The line under a list that only looked at the newest rows of a busy table. */
export const RECENT_ONLY_NOTE = "Showing recent activity only. Pick a workspace to see older rows.";

/** Sort fields that read best biggest or newest first on the first click. */
const DESC_FIRST = /(At|Date|date|count|Count|score|attempts|failures|days|Days|amount|Amount|size|rows|total)$/;

/** The direction a sortable column sorts on its first click. */
export function firstSortDir(c: { sort?: string; align?: "left" | "right"; sortFirst?: "asc" | "desc" }): "asc" | "desc" {
  return c.sortFirst ?? (c.align === "right" || DESC_FIRST.test(c.sort ?? "") ? "desc" : "asc");
}

export interface DataColumn<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** The server's sort field; makes the header a sort button. */
  sort?: string;
  align?: "left" | "right";
  className?: string;
  /** Hidden below sm (phones) to keep the table readable. */
  secondary?: boolean;
  /** The direction of the first click on this column's sort. Default: asc for text, desc for dates and numbers. */
  sortFirst?: "asc" | "desc";
}

export function DataTable<T>({ label, path, columns, rowKey, rowHref, filters = [], search, defaultSort, params, empty, actions, pageSize, minWidth = TABLE_MIN_WIDTH, embedded, recentNote = RECENT_ONLY_NOTE }: {
  label: string;
  path: string;
  columns: DataColumn<T>[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string;
  filters?: FilterDef[];
  search?: { placeholder: string };
  defaultSort?: string;
  params?: Record<string, string>;
  /** `action` replaces the default "Clear search and filters" button when filtered; null shows no button. */
  empty: { title: string; body: ReactNode; icon?: ReactNode; action?: ReactNode | null };
  actions?: ReactNode;
  pageSize?: number;
  /** The table's minimum width in px before it scrolls sideways in its box (0 for none). */
  minWidth?: number;
  /** The table is one section of a page: an empty list is the one-line EmptyRow (title and body), not the big card. */
  embedded?: boolean;
  /** The words under a list the server says looked only at recent rows. */
  recentNote?: ReactNode;
}) {
  const navigate = useNavigate();
  const url = useUrlParams(filters, { sort: defaultSort });
  const query: Record<string, string> = { ...(params ?? {}), ...(pageSize ? { limit: String(pageSize) } : {}), ...filterQuery(filters, url.values) };
  const list = useInfiniteQuery({
    queryKey: consoleKeys.list(path, query),
    queryFn: ({ pageParam }) => consoleApi.list<T>(path, { ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const recentOnly = list.data?.pages.some((p) => p.recentOnly) ?? false;
  const [sortField, sortDir] = (url.values.sort || defaultSort || "").split(":");
  const toggleSort = (c: DataColumn<T>) => {
    const field = c.sort!;
    const next = sortField === field ? (sortDir === "asc" ? "desc" : "asc") : firstSortDir(c);
    url.set("sort", `${field}:${next}`);
  };
  const filtered = !!url.values.q || filters.some((f) => (url.values[f.key] ?? "") !== (f.initial ?? ""));
  const emptyAction = empty.action !== undefined ? empty.action
    : filtered ? <Button variant="secondary" size={embedded ? "sm" : undefined} onClick={url.reset}>Clear search and filters</Button> : null;
  const note = recentOnly ? <p className="mt-2 text-xs text-subtle" data-testid="console-recent-only">{recentNote}</p> : null;

  return (
    <div>
      <FilterBar filters={filters} values={url.values} onChange={url.set} search={search}>{actions && <div className="flex items-center gap-2 sm:ml-auto">{actions}</div>}</FilterBar>
      {list.isPending ? (
        <SkeletonRows rows={6} label={`Loading ${label.toLowerCase()}`} />
      ) : list.error ? (
        <LoadError error={list.error} what={label.toLowerCase()} retry={() => void list.refetch()} />
      ) : !rows.length ? (
        <>
          {embedded ? (
            <EmptyRow icon={empty.icon} action={emptyAction ?? undefined}><span className="font-medium text-fg">{empty.title}</span> {empty.body}</EmptyRow>
          ) : (
            <Card className="p-0">
              <EmptyState icon={empty.icon ?? <IconSearch />} title={empty.title} body={empty.body} action={emptyAction ?? undefined} />
            </Card>
          )}
          {note}
        </>
      ) : (
        <>
          <div className={consoleTable.wrap} tabIndex={0} role="region" aria-label={label}>
            <table className={T.table} style={minWidth ? { minWidth } : undefined}>
              <thead className={T.head}>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} className={cn(T.th, c.align === "right" && "text-right", c.secondary && "hidden sm:table-cell", c.className)} aria-sort={c.sort && sortField === c.sort ? (sortDir === "asc" ? "ascending" : "descending") : undefined}>
                      {c.sort ? (
                        <button type="button" className="inline-flex items-center gap-1 hover:text-fg" onClick={() => toggleSort(c)}>
                          {c.header}
                          {sortField === c.sort && (sortDir === "asc" ? <IconChevronUp className="h-3.5 w-3.5" aria-hidden /> : <IconChevronDown className="h-3.5 w-3.5" aria-hidden />)}
                        </button>
                      ) : c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className={T.body}>
                {rows.map((r) => {
                  const href = rowHref?.(r);
                  return (
                    <tr key={rowKey(r)} className={cn(T.row, href && "cursor-pointer")} onClick={href ? (e) => { if (!(e.target as HTMLElement).closest("a,button,input,select,textarea,label")) navigate(href); } : undefined}>
                      {columns.map((c) => <td key={c.key} className={cn(T.td, c.align === "right" && "text-right", c.secondary && "hidden sm:table-cell", c.className)}>{c.cell(r)}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-subtle">
            <span className="tabular-nums">{rows.length} shown</span>
            {list.hasNextPage && <Button variant="secondary" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</Button>}
          </div>
          {note}
        </>
      )}
    </div>
  );
}

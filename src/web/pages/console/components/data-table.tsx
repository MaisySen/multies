/**
 * OPS1: the one list for the operator console: search, filter chips and sort in the address bar, a table, and
 * Load more (keyset pages from the server's { items, nextCursor }). Loading, empty and error states are built in.
 *
 * Usage:
 *   <DataTable<Workspace>
 *     label="Workspaces" path="/workspaces"                       // GET /api/console/workspaces
 *     search={{ placeholder: "Search by name, id or owner email" }}
 *     filters={[{ key: "plan", label: "Plan", options: [{ value: "", label: "Any" }, { value: "pro", label: "Pro" }] }]}
 *     defaultSort="createdAt:desc"
 *     columns={[
 *       { key: "name", header: "Name", cell: (w) => w.name, sort: "name" },
 *       { key: "created", header: "Created", cell: (w) => formatDate(w.createdAt), sort: "createdAt", align: "right" },
 *     ]}
 *     rowKey={(w) => w.id} rowHref={(w) => `/console/workspaces/${w.id}`}
 *     empty={{ title: "No workspaces match", body: "Try another search or clear the filters." }}
 *   />
 *
 * `params` adds fixed query values (not shown in the address bar). `actions` renders beside the filters.
 */
import type { ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { consoleApi, consoleKeys } from "@/web/lib/console-api";
import { errorMessage } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { Card, EmptyState, tableStyles as T } from "@/web/components/ui/misc";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { IconChevronDown, IconChevronUp, IconSearch, IconWarning } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { FilterBar, useUrlParams, type FilterDef } from "./filter-bar";

export interface DataColumn<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** The server's sort field; makes the header a sort button. */
  sort?: string;
  align?: "left" | "right";
  className?: string;
}

export function DataTable<T>({ label, path, columns, rowKey, rowHref, filters = [], search, defaultSort, params, empty, actions, pageSize }: {
  label: string;
  path: string;
  columns: DataColumn<T>[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string;
  filters?: FilterDef[];
  search?: { placeholder: string };
  defaultSort?: string;
  params?: Record<string, string>;
  empty: { title: string; body: ReactNode; icon?: ReactNode };
  actions?: ReactNode;
  pageSize?: number;
}) {
  const navigate = useNavigate();
  const url = useUrlParams(filters, { sort: defaultSort });
  const query: Record<string, string> = { ...(params ?? {}), ...(pageSize ? { limit: String(pageSize) } : {}) };
  for (const [k, v] of Object.entries(url.values)) if (v && v !== "all") query[k] = v;
  const list = useInfiniteQuery({
    queryKey: consoleKeys.list(path, query),
    queryFn: ({ pageParam }) => consoleApi.list<T>(path, { ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const [sortField, sortDir] = (url.values.sort || defaultSort || "").split(":");
  const toggleSort = (field: string) => url.set("sort", `${field}:${sortField === field && sortDir === "desc" ? "asc" : "desc"}`);
  const filtered = !!url.values.q || filters.some((f) => (url.values[f.key] ?? "") !== (f.initial ?? ""));

  return (
    <div>
      <FilterBar filters={filters} values={url.values} onChange={url.set} search={search}>{actions && <div className="flex items-center gap-2 sm:ml-auto">{actions}</div>}</FilterBar>
      {list.isPending ? (
        <SkeletonRows rows={6} label={`Loading ${label.toLowerCase()}`} />
      ) : list.error ? (
        <Card className="p-0">
          <EmptyState icon={<IconWarning />} title={`Couldn't load ${label.toLowerCase()}`} body={errorMessage(list.error)} action={<Button variant="secondary" onClick={() => void list.refetch()}>Try again</Button>} />
        </Card>
      ) : !rows.length ? (
        <Card className="p-0">
          <EmptyState icon={empty.icon ?? <IconSearch />} title={empty.title} body={empty.body}
            action={filtered ? <Button variant="secondary" onClick={url.reset}>Clear search and filters</Button> : undefined} />
        </Card>
      ) : (
        <>
          <div className={T.wrap} tabIndex={0} role="region" aria-label={label}>
            <table className={T.table}>
              <thead className={T.head}>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} className={cn(T.th, c.align === "right" && "text-right", c.className)} aria-sort={c.sort && sortField === c.sort ? (sortDir === "asc" ? "ascending" : "descending") : undefined}>
                      {c.sort ? (
                        <button type="button" className="inline-flex items-center gap-1 hover:text-fg" onClick={() => toggleSort(c.sort!)}>
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
                      {columns.map((c) => <td key={c.key} className={cn(T.td, c.align === "right" && "text-right", c.className)}>{c.cell(r)}</td>)}
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
        </>
      )}
    </div>
  );
}

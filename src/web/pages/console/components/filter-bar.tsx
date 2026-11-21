/**
 * OPS1: the search box and filter chips above a console list, kept in the address bar so a filtered list can be shared
 * and survives a reload.
 *
 * Usage (DataTable does this for you):
 *   const filters: FilterDef[] = [{ key: "status", label: "Status", options: [{ value: "all", label: "Any" }, { value: "suspended", label: "Suspended" }], initial: "all" }];
 *   const url = useUrlParams(filters);
 *   <FilterBar filters={filters} values={url.values} onChange={url.set} search={{ placeholder: "Search workspaces" }} />
 *
 * `initial` is the value used while the address has none (lists open on their most useful filter). "" means unset.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { ChipSelect } from "@/web/components/ui/chip-select";
import { Input } from "@/web/components/ui/input";
import { IconSearch } from "@/web/components/ui/icon";

export interface FilterOption { value: string; label: string }
export interface FilterDef { key: string; label: string; options: FilterOption[]; initial?: string }

/** Reads and writes q, sort and each filter in the address bar. */
export function useUrlParams(filters: FilterDef[] = [], defaults: { sort?: string } = {}) {
  const [params, setParams] = useSearchParams();
  const values = useMemo(() => {
    const out: Record<string, string> = { q: params.get("q") ?? "", sort: params.get("sort") ?? defaults.sort ?? "" };
    for (const f of filters) out[f.key] = params.get(f.key) ?? f.initial ?? "";
    return out;
  }, [params, filters, defaults.sort]);
  const set = (key: string, value: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === "" && !filters.find((f) => f.key === key)?.initial) next.delete(key); else next.set(key, value);
      return next;
    }, { replace: true });
  };
  /** Clears the search and puts every filter back to its initial value, in one address change. */
  const reset = () => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("q");
      for (const f of filters) next.delete(f.key);
      return next;
    }, { replace: true });
  };
  return { values, set, reset };
}

export function FilterBar({ filters = [], values, onChange, search, children }: {
  filters?: FilterDef[]; values: Record<string, string>; onChange: (key: string, value: string) => void;
  search?: { placeholder: string }; children?: React.ReactNode;
}) {
  const [q, setQ] = useState(values.q ?? "");
  useEffect(() => { setQ(values.q ?? ""); }, [values.q]);
  // A short pause after typing before the list reloads.
  useEffect(() => {
    if (q === (values.q ?? "")) return;
    const t = setTimeout(() => onChange("q", q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!search && !filters.length && !children) return null;
  return (
    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center" role="search">
      {search && (
        <div className="relative w-full sm:max-w-xs">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input type="search" aria-label={search.placeholder} placeholder={search.placeholder} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
      )}
      {filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {filters.map((f) => (
            <ChipSelect key={f.key} label={`${f.label}:`} active={!!values[f.key] && values[f.key] !== (f.initial ?? "") } value={values[f.key] ?? ""} onChange={(e) => onChange(f.key, e.target.value)} aria-label={f.label}>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </ChipSelect>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

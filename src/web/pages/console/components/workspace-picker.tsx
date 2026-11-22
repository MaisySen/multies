/**
 * OPS1: a list's workspace filter. Type part of a workspace's name (or an owner's email, or its id) and pick it from the
 * matches; the list then shows that workspace's rows. The pick lives in the address bar (`useWorkspaceParam`, ?orgId=
 * by default; Jobs keeps its ?workspace=), so on a fresh load the name is looked up again from the same search. Matches
 * come from GET /api/console/workspaces?q=. Once picked it is a chip with the name and an x ("Show every workspace").
 *
 *   const [orgId, setOrgId] = useWorkspaceParam();
 *   <DataTable ... params={orgId ? { orgId } : undefined} actions={<WorkspacePicker value={orgId} onChange={setOrgId} testIdPrefix="console-agents-workspace" />} />
 *
 * Test ids: `<prefix>` (the search box), `<prefix>-options`, `<prefix>-chip`, `<prefix>-clear`.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { consoleApi } from "@/web/lib/console-api";
import { Input } from "@/web/components/ui/input";
import { IconBuilding, IconClose, IconSearch } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";

interface WorkspaceMatch { id: string; name: string; ownerEmail: string | null }

const MAX_MATCHES = 8;

/** The workspaces whose name, owner or id contains `q` (nothing for an empty search). */
function useWorkspaceMatches(q: string) {
  return useQuery({
    queryKey: ["console", "list", "/workspaces", { q, limit: String(MAX_MATCHES) }, "picker"],
    queryFn: () => consoleApi.list<WorkspaceMatch>("/workspaces", { q, limit: String(MAX_MATCHES) }),
    enabled: q.length > 0,
    staleTime: 30_000,
  });
}

/** The chosen workspace's name, looked up by its id when the address bar is all we have. */
function useWorkspaceName(id: string, known: string | null) {
  const q = useWorkspaceMatches(known ? "" : id);
  if (!id) return null;
  if (known) return known;
  if (q.isPending) return null;
  return q.data?.items.find((w) => w.id === id)?.name ?? "Deleted workspace";
}

/** The picked workspace id in the address bar (`key`, default "orgId"), and a setter that keeps the other values. */
export function useWorkspaceParam(key = "orgId"): [string, (id: string) => void] {
  const [params, setParams] = useSearchParams();
  const set = (id: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id) next.set(key, id); else next.delete(key);
    return next;
  }, { replace: true });
  return [params.get(key) ?? "", set];
}

export function WorkspacePicker({ value, onChange, testIdPrefix = "console-jobs-workspace" }: { value: string; onChange: (id: string) => void; testIdPrefix?: string }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // A short pause after typing before searching.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => { setActive(0); }, [q]);
  // Close when focus or a click leaves the box.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const matches = useWorkspaceMatches(q);
  const items = q ? matches.data?.items ?? [] : [];
  const name = useWorkspaceName(value, picked?.id === value ? picked.name : null);

  const choose = (w: WorkspaceMatch) => {
    setPicked({ id: w.id, name: w.name });
    onChange(w.id);
    setText(""); setQ(""); setOpen(false);
  };
  const clear = () => {
    setPicked(null);
    onChange("");
    setTimeout(() => input.current?.focus(), 0);
  };

  if (value) {
    return (
      <span className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg bg-brand-soft pl-2.5 pr-1 text-[13px] text-brand-hover" data-testid={`${testIdPrefix}-chip`}>
        <span className="whitespace-nowrap">Workspace:</span>
        <span className="truncate font-medium text-fg" title={value}>{name ?? "Loading"}</span>
        <button type="button" onClick={clear} aria-label="Show every workspace" title="Show every workspace"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg" data-testid={`${testIdPrefix}-clear`}>
          <IconClose className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
    );
  }

  const showList = open && q.length > 0;
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, Math.max(0, items.length - 1))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && showList && items[active]) { e.preventDefault(); choose(items[active]!); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={box} className="relative w-full sm:w-56">
      <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
      <Input ref={input} type="search" role="combobox" aria-label="Workspace" aria-autocomplete="list" aria-expanded={showList} aria-controls={listId}
        aria-activedescendant={showList && items[active] ? `${listId}-${active}` : undefined}
        placeholder="Filter by workspace" value={text} autoComplete="off"
        onChange={(e) => { setText(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey}
        className="h-8 pl-8 text-[13px]" data-testid={testIdPrefix} />
      {showList && (
        <ul id={listId} role="listbox" aria-label="Matching workspaces" data-testid={`${testIdPrefix}-options`}
          className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-auto rounded-xl border border-line bg-surface py-1 shadow-lg sm:left-auto sm:w-72">
          {matches.isPending || q !== text.trim() ? (
            <li className="px-3 py-2 text-[13px] text-subtle">Searching</li>
          ) : matches.error ? (
            <li className="px-3 py-2 text-[13px] text-bad">Couldn't search workspaces</li>
          ) : !items.length ? (
            <li className="px-3 py-2 text-[13px] text-subtle">No workspace matches</li>
          ) : items.map((w, i) => (
            <li key={w.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); choose(w); }} onMouseEnter={() => setActive(i)}
              className={cn("flex cursor-pointer items-center gap-2.5 px-3 py-2 text-[13px]", i === active && "bg-hover")}>
              <IconBuilding className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-fg" title={w.id}>{w.name}</span>
                {w.ownerEmail && <span className="truncate text-xs text-subtle">{w.ownerEmail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

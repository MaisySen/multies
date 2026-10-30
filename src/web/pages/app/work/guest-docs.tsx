/**
 * R24 polish: the guest's view of a project's docs as a page tree, and "Linked from" under an open
 * doc. Both read the guest endpoints (/api/guest/r24/...), which only return this project's pages.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconChevronDown, IconChevronRight, IconDocs, IconLink } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows"; // R30

interface Node { id: string; title: string; children: Node[] }
interface Backlink { id: string; title: string; snippet: string }

function Row({ n, depth, openId, onOpen }: { n: Node; depth: number; openId: string | null; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const has = n.children.length > 0;
  return (
    <li role="treeitem" aria-expanded={has ? open : undefined} aria-selected={openId === n.id} aria-label={n.title || "Untitled"}>
      <div className={cn("flex items-center gap-1 rounded-md pr-2 hover:bg-hover", openId === n.id && "bg-fill/60")} style={{ paddingLeft: depth * 14 }}>
        {has
          ? <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? `Collapse ${n.title}` : `Expand ${n.title}`} className="rounded p-0.5 text-subtle hover:text-fg">{open ? <IconChevronDown className="h-3.5 w-3.5" /> : <IconChevronRight className="h-3.5 w-3.5" />}</button>
          : <span className="w-[18px]" aria-hidden />}
        <button type="button" onClick={() => onOpen(n.id)} className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-[13px]">
          <IconDocs className="h-3.5 w-3.5 shrink-0 text-muted" /><span className="truncate">{n.title || "Untitled"}</span>
        </button>
      </div>
      {has && open && <ul role="group">{n.children.map((c) => <Row key={c.id} n={c} depth={depth + 1} openId={openId} onOpen={onOpen} />)}</ul>}
    </li>
  );
}

/** The project's pages, nested. Falls back to the flat list if the tree can't be read. */
export function GuestDocTree({ docs, openId, onOpen }: { docs: { id: string; title: string }[]; openId: string | null; onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ["guest-doc-tree"], retry: false, queryFn: () => api.get<{ tree: Node[] }>("/guest/r24/docs/tree") });
  const tree: Node[] = q.data?.tree ?? docs.map((d) => ({ id: d.id, title: d.title, children: [] }));
  if (!tree.length) return null;
  return (
    <div className="mt-4" aria-label="Docs">
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">Docs</h2>
      <ul role="tree" aria-label="Pages" data-testid="guest-doc-tree">{tree.map((n) => <Row key={n.id} n={n} depth={0} openId={openId} onOpen={onOpen} />)}</ul>
    </div>
  );
}

/** Pages in this project that link to the open doc. */
export function GuestBacklinks({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ["guest-doc-backlinks", id], retry: false, queryFn: () => api.get<{ backlinks: Backlink[] }>(`/guest/r24/docs/${id}/backlinks`) });
  const list = q.data?.backlinks ?? [];
  return (
    <section className="mt-6 border-t border-line pt-4" aria-label="Linked from" data-testid="guest-backlinks">
      <h3 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle"><IconLink className="h-3.5 w-3.5" />Linked from</h3>
      {q.isPending ? <SkeletonRows rows={3} rowHeight={44} label="Loading docs" />
        : !list.length ? <p className="text-[13px] text-muted">No other page in this project links here yet.</p>
          : (
            <ul className="space-y-2">
              {list.map((b) => (
                <li key={b.id}>
                  <button type="button" onClick={() => onOpen(b.id)} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-hover">
                    <span className="flex items-center gap-2 text-[13px] font-medium"><IconDocs className="h-3.5 w-3.5 text-muted" />{b.title || "Untitled"}</span>
                    {b.snippet && <span className="mt-0.5 block truncate pl-5 text-[12.5px] text-muted">{b.snippet}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
    </section>
  );
}

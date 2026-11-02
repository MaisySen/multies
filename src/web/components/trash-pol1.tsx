/**
 * POL1 (MB-313): tables and courses move to the trash, with Undo in the toast and Restore from Docs > Trash for 30 days.
 * Behind the polishPol1 flag (the server also refuses while it is off). Copy: sentence case, no dashes.
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { queryRetry } from "@/web/lib/load-errors-t1g";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { useDialogs } from "@/web/components/ui/confirm";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { Skeleton } from "@/web/components/ui/misc";
import { LoadErrorInline } from "@/web/components/load-error-t1g";
import { IconBook, IconMore, IconTable, IconTrash, IconUndo } from "@/web/components/ui/icon";
import { useConfig } from "@/web/lib/queries";

export type TrashKind = "table" | "course";
interface TrashItem { id: string; title: string; kind: TrashKind; deletedAt: string }

export const usePolishOn = () => !!useConfig().data?.polishPol1;

const WORD: Record<TrashKind, string> = { table: "table", course: "course" };

/** The confirm text for each kind (tests read these). */
export function trashConfirm(kind: TrashKind, title: string, detail?: { rows?: number; learners?: number }) {
  const name = title.trim() || `this ${WORD[kind]}`;
  if (kind === "course") {
    const n = detail?.learners ?? 0;
    return {
      title: `Move ${name} to the trash?`,
      description: `${n ? `${n === 1 ? "1 learner loses" : `${n} learners lose`} access` : "Learners lose access"} and it leaves My learning. Their progress and certificates are kept, so restoring it within 30 days brings everything back.`,
      confirmLabel: "Move to trash",
    };
  }
  const rows = detail?.rows ?? 0;
  return {
    title: `Move ${name} to the trash?`,
    description: `${rows ? `Its ${rows === 1 ? "1 row" : `${rows.toLocaleString("en-AU")} rows`} and views go with it` : "Its rows and views go with it"}, and its forms stop taking answers. You can restore it from Docs, Trash within 30 days.`,
    confirmLabel: "Move to trash",
  };
}

function refreshDocs(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["docs"] });
  void qc.invalidateQueries({ queryKey: ["doc-tree"] });
  void qc.invalidateQueries({ queryKey: ["courses-list"] });
  void qc.invalidateQueries({ queryKey: ["my-learning"] });
  void qc.invalidateQueries({ queryKey: ["doc-trash"] });
}

export async function restoreDoc(qc: QueryClient, id: string): Promise<boolean> {
  try { await api.post(`/docs/${id}/restore`, {}); refreshDocs(qc); return true; } catch (e) { showError(e as Error); return false; }
}

/** "More" menu on a table or course page with Move to trash. Render {dialogs}. */
export function useTrashAction(kind: TrashKind, id: string, title: string, detail?: { rows?: number; learners?: number }) {
  const { confirm, dialogs } = useDialogs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!(await confirm({ ...trashConfirm(kind, title, detail), tone: "danger" }))) return;
    setBusy(true);
    try {
      await api.del(kind === "table" ? `/tables/${id}` : `/courses/${id}`);
      refreshDocs(qc);
      navigate("/app/docs");
      toast.success(kind === "table" ? "Table moved to the trash" : "Course moved to the trash", {
        duration: 10_000,
        action: { label: "Undo", onClick: () => void restoreDoc(qc, id).then((ok) => { if (ok) { toast.success("Restored"); navigate(`/app/docs/${id}`); } }) },
      });
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return { run, busy, dialogs };
}

export function MoreMenu({ label, onTrash, testId }: { label: string; onTrash: () => void; testId: string }) {
  return (
    <Menu align="end" label={label} trigger={<Button type="button" variant="ghost" size="sm" aria-label={label} data-testid={testId}><IconMore className="h-4 w-4" /></Button>}>
      <MenuItem icon={<IconTrash />} onSelect={onTrash} danger>Move to trash</MenuItem>
    </Menu>
  );
}

/** Docs > Trash: tables and courses deleted in the last 30 days that you may restore. Loaded only while open. */
export function TrashDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["doc-trash"], enabled: open, retry: queryRetry, queryFn: () => api.get<{ items: TrashItem[]; days: number }>("/docs/trash") });
  const [busy, setBusy] = useState<string | null>(null);
  const restore = async (it: TrashItem) => {
    setBusy(it.id);
    const ok = await restoreDoc(qc, it.id);
    setBusy(null);
    if (ok) { toast.success(`${it.title} is back`, { action: { label: "Open", onClick: () => navigate(`/app/docs/${it.id}`) } }); }
  };
  const items = q.data?.items ?? [];
  return (
    <Dialog open={open} onClose={onClose} title="Trash" description="Tables and courses deleted in the last 30 days. Restore brings back the rows, lessons and learners' progress."
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div data-testid="doc-trash">
        {q.isPending ? <div className="space-y-2" aria-busy="true"><Skeleton className="h-11" /><Skeleton className="h-11" /></div>
          : q.error ? <LoadErrorInline onRetry={() => q.refetch()} />
          : !items.length ? <p className="py-6 text-center text-[13px] text-muted" data-testid="doc-trash-empty">Nothing in the trash. Deleted tables and courses show here for 30 days.</p>
          : (
            <ul className="divide-y divide-line">
              {items.map((it) => (
                <li key={it.id} className="flex min-h-12 items-center gap-3 py-2" data-testid="doc-trash-item">
                  <span className="text-muted [&_svg]:h-4 [&_svg]:w-4" aria-hidden="true">{it.kind === "table" ? <IconTable /> : <IconBook />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-fg">{it.title}</span>
                    <span className="block text-[12px] text-subtle">{it.kind === "table" ? "Table" : "Course"} · deleted {new Date(it.deletedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
                  </span>
                  <Button size="sm" variant="secondary" loading={busy === it.id} onClick={() => void restore(it)} aria-label={`Restore ${it.title}`}><IconUndo className="h-4 w-4" />Restore</Button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </Dialog>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconFolderCog, IconProject, IconRefresh } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";

/** A connected mailbox's folders at its provider (round 19), as GET /api/connections/:id/folders answers. */
export interface ProviderFolder { key: string; path: string; name: string; role: string | null; synced: boolean }
export interface ProviderFolders { folders: ProviderFolder[]; maxExtra: number }

export const folderKey = (path: string) => `f:${path}`;

export function useProviderFolders(connectionId: string | null | undefined) {
  return useQuery({
    queryKey: ["mail", "provider-folders", connectionId],
    enabled: !!connectionId,
    staleTime: 5 * 60_000,
    queryFn: () => api.get<ProviderFolders>(`/connections/${connectionId}/folders`),
  });
}

/** Where a message can be moved: the provider's standard folders and the person's synced own folders. */
export function moveTargets(data: ProviderFolders | undefined, currentKey: string | null | undefined) {
  const labels: Record<string, string> = { inbox: "Inbox", archive: "Archive", spam: "Spam", trash: "Trash" };
  const out: { key: string; label: string }[] = [];
  for (const f of data?.folders ?? []) {
    if (f.role && labels[f.role]) out.push({ key: f.role, label: labels[f.role] });
    else if (!f.role && f.synced) out.push({ key: f.key, label: f.path });
  }
  return out.filter((t) => t.key !== currentKey);
}

/** The sidebar section: the person's own folders that sync, and a list to choose them. */
export function ProviderFolderNav({ connectionId, current, onPick }: { connectionId: string; current: string; onPick: (key: string) => void }) {
  const qc = useQueryClient();
  const [choosing, setChoosing] = useState(false);
  const { data } = useProviderFolders(connectionId);
  const toggle = useMutation({
    mutationFn: (b: { path: string; sync: boolean }) => api.put<ProviderFolders>(`/connections/${connectionId}/folders`, b),
    onSuccess: (r) => { qc.setQueryData(["mail", "provider-folders", connectionId], r); void qc.invalidateQueries({ queryKey: ["mail", "list"] }); },
    onError: (e) => { void qc.invalidateQueries({ queryKey: ["mail", "provider-folders", connectionId] }); showError(e); },
  });
  const refresh = useMutation({
    mutationFn: () => api.get<ProviderFolders>(`/connections/${connectionId}/folders?refresh=1`),
    onSuccess: (r) => qc.setQueryData(["mail", "provider-folders", connectionId], r),
    onError: (e) => showError(e),
  });
  // The box ticks at once and stays ticked while the server answers (a refetch meanwhile can't untick it).
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const setSync = (path: string, sync: boolean) => {
    setPending((p) => ({ ...p, [path]: sync }));
    toggle.mutate({ path, sync }, { onSettled: () => setPending((p) => { const n = { ...p }; delete n[path]; return n; }) });
  };
  const own = (data?.folders ?? []).filter((f) => !f.role);
  const synced = own.filter((f) => f.synced);
  return (
    <div className="mt-4" data-testid="provider-folders">
      <div className="flex items-center justify-between px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-subtle">
        <span>Your folders</span>
        <button type="button" onClick={() => setChoosing((v) => !v)} aria-expanded={choosing} aria-label="Choose folders to sync" title="Choose folders to sync"
          className="rounded p-1 text-subtle hover:bg-hover hover:text-fg"><IconFolderCog className="h-3.5 w-3.5" /></button>
      </div>
      {synced.map((f) => (
        <button key={f.key} type="button" onClick={() => onPick(f.key)} aria-current={current === f.key ? "page" : undefined}
          className={cn("flex w-full items-center gap-2.5 truncate rounded-lg px-2.5 py-1.5 text-left text-[13.5px] transition-colors", current === f.key ? "bg-fill font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
          <IconProject className="h-4 w-4 shrink-0" /><span className="truncate">{f.path}</span>
        </button>
      ))}
      {!synced.length && !choosing && <p className="px-2.5 text-[12px] text-subtle">{own.length ? "Choose folders from your provider to see them here." : "No other folders at your provider."}</p>}
      {choosing && (
        <div className="mt-1 rounded-xl border border-line bg-elevated p-2" data-testid="provider-folder-chooser">
          <p className="px-1 pb-1.5 text-[12px] text-muted">Sync up to {data?.maxExtra ?? 10} of your own folders. Inbox, Sent, Archive, Drafts, Spam and Trash always sync.</p>
          <ul className="max-h-56 space-y-0.5 overflow-y-auto">
            {own.map((f) => (
              <li key={f.key}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-hover">
                  <input type="checkbox" className="h-4 w-4 accent-[#0071E3]" checked={pending[f.path] ?? f.synced}
                    onChange={(e) => setSync(f.path, e.target.checked)} />
                  <span className="truncate">{f.path}</span>
                </label>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}
            className="mt-1.5 flex items-center gap-1.5 px-1 text-[12px] text-brand hover:underline disabled:opacity-60">
            <IconRefresh className={cn("h-3.5 w-3.5", refresh.isPending && "animate-spin")} />Refresh the list
          </button>
        </div>
      )}
    </div>
  );
}

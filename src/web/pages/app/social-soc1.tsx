/**
 * SOC1: several Facebook Pages (and LinkedIn company Pages where LinkedIn granted access) per workspace, behind the
 * flag SOCIAL_MULTI_SOC1. The Page picker (search, select all, long names truncated, 100 plus Pages), the chosen Pages
 * under each login on the Accounts page, and the honest LinkedIn state.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { useConfig } from "@/web/lib/queries";
import { Badge, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Input } from "@/web/components/ui/input";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { IconLayers, IconRefresh, IconSearch, IconTrash, IconWarning } from "@/web/components/ui/icon";
import type { ConnectedAccountView } from "@/shared/integrations";
import { filterPages, SOC1_COPY, type Soc1AvailableView, type Soc1PageView } from "@/shared/social-soc1";
import { ReconnectButton } from "./apps-social";

export const useSoc1On = () => !!useConfig().data?.socialMultiSoc1;
export const pagesKey = ["social", "pages"] as const;

export function useSocialPages(enabled: boolean) {
  return useQuery({ queryKey: pagesKey, queryFn: () => api.get<{ pages: Soc1PageView[] }>("/apps/pages").then((r) => r.pages), enabled, staleTime: 30_000 });
}

/** A Page's round picture, or the network's logo when it has none (or it fails to load). */
export function PagePicture({ url, name, size = "md" }: { url: string | null; name: string; size?: "sm" | "md" }) {
  const [failed, setFailed] = useState(false);
  const dims = size === "sm" ? "h-7 w-7" : "h-9 w-9";
  if (!url || failed) {
    return <span className={cn("grid shrink-0 place-items-center rounded-full bg-fill text-[12px] font-semibold text-muted", dims)} aria-hidden>{name.trim().charAt(0).toUpperCase() || "P"}</span>;
  }
  return <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={cn("shrink-0 rounded-full border border-line object-cover", dims)} aria-hidden />;
}

/** The picker: every Page the login can reach, searchable; Save sets which ones this workspace posts to. */
export function PagePicker({ account, open, onClose }: { account: ConnectedAccountView; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const isLinkedIn = account.app === "linkedin";
  const what = isLinkedIn ? "company Pages" : "Pages";
  const avail = useQuery({
    queryKey: ["social", "pages", "available", account.id],
    queryFn: () => api.get<Soc1AvailableView>(`/apps/accounts/${encodeURIComponent(account.id)}/pages`),
    enabled: open, retry: false, staleTime: 0,
  });
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string> | null>(null);
  useEffect(() => { if (!open) { setSel(null); setQ(""); } }, [open]);
  useEffect(() => {
    if (open && avail.data && sel === null) setSel(new Set(avail.data.pages.filter((p) => p.added && !p.addedElsewhere).map((p) => p.id)));
  }, [open, avail.data, sel]);
  const postable = useMemo(() => (avail.data?.pages ?? []).filter((p) => p.canPost), [avail.data]);
  const shown = useMemo(() => filterPages(postable, q), [postable, q]);
  const cantPost = (avail.data?.pages ?? []).length - postable.length;
  const chosen = sel ?? new Set<string>();
  const allShown = shown.length > 0 && shown.every((p) => chosen.has(p.id) || p.addedElsewhere);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s ?? []); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSel((s) => { const n = new Set(s ?? []); for (const p of shown) { if (p.addedElsewhere) continue; if (allShown) n.delete(p.id); else n.add(p.id); } return n; });
  const save = useMutation({
    mutationFn: () => api.put<{ pages: Soc1PageView[] }>(`/apps/accounts/${encodeURIComponent(account.id)}/pages`, { pageIds: [...chosen] }),
    onSuccess: (r) => {
      const mine = r.pages.filter((p) => p.viaAccountId === account.id).length;
      toast.success(mine ? `${mine} ${mine === 1 ? what.replace(/s$/, "") : what} ready to post` : `No ${what} chosen for this login`);
      qc.setQueryData(pagesKey, r.pages);
      void qc.invalidateQueries({ queryKey: ["social", "health"] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't save your Pages. Try again.")),
  });
  const title = `Choose ${what}`;
  const loginName = account.name ?? account.label ?? account.appName;
  return (
    <Dialog open={open} onClose={onClose} title={title} description={`Pick the ${what} ${loginName} manages that this workspace posts to. Each one shows as its own account when you write a post.`}
      footer={avail.data && !avail.data.needsApproval && (avail.data.pages.length > 0) ? (
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] text-muted" data-testid="pages-count" aria-live="polite">{chosen.size} chosen</span>
          <div className="flex gap-2 max-sm:w-full">
            <Button variant="outline" onClick={onClose} className="max-sm:flex-1">Cancel</Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} className="max-sm:flex-1" data-testid="pages-save">Save</Button>
          </div>
        </div>
      ) : undefined}>
      <div data-testid="page-picker" className="min-w-0">
        {avail.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label={`Loading ${what}`}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
        ) : avail.error ? (
          <div className="rounded-lg border border-line p-4 text-[13.5px]" role="alert" data-testid="pages-error">
            <p className="flex items-start gap-2"><IconWarning className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden /><span className="min-w-0">{errorMessage(avail.error, `Couldn't load your ${what}.`)}</span></p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void avail.refetch()}><IconRefresh className="h-4 w-4" aria-hidden />Retry</Button>
              <ReconnectButton accountId={account.id} appName={account.appName} />
            </div>
          </div>
        ) : avail.data?.needsApproval ? (
          <p className="rounded-lg bg-fill px-3 py-3 text-[13.5px] text-muted" data-testid="pages-needs-approval">{SOC1_COPY.orgNeedsApprovalLong}</p>
        ) : !avail.data?.pages.length ? (
          <p className="rounded-lg bg-fill px-3 py-3 text-[13.5px] text-muted" data-testid="pages-empty">{isLinkedIn ? "No company Pages found for this login. Pages you administer on LinkedIn show here." : SOC1_COPY.noPagesFound}</p>
        ) : (
          <>
            {!!avail.data.lost.length && (
              <div className="mb-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-[13px]" data-testid="pages-lost" role="status">
                <p className="text-warn">This login lost access to {avail.data.lost.map((p) => p.name).join(", ")}. Reconnect to post there again, or save to stop using {avail.data.lost.length === 1 ? "it" : "them"}.</p>
              </div>
            )}
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
              <Input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${postable.length.toLocaleString()} ${what}`} aria-label={`Search ${what}`} className="pl-9" data-testid="pages-search" />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 px-1">
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[13.5px] font-medium sm:min-h-9">
                <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={allShown} onChange={toggleAll} disabled={!shown.length} data-testid="pages-select-all" />
                {q.trim() ? `Select all ${shown.length.toLocaleString()} found` : "Select all"}
              </label>
              {avail.data.truncated && <span className="text-[12px] text-subtle">Showing the first {avail.data.pages.length.toLocaleString()}. Search to find more.</span>}
            </div>
            <ul className="mt-1 max-h-[min(52vh,420px)] divide-y divide-line overflow-y-auto overscroll-contain rounded-lg border border-line" data-testid="pages-list" aria-label={what}>
              {shown.length === 0 && <li className="px-3 py-4 text-[13.5px] text-muted">No {what} match “{q.trim()}”.</li>}
              {shown.map((p) => (
                <li key={p.id}>
                  <label className={cn("flex min-h-12 items-center gap-3 px-3 py-2 text-[13.5px]", p.addedElsewhere ? "cursor-default" : "cursor-pointer hover:bg-hover")} title={p.name} data-testid="pages-row">
                    <input type="checkbox" className="h-4 w-4 shrink-0 accent-[var(--color-brand)]" checked={p.addedElsewhere || chosen.has(p.id)} disabled={p.addedElsewhere} onChange={() => toggle(p.id)} aria-label={p.name} />
                    <PagePicture url={p.pictureUrl} name={p.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{p.name}</span>
                      {p.addedElsewhere && <span className="block truncate text-[12px] text-muted">Added through another login</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {cantPost > 0 && <p className="mt-2 px-1 text-[12px] text-subtle">{cantPost === 1 ? "1 Page" : `${cantPost.toLocaleString()} Pages`} you can only view are not listed. Posting needs a Page role that can create content.</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Under a Facebook (or LinkedIn) login on the Accounts page: its chosen Pages, Choose Pages, and Remove per Page. */
export function LoginPages({ account, pages, health, canManage, autoOpen }: {
  account: ConnectedAccountView; pages: Soc1PageView[] | undefined; health: Map<string, { ok: boolean; code: string | null; text: string | null }> | undefined; canManage: boolean; autoOpen?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<Soc1PageView | null>(null);
  useEffect(() => { if (autoOpen && canManage) setOpen(true); }, [autoOpen, canManage]);
  const isLinkedIn = account.app === "linkedin";
  const mine = (pages ?? []).filter((p) => p.viaAccountId === account.id);
  const remove = useMutation({
    mutationFn: (p: Soc1PageView) => api.del<{ ok: true }>(`/apps/pages/${encodeURIComponent(p.key)}`),
    onSuccess: (_r, p) => { toast.success(`${p.name} removed`); setRemoving(null); void qc.invalidateQueries({ queryKey: pagesKey }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't remove that Page. Try again.")),
  });
  if (isLinkedIn && !account.companyPages) {
    return <p className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted" data-testid="linkedin-org-state"><Badge tone="neutral">{SOC1_COPY.orgNeedsApproval}</Badge></p>;
  }
  if (account.status !== "active") return null;
  const what = isLinkedIn ? "company Pages" : "Pages";
  return (
    <div className="mt-2 basis-full" data-testid={`login-pages-${account.app}`}>
      {pages === undefined ? <Skeleton className="h-9 rounded-lg" />
        : mine.length === 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="login-pages-none">{isLinkedIn ? "No company Pages chosen yet" : SOC1_COPY.noPagesYet}{!isLinkedIn ? ". Posts go to the Page picked in each post until you choose." : "."}</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label={`${what} of ${account.name ?? account.appName}`}>
            {mine.map((p) => {
              const h = health?.get(p.key);
              const lost = p.state === "lost" || (h && !h.ok && h.code !== "check_failed");
              return (
                <li key={p.key} className="flex items-center gap-3 px-3 py-2" data-testid="login-page" data-state={lost ? "lost" : "ok"}>
                  <PagePicture url={p.pictureUrl} name={p.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium" title={p.name}>{p.name}</p>
                    {lost ? <p className="text-[12px] text-warn">{h?.text ?? SOC1_COPY.pageLost}</p> : <p className="text-[12px] text-muted">Ready to post</p>}
                  </div>
                  {canManage && (
                    <Button variant="ghost" size="sm" className="shrink-0 text-bad hover:text-bad" onClick={() => setRemoving(p)} aria-label={`Remove ${p.name}`}>
                      <IconTrash className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">Remove</span>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      {canManage && (
        <Button variant="outline" size="sm" className="mt-2 max-sm:w-full" onClick={() => setOpen(true)} data-testid="choose-pages">
          <IconLayers className="h-4 w-4" aria-hidden />{mine.length ? `Change ${what}` : `Choose ${what}`}
        </Button>
      )}
      {canManage && <PagePicker account={account} open={open} onClose={() => setOpen(false)} />}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing)} busy={remove.isPending}
        title={removing ? `Remove ${removing.name}?` : "Remove"} confirmLabel="Remove"
        description="Planned posts to this Page will not go out. You can add it again any time." />
    </div>
  );
}

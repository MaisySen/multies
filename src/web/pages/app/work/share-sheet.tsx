/**
 * R26 (MB-87): the Share button on a doc and on a project board. Opens a small sheet: make a read only link
 * (never, 7 or 30 days), copy it, revoke it, and the list of active links. The url with its token is shown
 * only right after it is made; later the list shows when each link was made and when it ends.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Share2, Trash2 } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Select } from "@/web/components/ui/input";
import { CopyButton, Switch } from "@/web/components/ui/misc";
import { useMe } from "@/web/lib/queries";

type Kind = "doc" | "project_board";
interface ShareLink { id: string; kind: Kind; targetId: string; showWorkspaceName: boolean; createdAt: string; expiresAt: string | null; url?: string }

const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

export function ShareButton({ kind, targetId, size = "sm" }: { kind: Kind; targetId: string; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size={size} className="shrink-0 max-sm:h-10 max-sm:min-w-10" onClick={() => setOpen(true)} aria-label="Share" data-testid="share-button"><Share2 className="h-4 w-4" /><span className="max-sm:hidden">Share</span></Button>
      {open && <ShareSheet kind={kind} targetId={targetId} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareSheet({ kind, targetId, onClose }: { kind: Kind; targetId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ["share-links", kind, targetId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ links: ShareLink[]; allowShareLinks: boolean }>(`/share-links?kind=${kind}&targetId=${encodeURIComponent(targetId)}`) });
  const [expiry, setExpiry] = useState<"never" | "7" | "30">("never");
  const [showWs, setShowWs] = useState(true);
  const [fresh, setFresh] = useState<ShareLink | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ link: ShareLink }>("/share-links", { kind, targetId, expiresInDays: expiry === "never" ? null : Number(expiry), showWorkspaceName: showWs });
      setFresh(r.link);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    try {
      await api.del(`/share-links/${id}`);
      if (fresh?.id === id) setFresh(null);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) { showError(e as Error); }
  };
  const what = kind === "doc" ? "this doc" : "this board";
  const links = q.data?.links ?? [];
  return (
    <Dialog open onClose={onClose} title="Share a read only link" description={`Anyone with the link can read ${what} without signing in. ${kind === "doc" ? "Comments stay private." : "Notes, comments, files and custom fields stay private."}`}>
      {q.data && !q.data.allowShareLinks ? (
        <p className="text-[13px] text-muted" data-testid="share-off">An admin turned share links off for this workspace.</p>
      ) : (
        <div className="space-y-4" data-testid="share-sheet">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[13px] text-muted" htmlFor="share-expiry">Link works for</label>
            <Select id="share-expiry" aria-label="Link expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as "never" | "7" | "30")} className="h-9 w-auto! text-[13px]">
              <option value="never">Always</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
            </Select>
            <span className="ml-auto inline-flex items-center gap-2 text-[13px] text-muted">Show workspace name<Switch checked={showWs} onChange={setShowWs} label="Show workspace name" /></span>
          </div>
          <Button onClick={create} loading={busy} data-testid="share-create"><Link2 className="h-4 w-4" />Create link</Button>
          {fresh?.url && (
            <div className="rounded-lg border border-line bg-fill p-3" data-testid="share-fresh">
              <p className="text-[12px] text-subtle">Copy it now: the full link is shown only once.</p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-[12.5px]" data-testid="share-url">{fresh.url}</code>
                <CopyButton value={fresh.url} />
              </div>
            </div>
          )}
          <section aria-label="Active links">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Active links</h3>
            {links.length === 0 ? <p className="mt-2 text-[13px] text-muted">No active links.</p> : (
              <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
                {links.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 px-3 py-2 text-[13px]" data-testid="share-link-row">
                    <Link2 className="h-3.5 w-3.5 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">Made {day(l.createdAt)} · {l.expiresAt ? `ends ${day(l.expiresAt)}` : "no end date"}{l.showWorkspaceName ? "" : " · name hidden"}</span>
                    <Button variant="ghost" size="sm" onClick={() => void revoke(l.id)} aria-label="Revoke link"><Trash2 className="h-3.5 w-3.5" />Revoke</Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}

/** Settings, Workspace: "Allow share links" (admins; on by default). */
export function ShareLinksSetting() {
  const role = useMe().data?.organization?.role;
  const canEdit = role === "owner" || role === "admin";
  const q = useQuery({ queryKey: ["share-links-settings"], queryFn: () => api.get<{ allowShareLinks: boolean }>("/share-links/settings") });
  const qc = useQueryClient();
  const set = async (v: boolean) => {
    try { await api.put("/share-links/settings", { allowShareLinks: v }); await qc.invalidateQueries({ queryKey: ["share-links-settings"] }); } catch (e) { showError(e as Error); }
  };
  return (
    <div className="flex items-center gap-3" data-testid="share-links-setting">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium">Allow share links</p>
        <p className="text-[12.5px] text-muted">Members can share a read only link to a doc or a board. Off stops every link at once.</p>
      </div>
      <Switch checked={q.data?.allowShareLinks ?? true} onChange={(v) => void set(v)} label="Allow share links" disabled={!canEdit || !q.data} />
    </div>
  );
}

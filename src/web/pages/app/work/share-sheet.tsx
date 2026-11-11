/**
 * R26 (MB-87): the Share button on a doc and on a project board. Opens a small sheet: make a read only link
 * (never, 7 or 30 days), copy it, revoke it, and the list of active links. The url with its token is shown
 * only right after it is made; later the list shows when each link was made and when it ends.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconLink, IconShare, IconTrash } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Select } from "@/web/components/ui/input";
import { CopyButton, Switch } from "@/web/components/ui/misc";
import { useMe } from "@/web/lib/queries";
import { useConfig } from "@/web/lib/queries"; // R103
import { toast } from "sonner";
import { tr } from "@/web/i18n"; // POL4 (HQ MB-356)
import "@/web/i18n/w2/en-docs"; // R104B

type Kind = "doc" | "project_board";
interface ShareLink { id: string; kind: Kind; targetId: string; showWorkspaceName: boolean; createdAt: string; expiresAt: string | null; url?: string; comments?: "off" | "on" }

const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

export function ShareButton({ kind, targetId, size = "sm" }: { kind: Kind; targetId: string; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size={size} className="shrink-0 max-sm:h-11 max-sm:min-w-11 max-sm:rounded-lg max-sm:px-0 max-sm:[&_svg]:h-5 max-sm:[&_svg]:w-5" onClick={() => setOpen(true)} aria-label={tr("tasks.share")} data-testid="share-button"><IconShare className="h-4 w-4" /><span className="max-sm:hidden">{tr("tasks.share")}</span></Button>
      {open && <ShareSheet kind={kind} targetId={targetId} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareSheet({ kind, targetId, onClose }: { kind: Kind; targetId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ["share-links", kind, targetId];
  const docsPlus = !!useConfig().data?.docsPlus; // R103: comments on the shared link
  const setComments = async (l: ShareLink, on: boolean) => {
    try { await api.put(`/docs-plus/share/${l.id}`, { comments: on }); toast.success(on ? tr("docs.comments_on_new_ones_wait_for_your_review_in_the") : tr("docs.comments_off_for_this_link")); void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ["doc-comments-r103", targetId] }); } catch (e) { showError(e as Error); }
  };
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ links: ShareLink[]; allowShareLinks: boolean }>(`/share-links?kind=${kind}&targetId=${encodeURIComponent(targetId)}`) });
  // AIS1 (audit row 67): a new link ends after 30 days unless the person picks another choice (Always stays one).
  const [expiry, setExpiry] = useState<"never" | "7" | "30">("30");
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
    <Dialog open onClose={onClose} title={tr("docs.share_a_read_only_link")} description={`Anyone with the link can read ${what} without signing in. ${kind === "doc" ? "Comments stay private." : "Notes, comments, files and custom fields stay private."}`}>
      {q.data && !q.data.allowShareLinks ? (
        <p className="text-[13px] text-muted" data-testid="share-off">{tr("docs.an_admin_turned_share_links_off_for_this_workspa")}</p>
      ) : (
        <div className="space-y-4" data-testid="share-sheet">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[13px] text-muted" htmlFor="share-expiry">{tr("docs.link_works_for")}</label>
            <Select id="share-expiry" aria-label={tr("docs.link_expiry")} value={expiry} onChange={(e) => setExpiry(e.target.value as "never" | "7" | "30")} className="h-9 w-auto! text-[13px]">
              <option value="never">{tr("docs.always")}</option>
              <option value="7">{tr("docs.7_days")}</option>
              <option value="30">{tr("docs.30_days")}</option>
            </Select>
            <span className="ml-auto inline-flex items-center gap-2 text-[13px] text-muted">{tr("docs.show_workspace_name")}<Switch checked={showWs} onChange={setShowWs} label={tr("docs.show_workspace_name")} /></span>
          </div>
          <Button onClick={create} loading={busy} data-testid="share-create"><IconLink className="h-4 w-4" />{tr("docs.create_link")}</Button>
          {fresh?.url && (
            <div className="rounded-lg border border-line bg-fill p-3" data-testid="share-fresh">
              <p className="text-[12px] text-subtle">{tr("docs.copy_it_now_the_full_link_is_shown_only_once")}</p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-[12.5px]" data-testid="share-url">{fresh.url}</code>
                <CopyButton value={fresh.url} />
              </div>
            </div>
          )}
          <section aria-label={tr("docs.active_links")}>
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">{tr("docs.active_links")}</h3>
            {links.length === 0 ? <p className="mt-2 text-[13px] text-muted">{tr("docs.no_active_links")}</p> : (
              <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
                {links.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 px-3 py-2 text-[13px]" data-testid="share-link-row">
                    <IconLink className="h-3.5 w-3.5 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{tr("docs.made")} {day(l.createdAt)} · {l.expiresAt ? `ends ${day(l.expiresAt)}` : tr("docs.no_end_date")}{l.showWorkspaceName ? "" : " · name hidden"}</span>
                    {kind === "doc" && docsPlus && (
                      <label className="inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-fg" title={tr("docs.people_with_this_link_can_comment_you_review_eac")}>
                        <input type="checkbox" className="h-4 w-4 accent-[color:var(--brand,#1f6f43)]" checked={l.comments === "on"} onChange={(ev) => void setComments(l, ev.target.checked)} data-testid="share-comments-toggle" />{tr("docs.comments")}
                      </label>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => void revoke(l.id)} aria-label={tr("docs.revoke_link")}><IconTrash className="h-3.5 w-3.5" />{tr("docs.revoke")}</Button>
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
        <p className="text-[13.5px] font-medium">{tr("settings.allow_share_links")}</p>
        <p className="text-[12.5px] text-muted">{tr("settings.allow_share_links_hint")}</p>
      </div>
      <Switch checked={q.data?.allowShareLinks ?? true} onChange={(v) => void set(v)} label={tr("settings.allow_share_links")} disabled={!canEdit || !q.data} />
    </div>
  );
}

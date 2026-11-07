/**
 * PRIV1a (MB-366): personal mailboxes are private to the person who connected them. Settings, Connections shows
 * "Privacy and sharing": each of my personal mailboxes with who I shared it with (Read, Read and reply, Send as),
 * who opened it, and the mailboxes others shared with me. Owners and admins get a one time notice that personal
 * inboxes are now private. Strings go through the R104 layer (en, ne, hi).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { t } from "@/web/i18n";

type Level = "read" | "reply" | "send_as";
interface Mine { own: { id: string; address: string; displayName: string }[]; shared: { id: string; address: string; displayName: string; level: Level }[]; hiddenFromMe: number }
interface Sharing {
  personal: boolean; isOwner: boolean; address?: string;
  shares: { userId: string; name: string; email: string; level: Level; since: string }[];
  people: { id: string; name: string; email: string }[];
  log: { id: string; action: string; who: string; device: string | null; at: string }[];
}

const MINE_KEY = ["mailbox-privacy", "mine"] as const;
const sharingKey = (id: string) => ["mailbox-privacy", "sharing", id] as const;
const LEVELS: Level[] = ["read", "reply", "send_as"];
const levelName = (l: Level) => t(`priv1a.level_${l}`);
const selectClass = "h-9 rounded-lg border border-line bg-surface px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50";

export function useMailboxPrivacy() {
  return useQuery({ queryKey: MINE_KEY, queryFn: () => api.get<Mine>("/api/mailboxes/privacy/mine"), staleTime: 60_000 });
}

/** The one time notice for owners and admins: shown while a personal inbox in the workspace is closed to them, until dismissed. */
export function PrivateInboxNotice() {
  const role = useMe().data?.organization?.role;
  const lead = role === "owner" || role === "admin";
  const q = useQuery({ queryKey: MINE_KEY, queryFn: () => api.get<Mine>("/api/mailboxes/privacy/mine"), staleTime: 300_000, enabled: lead });
  const storeKey = "multies.priv1a.notice";
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(storeKey) === "1"; } catch { return false; } });
  if (!lead || hidden || !q.data?.hiddenFromMe) return null;
  const close = () => { try { localStorage.setItem(storeKey, "1"); } catch { /* private mode: hide for this visit */ } setHidden(true); };
  return (
    <div role="status" data-testid="priv1a-notice" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-line bg-brand-soft px-4 py-2 text-[13px] text-fg">
      <span>{t("priv1a.notice")}</span>
      <button type="button" onClick={close} data-testid="priv1a-notice-ok" className="rounded-md bg-brand px-2.5 py-1 text-[12.5px] font-medium text-white transition-colors duration-150 hover:bg-brand-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">{t("priv1a.notice_ok")}</button>
    </div>
  );
}

/** Settings, Connections: my personal mailboxes, their sharing and access log, and what is shared with me. */
export function MailboxPrivacyPanel() {
  const q = useMailboxPrivacy();
  const qc = useQueryClient();
  const me = useMe().data?.user?.id;
  const leave = useMutation({
    mutationFn: (id: string) => api.del(`/api/mailboxes/${id}/sharing/${me}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mailbox-privacy"] }),
    onError: showError,
  });
  if (!q.data) return null;
  const { own, shared } = q.data;
  return (
    <div className="space-y-4" data-testid="priv1a-panel">
      <p className="text-sm text-muted">{t("priv1a.section_hint")}</p>
      {own.length === 0 && <p className="text-sm text-muted">{t("priv1a.none_own")}</p>}
      {own.map((m) => <ShareCard key={m.id} id={m.id} address={m.address} />)}
      {shared.length > 0 && (
        <div className="rounded-xl border border-line p-3" data-testid="priv1a-shared-with-me">
          <h3 className="text-[13px] font-semibold">{t("priv1a.shared_with_you")}</h3>
          <ul className="mt-2 space-y-1.5">
            {shared.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{s.address} <span className="text-muted">({levelName(s.level)})</span></span>
                <Button size="sm" variant="secondary" disabled={!me || leave.isPending} onClick={() => leave.mutate(s.id)}>{t("priv1a.leave")}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ShareCard({ id, address }: { id: string; address: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: sharingKey(id), queryFn: () => api.get<Sharing>(`/api/mailboxes/${id}/sharing`) });
  const [person, setPerson] = useState("");
  const [level, setLevel] = useState<Level>("read");
  const done = (v: Sharing) => { qc.setQueryData(sharingKey(id), v); toast.success(t("priv1a.saved")); };
  const share = useMutation({ mutationFn: (b: { userId: string; level: Level }) => api.put<Sharing>(`/api/mailboxes/${id}/sharing/${b.userId}`, { level: b.level }), onSuccess: (v) => { setPerson(""); done(v); }, onError: showError });
  const stop = useMutation({ mutationFn: (userId: string) => api.del<Sharing>(`/api/mailboxes/${id}/sharing/${userId}`), onSuccess: done, onError: showError });
  const v = q.data;
  return (
    <div className="rounded-xl border border-line p-3" data-testid="priv1a-share-card">
      <div className="text-sm font-medium">{address}</div>
      {!v ? <div className="mt-2 h-8 animate-pulse rounded bg-surface-2" /> : (
        <>
          <ul className="mt-2 space-y-1.5">
            {v.shares.length === 0 && <li className="text-sm text-muted">{t("priv1a.not_shared")}</li>}
            {v.shares.map((s) => (
              <li key={s.userId} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="priv1a-share">
                <span className="min-w-0 truncate">{s.name} <span className="text-muted">{s.email}</span></span>
                <span className="flex items-center gap-2">
                  <select aria-label={t("priv1a.share_with")} className={selectClass} value={s.level} onChange={(e) => share.mutate({ userId: s.userId, level: e.target.value as Level })}>
                    {LEVELS.map((l) => <option key={l} value={l}>{levelName(l)}</option>)}
                  </select>
                  <Button size="sm" variant="secondary" disabled={stop.isPending} onClick={() => stop.mutate(s.userId)}>{t("priv1a.stop")}</Button>
                </span>
              </li>
            ))}
          </ul>
          {v.people.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select aria-label={t("priv1a.share_with")} data-testid="priv1a-person" className={selectClass} value={person} onChange={(e) => setPerson(e.target.value)}>
                <option value="">{t("priv1a.pick_person")}</option>
                {v.people.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
              </select>
              <select aria-label={t("priv1a.share_with")} data-testid="priv1a-level" className={selectClass} value={level} onChange={(e) => setLevel(e.target.value as Level)}>
                {LEVELS.map((l) => <option key={l} value={l}>{levelName(l)}</option>)}
              </select>
              <Button size="sm" data-testid="priv1a-share-button" disabled={!person || share.isPending} onClick={() => share.mutate({ userId: person, level })}>{t("priv1a.share")}</Button>
            </div>
          )}
          <details className="mt-3" data-testid="priv1a-log">
            <summary className="cursor-pointer text-[13px] font-medium">{t("priv1a.who_opened")}</summary>
            <ul className="mt-2 space-y-1">
              {v.log.length === 0 && <li className="text-sm text-muted">{t("priv1a.log_empty")}</li>}
              {v.log.map((l) => (
                <li key={l.id} className="text-[13px]">
                  {t(`priv1a.log_${l.action}`, { who: l.who }, `${l.who}: ${l.action}`)}
                  {l.device ? <span className="text-muted"> {t(`priv1a.device_${l.device}`, undefined, "")}</span> : null}
                  <span className="text-muted"> · {timeAgo(l.at)}</span>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

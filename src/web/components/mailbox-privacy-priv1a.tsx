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
import { qk, useMe } from "@/web/lib/queries";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { useDialogs } from "@/web/components/ui/confirm";
import { t } from "@/web/i18n";
import { noticeKey } from "@/web/lib/mail-level-priv1b"; // PRIV1b (P66)

type Level = "read" | "reply" | "send_as";
interface Mine { own: { id: string; address: string; displayName: string }[]; shared: { id: string; address: string; displayName: string; level: Level }[]; hiddenFromMe: number;
  /** Wave 1 review V12 (P37): for admins, team mailboxes at a member's sign in address. */
  loginAddressTeam?: { id: string; address: string; member: string }[] }
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

export function useMailboxPrivacy() {
  return useQuery({ queryKey: MINE_KEY, queryFn: () => api.get<Mine>("/mailboxes/privacy/mine"), staleTime: 60_000 });
}

/** The one time notice for owners and admins: shown while a personal inbox in the workspace is closed to them, until dismissed. */
export function PrivateInboxNotice() {
  const me = useMe().data;
  const role = me?.organization?.role;
  const lead = role === "owner" || role === "admin";
  const q = useQuery({ queryKey: MINE_KEY, queryFn: () => api.get<Mine>("/mailboxes/privacy/mine"), staleTime: 300_000, enabled: lead });
  // PRIV1b (P66): dismissed per person and workspace, so the next admin on this browser still sees it.
  const storeKey = noticeKey(me?.user?.id, me?.organization?.id);
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  let stored = false;
  try { stored = localStorage.getItem(storeKey) === "1"; } catch { /* storage blocked */ }
  if (!lead || stored || hiddenFor === storeKey || !q.data?.hiddenFromMe) return null;
  const close = () => { try { localStorage.setItem(storeKey, "1"); } catch { /* private mode: hide for this visit */ } setHiddenFor(storeKey); };
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
  const meData = useMe().data;
  const me = meData?.user?.id;
  const isOwner = meData?.organization?.role === "owner";
  const { confirm, dialogs } = useDialogs();
  // Wave 2 review X3 (P37): only the workspace owner turns a listed team mailbox into the member's personal mailbox.
  const makePersonal = useMutation({
    mutationFn: (id: string) => api.post(`/mailboxes/${id}/make-personal`, {}),
    onSuccess: () => { toast.success(t("priv1a.login_team_done")); return Promise.all([["mailbox-privacy"], ["mail"], qk.mailboxes, ["team-inbox"]].map((queryKey) => qc.invalidateQueries({ queryKey }))); },
    onError: showError,
  });
  const askMakePersonal = async (m: { id: string; address: string; member: string }) => {
    if (await confirm({ title: t("priv1a.login_team_confirm_title", { address: m.address }), description: t("priv1a.login_team_confirm_body", { address: m.address, member: m.member }), confirmLabel: t("priv1a.login_team_make"), tone: "danger" })) makePersonal.mutate(m.id);
  };
  const leave = useMutation({
    mutationFn: (id: string) => api.del(`/mailboxes/${id}/sharing/${me}`),
    // PRIV1b (P66): the left mailbox also leaves Mail and every mailbox list at once.
    onSuccess: () => Promise.all([["mailbox-privacy"], ["mail"], qk.mailboxes, ["team-inbox"]].map((queryKey) => qc.invalidateQueries({ queryKey }))),
    onError: showError,
  });
  if (!q.data) return null;
  const { own, shared, loginAddressTeam } = q.data;
  return (
    <div className="space-y-4" data-testid="priv1a-panel">
      {dialogs}
      <p className="text-sm text-muted">{t("priv1a.section_hint")}</p>
      {loginAddressTeam?.length ? (
        <div role="status" className="rounded-xl border border-warn/30 bg-warn-soft p-3" data-testid="priv1a-login-team">
          <h3 className="text-[13px] font-semibold">{t("priv1a.login_team_title")}</h3>
          <p className="mt-1 text-[12.5px] text-muted">{t("priv1a.login_team_hint")}{isOwner ? ` ${t("priv1a.login_team_owner_hint")}` : ""}</p>
          <ul className="mt-2 space-y-1">
            {loginAddressTeam.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <span className="min-w-0">{t("priv1a.login_team_item", { address: m.address, member: m.member })}</span>
                {isOwner ? <Button size="sm" variant="secondary" disabled={makePersonal.isPending} onClick={() => void askMakePersonal(m)} data-testid={`priv1a-make-personal-${m.id}`}>{t("priv1a.login_team_make")}</Button> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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
  const q = useQuery({ queryKey: sharingKey(id), queryFn: () => api.get<Sharing>(`/mailboxes/${id}/sharing`) });
  const [person, setPerson] = useState("");
  const [level, setLevel] = useState<Level>("read");
  const done = (v: Sharing) => { qc.setQueryData(sharingKey(id), v); toast.success(t("priv1a.saved")); };
  const share = useMutation({ mutationFn: (b: { userId: string; level: Level }) => api.put<Sharing>(`/mailboxes/${id}/sharing/${b.userId}`, { level: b.level }), onSuccess: (v) => { setPerson(""); done(v); }, onError: showError });
  const stop = useMutation({ mutationFn: (userId: string) => api.del<Sharing>(`/mailboxes/${id}/sharing/${userId}`), onSuccess: done, onError: showError });
  const v = q.data;
  return (
    <div className="rounded-xl border border-line p-3" data-testid="priv1a-share-card">
      <div className="text-sm font-medium">{address}</div>
      {!v ? <div className="mt-2 h-8 animate-pulse rounded bg-surface-2" /> : (
        <>
          <p className="mt-1 text-[12.5px] text-muted" data-testid="priv1a-marks-read">{t("priv1a.marks_read")}</p>
          <ul className="mt-2 space-y-1.5">
            {v.shares.length === 0 && <li className="text-sm text-muted">{t("priv1a.not_shared")}</li>}
            {v.shares.map((s) => (
              <li key={s.userId} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="priv1a-share">
                <span className="min-w-0 truncate">{s.name} <span className="text-muted">{s.email}</span></span>
                <span className="flex items-center gap-2">
                  <Select aria-label={t("priv1a.share_with")} className="w-auto min-w-[9rem]" value={s.level} onChange={(e) => share.mutate({ userId: s.userId, level: e.target.value as Level })}>
                    {LEVELS.map((l) => <option key={l} value={l}>{levelName(l)}</option>)}
                  </Select>
                  <Button size="sm" variant="secondary" disabled={stop.isPending} onClick={() => stop.mutate(s.userId)}>{t("priv1a.stop")}</Button>
                </span>
              </li>
            ))}
          </ul>
          {v.people.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select aria-label={t("priv1a.share_with")} data-testid="priv1a-person" className="w-auto min-w-[9rem]" value={person} onChange={(e) => setPerson(e.target.value)}>
                <option value="">{t("priv1a.pick_person")}</option>
                {v.people.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
              </Select>
              <Select aria-label={t("priv1a.share_with")} data-testid="priv1a-level" className="w-auto min-w-[9rem]" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
                {LEVELS.map((l) => <option key={l} value={l}>{levelName(l)}</option>)}
              </Select>
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

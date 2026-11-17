/**
 * Round 32: the meeting waiting room on the web, and "So far" in the call dock.
 * - GuestLobby: the guest's screen after asking to join (camera preview kept, polls every 3 s).
 * - LobbyRequests: members in the call see "Name wants to join" with Admit, Deny and Admit all.
 * - GuestsWaitSetting: the meeting setting "Guests wait to be let in".
 * - DockSoFar: the "So far" button and popover in the docked call (same digest as the call panel).
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconClock, IconClose, IconDoorOpen, IconUserCheck, IconUserX } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Switch } from "@/web/components/ui/misc";
import { DOCK_SO_FAR_MS, LOBBY_COPY, LOBBY_HOST_POLL_MS, LOBBY_POLL_MS } from "@/shared/meeting-lobby";
import type { JoinPrefs } from "@/web/lib/prejoin-prefs";
import { SoFarView, type SoFar } from "./call-panel-r31";
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-meetings"; // R104B

export interface LobbyAsk { lobbyId: string | null; status: "pending" | "admitted"; waitingRoom: boolean }
type GuestStatus = "pending" | "admitted" | "denied" | "expired";
export interface Waiting { id: string; name: string; status: "pending"; askedAt: string }
interface LobbyList { meetingId: string; guestsWait: boolean; waiting: Waiting[] }

/** Page-local keys on a focused request row (listed in the command registry as local). */
export const LOBBY_KEYS = { admit: "a", deny: "d" } as const;

/**
 * Asks to join from the guest link. MEET fixes (12 Nov 2026): the request this browser already made for the
 * link rides along (kept for the tab's session), so asking again after a reload, a second tap or the quiet
 * retry is the same request and the host sees one Admit, not two.
 */
export function askToJoin(token: string, name: string, s: Pick<Storage, "getItem" | "setItem"> | null = tabStore()) {
  const key = lobbyKey(token);
  let previous: string | null = null;
  try { previous = s?.getItem(key) ?? null; } catch { /* private mode */ }
  return api.post<LobbyAsk>(`/public/meeting-lobby/${token}`, { name, ...(previous ? { lobbyId: previous } : {}) }).then((r) => {
    try { if (r.lobbyId) s?.setItem(key, r.lobbyId); } catch { /* private mode: asking again makes a new request */ }
    return r;
  });
}
export const lobbyKey = (token: string) => `multies.lobby.${token}`;
const tabStore = () => { try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; } };

/** The guest waits here: their camera preview stays on, and the page checks every 3 seconds. */
export function GuestLobby({ token, lobbyId, name, prefs, title, onAdmitted, onLeave, onAskAgain }: {
  token: string; lobbyId: string; name: string; prefs?: JoinPrefs; title: string;
  onAdmitted: () => void; onLeave: () => void; onAskAgain: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const q = useQuery({
    queryKey: ["lobby-status", token, lobbyId], retry: false,
    queryFn: () => api.get<{ status: GuestStatus; name: string }>(`/public/meeting-lobby/${token}/${lobbyId}`),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== "pending" ? false : LOBBY_POLL_MS),
    refetchIntervalInBackground: true,
  });
  const status = q.data?.status ?? "pending";
  const admittedRef = useRef(onAdmitted);
  admittedRef.current = onAdmitted;
  useEffect(() => { if (status === "admitted") admittedRef.current(); }, [status]);
  // A request that timed out is asked again once, quietly, so a guest left waiting is not dropped; after that, the button.
  const askAgainRef = useRef(onAskAgain);
  askAgainRef.current = onAskAgain;
  const retried = useRef(false);
  useEffect(() => { if (status === "expired" && !retried.current) { retried.current = true; askAgainRef.current(); } }, [status]);
  // The camera preview carries on while waiting (no audio is opened here).
  useEffect(() => {
    if (!prefs?.cam || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    void navigator.mediaDevices.getUserMedia({ video: prefs.videoDeviceId ? { deviceId: { exact: prefs.videoDeviceId } } : true, audio: false })
      .then((s) => { if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; } stream = s; if (videoRef.current) { videoRef.current.srcObject = s; void videoRef.current.play?.().catch(() => undefined); } })
      .catch(() => undefined);
    return () => { cancelled = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [prefs?.cam, prefs?.videoDeviceId]);
  const heading = status === "denied" ? LOBBY_COPY.denied : status === "expired" ? LOBBY_COPY.expired : LOBBY_COPY.pending;
  const body = status === "denied" ? LOBBY_COPY.deniedBody : status === "expired" ? LOBBY_COPY.expiredBody : LOBBY_COPY.pendingBody;
  return (
    <section className="mx-auto grid max-w-3xl gap-5 md:grid-cols-[1.4fr_1fr]" data-testid="guest-lobby" aria-labelledby="lobby-heading">
      <div className="relative aspect-video overflow-hidden rounded-2xl bg-[#1c1c1e]">
        <video ref={videoRef} muted playsInline autoPlay aria-label={tr("meetings.your_camera_preview")} data-testid="lobby-preview" className={cn("h-full w-full -scale-x-100 object-cover", !prefs?.cam && "invisible")} />
        {!prefs?.cam && <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-white/80">{tr("meetings.camera_is_off")}</div>}
        <span className="absolute bottom-3 left-3 rounded-md bg-black/45 px-2 py-0.5 text-[12px] text-white">{name}</span>
      </div>
      <div className="flex flex-col justify-center gap-3" role="status" aria-live="polite">
        {status === "pending" && (
          <span className="relative flex h-3 w-3" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand/50 motion-reduce:animate-none" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-brand" />
          </span>
        )}
        <h2 id="lobby-heading" className="text-lg font-semibold tracking-tight" data-testid="lobby-state" data-state={status}>{heading}</h2>
        <p className="text-[13px] text-muted">{body}</p>
        <p className="text-[12.5px] text-subtle">{title}</p>
        <div className="mt-1 flex gap-2">
          {status === "expired" && <Button onClick={onAskAgain} data-testid="lobby-ask-again">{tr("meetings.ask_again")}</Button>}
          <Button variant={status === "pending" ? "ghost" : "secondary"} onClick={onLeave} data-testid="lobby-leave">{status === "pending" ? tr("meetings.leave") : tr("common.back")}</Button>
        </div>
      </div>
    </section>
  );
}

/** Members in the call: who is waiting, with Admit, Deny and Admit all. A toast announces each new guest. */
export function LobbyRequests({ meetingId, className }: { meetingId?: string; className?: string }) {
  const qc = useQueryClient();
  const seen = useRef<Set<string> | null>(null);
  const q = useQuery({
    queryKey: ["meeting-lobby", meetingId], enabled: !!meetingId, retry: false,
    queryFn: () => api.get<LobbyList>(`/meeting-lobby/${meetingId}`),
    refetchInterval: (query) => (query.state.data && !query.state.data.guestsWait ? false : LOBBY_HOST_POLL_MS),
  });
  const decide = useMutation({
    mutationFn: (b: { lobbyId?: string; all?: boolean; decision: "admit" | "deny" }) => api.post<{ decided: number }>(`/meeting-lobby/${meetingId}/decide`, b),
    onMutate: async (b) => {
      if (b.lobbyId) toast.dismiss(`lobby-${b.lobbyId}`); else for (const id of seen.current ?? []) toast.dismiss(`lobby-${id}`);
      const key = ["meeting-lobby", meetingId];
      const prev = qc.getQueryData<LobbyList>(key);
      if (prev) qc.setQueryData<LobbyList>(key, { ...prev, waiting: b.all ? [] : prev.waiting.filter((w) => w.id !== b.lobbyId) });
      return { prev };
    },
    onError: (e, _b, c) => { if (c?.prev) qc.setQueryData(["meeting-lobby", meetingId], c.prev); showError(e as Error); },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["meeting-lobby", meetingId] }),
  });
  const waiting = q.data?.waiting ?? [];
  useEffect(() => {
    if (!q.data) return;
    if (!seen.current) { seen.current = new Set(); }
    for (const w of q.data.waiting) {
      if (seen.current.has(w.id)) continue;
      seen.current.add(w.id);
      // MEET fixes: the toast only tells; Admit lives on the guest's row. A toast with its own Admit was a second
      // Admit button for the same guest, and it stayed up after the row's Admit had already let them in.
      toast(tr("meetings.name_wants_to_join", { name: w.name }), { id: `lobby-${w.id}`, duration: 8000 });
    }
    // A guest no longer waiting (admitted or denied here or by someone else) takes their toast with them.
    const still = new Set(q.data.waiting.map((w) => w.id));
    for (const id of seen.current) if (!still.has(id)) toast.dismiss(`lobby-${id}`);
  }, [q.data]);
  if (!waiting.length) return null;
  const onKey = (e: React.KeyboardEvent, id: string) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === LOBBY_KEYS.admit) { e.preventDefault(); decide.mutate({ lobbyId: id, decision: "admit" }); }
    if (k === LOBBY_KEYS.deny) { e.preventDefault(); decide.mutate({ lobbyId: id, decision: "deny" }); }
  };
  return (
    <section aria-label={tr("meetings.waiting_to_join")} className={cn("w-72 rounded-2xl border border-line bg-elevated p-2 text-fg shadow-pop", className)} data-testid="lobby-requests">
      <header className="flex items-center gap-2 px-2 pb-1 pt-1">
        <IconDoorOpen className="h-4 w-4 text-brand" aria-hidden />
        <h2 className="flex-1 text-[13px] font-semibold">{tr("meetings.waiting_to_join_length", { length: waiting.length })}</h2>
        {waiting.length > 1 && <Button size="sm" variant="secondary" onClick={() => decide.mutate({ all: true, decision: "admit" })} data-testid="lobby-admit-all">{tr("meetings.admit_all")}</Button>}
      </header>
      <ul className="max-h-60 space-y-0.5 overflow-y-auto" aria-live="polite">
        {waiting.map((w) => (
          <li key={w.id} tabIndex={0} onKeyDown={(e) => onKey(e, w.id)} aria-label={tr("meetings.name_wants_to_join_press_a_to_admit_or_d_to_deny", { name: w.name })}
            className="flex items-center gap-2 rounded-xl px-2 py-1.5 outline-none transition-colors duration-150 hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none" data-testid="lobby-row">
            <span className="min-w-0 flex-1 truncate text-[13px]"><span className="font-medium">{w.name}</span> <span className="text-muted">{tr("meetings.wants_to_join")}</span></span>
            <button type="button" onClick={() => decide.mutate({ lobbyId: w.id, decision: "deny" })} aria-label={tr("meetings.deny_name", { name: w.name })} title={tr("meetings.deny_d")}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" data-testid="lobby-deny"><IconUserX className="h-4 w-4" aria-hidden /></button>
            <button type="button" onClick={() => decide.mutate({ lobbyId: w.id, decision: "admit" })} aria-label={tr("meetings.admit_name", { name: w.name })} title={tr("meetings.admit_a")}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-brand px-2.5 text-[12.5px] font-medium text-white hover:bg-brand-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2" data-testid="lobby-admit"><IconUserCheck className="h-3.5 w-3.5" aria-hidden />{tr("meetings.admit")}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The meeting setting: guests from the link wait until someone lets them in. */
export function GuestsWaitSetting({ meetingId, value }: { meetingId: string; value: boolean }) {
  const qc = useQueryClient();
  const [on, setOn] = useState(value);
  useEffect(() => setOn(value), [value]);
  const save = useMutation({
    mutationFn: (v: boolean) => api.patch<{ guestsWait: boolean }>(`/meeting-lobby/${meetingId}/settings`, { guestsWait: v }),
    onMutate: (v) => setOn(v),
    onError: (e) => { setOn(value); showError(e as Error); },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["meeting", meetingId] }),
  });
  return (
    <div className="mt-3 flex items-start gap-3" data-testid="guests-wait">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{tr("meetings.guests_wait_to_be_let_in")}</p>
        <p className="text-[12px] text-muted">{tr("meetings.people_who_open_the_guest_link_wait_until_someon")}</p>
      </div>
      <Switch checked={on} onChange={(v) => save.mutate(v)} label={tr("meetings.guests_wait_to_be_let_in")} disabled={save.isPending} />
    </div>
  );
}

/** "So far" in the docked call: a compact popover with the same digest, refreshed at most every 30 seconds. */
export function DockSoFar({ meetingId }: { meetingId: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ["so-far", meetingId], enabled: open, staleTime: DOCK_SO_FAR_MS,
    refetchInterval: open ? DOCK_SO_FAR_MS : false,
    queryFn: () => api.get<SoFar>(`/meeting-live/${meetingId}/so-far`),
  });
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  return (
    <>
      <button ref={btn} type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="dock-so-far" aria-haspopup="dialog"
        aria-label={tr("meetings.so_far")} className={cn("inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand", open && "bg-hover text-fg")} data-testid="call-dock-so-far">
        <IconClock className="h-3.5 w-3.5" aria-hidden /><span className="max-sm:hidden">{tr("meetings.so_far")}</span>
      </button>
      {open && (
        <div id="dock-so-far" ref={panel} tabIndex={-1} role="dialog" aria-label={tr("meetings.so_far_in_this_call")}
          className="absolute inset-x-2 top-11 z-30 max-h-[calc(100%-3.5rem)] overflow-y-auto rounded-2xl border border-line bg-elevated pb-3 shadow-pop outline-none motion-safe:animate-[fade-in_160ms_ease-out]" data-testid="dock-so-far">
          <div className="flex items-center justify-between px-4 pt-3">
            <h3 className="text-[13px] font-semibold">{tr("meetings.so_far")}</h3>
            <button type="button" onClick={() => { setOpen(false); btn.current?.focus(); }} aria-label={tr("meetings.close_so_far")} className="rounded-md p-1 text-subtle hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><IconClose className="h-3.5 w-3.5" aria-hidden /></button>
          </div>
          {q.data ? <SoFarView data={q.data} /> : <p className="px-4 py-3 text-[13px] text-muted" aria-live="polite">{q.error ? (q.error as Error).message : tr("meetings.loading")}</p>}
        </div>
      )}
    </>
  );
}


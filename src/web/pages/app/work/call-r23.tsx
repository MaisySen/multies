/**
 * Round 23 (R23.3) calls in chat: who is in the call on the card and in the header, and the docked
 * call window's state. The window itself and the room extras load with LiveKit (call-dock-r23.tsx),
 * only when a call is open, so chat and the app shell stay light.
 */
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { IconPhoneOff, IconVideo } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { mailDate } from "@/web/lib/format";
import { useConfig } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { lazyPage } from "@/web/components/lazy-page";
import { sessionFor, useCallSession } from "@/web/lib/call-session-meet";
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-meetings"; // R104B

export interface CallStatus {
  meetingId: string; title: string; channelId: string | null; state: "live" | "waiting" | "ended";
  participants: { name: string }[]; count: number; startedAt: string; endedAt: string | null; durationMin: number | null;
}
export interface ChannelCalls { enabled: boolean; channelId: string; live: CallStatus | null; calls: CallStatus[] }

/** Cards newer than this poll for presence; older ones are plain. Matches the server's window. */
export const CALL_RECENT_MS = 6 * 3600_000;
export const CALL_POLL_MS = 15_000;

/** "Maya, Sam (+2)": the first two names and how many more. */
export function inCallNames(people: { name: string }[], count = people.length) {
  const names = people.slice(0, 2).map((p) => p.name);
  return count > 2 ? `${names.join(", ")} (+${count - 2})` : names.join(", ");
}

const callsKey = (channelId: string) => ["chat", "call", channelId] as const;

/** One presence read per channel, shared by every card and the header; polls only while `active`. */
export function useChannelCalls(channelId: string | undefined, active: boolean, guest = false) {
  return useQuery({
    queryKey: callsKey(channelId ?? ""), enabled: !!channelId && active, staleTime: 10_000, retry: false,
    refetchInterval: active ? CALL_POLL_MS : false, refetchIntervalInBackground: false,
    queryFn: () => api.get<ChannelCalls>(`${guest ? "/guest/chat" : "/chat"}/channels/${channelId}/call`),
  });
}

const videoOn = (config: unknown) => !!(config as { meetings?: boolean } | undefined)?.meetings;

/** The call card in the message list: live names and Join, or how long the call ran. */
export function LiveCallCard({ path, by, at, channelId }: { path: string; by: string; at: string; channelId?: string }) {
  const meetingId = path.split("/").pop() ?? "";
  const recent = Date.now() - new Date(at).getTime() < CALL_RECENT_MS;
  const [ended, setEnded] = useState(false);
  const q = useChannelCalls(channelId, recent && !ended);
  const call = q.data?.calls.find((c) => c.meetingId === meetingId);
  useEffect(() => { if (call?.state === "ended") setEnded(true); }, [call?.state]);
  const config = useConfig();
  const live = call?.state === "live";
  const done = call?.state === "ended";
  return (
    <div className={cn("mt-1 flex max-w-sm items-center gap-3 rounded-xl border bg-surface p-3", live ? "border-brand/40" : "border-line")} data-testid="call-card" data-state={call?.state ?? "plain"}>
      <span className={cn("relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full", done ? "bg-fill text-muted" : "bg-brand/10 text-brand")}>
        {done ? <IconPhoneOff className="h-4 w-4" aria-hidden /> : <IconVideo className="h-4 w-4" aria-hidden />}
        {live && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-ok" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold">{done ? tr("meetings.call_ended_durationmin_min", { durationMin: call!.durationMin }) : live ? tr("meetings.in_call") : tr("meetings.call_started")}</p>
        <p className="truncate text-[12px] text-muted" data-testid="call-card-who">{live ? inCallNames(call!.participants, call!.count) : `${by}, ${mailDate(at)}`}</p>
      </div>
      {!done && <JoinCall path={path} meetingId={meetingId} title={call?.title ?? tr("meetings.call")} videoEnabled={videoOn(config.data)} testId="call-join" />}
    </div>
  );
}

/** Opens the docked call window when video is on; otherwise the meeting page (guest link, video off note). */
function JoinCall({ path, meetingId, title, videoEnabled, testId, small }: { path: string; meetingId: string; title: string; videoEnabled: boolean; testId: string; small?: boolean }) {
  const cls = cn("inline-flex shrink-0 items-center rounded-lg bg-brand font-medium text-brand-fg hover:bg-brand-press", small ? "h-7 px-2.5 text-[12.5px]" : "h-8 px-3 text-[13px]");
  if (!videoEnabled) return <Link to={path} className={cls} data-testid={testId}>{tr("mywork.join")}</Link>;
  return <button type="button" className={cls} onClick={() => openCallDock({ meetingId, title, path })} data-testid={testId}>{tr("mywork.join")}</button>;
}

/** The chat header while people are in a call here: "In call: Maya, Sam (+2)" and Join. Reads what the cards fetch. */
export function CallHeaderStatus({ channelId }: { channelId: string }) {
  const q = useQuery({ queryKey: callsKey(channelId), enabled: false, queryFn: () => api.get<ChannelCalls>(`/chat/channels/${channelId}/call`) });
  const config = useConfig();
  const live = q.data?.channelId === channelId ? q.data.live : null;
  if (!live) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-full border border-brand/30 bg-brand/5 py-0.5 pl-2.5 pr-0.5 text-[12.5px]" data-testid="call-header">
      <span className="h-2 w-2 shrink-0 rounded-full bg-ok" aria-hidden />
      <span className="truncate">{tr("meetings.in_call_2")} {inCallNames(live.participants, live.count)}</span>
      <JoinCall path={`/app/meetings/${live.meetingId}`} meetingId={live.meetingId} title={live.title} videoEnabled={videoOn(config.data)} testId="call-header-join" small />
    </div>
  );
}

// ---------------------------------------------------------------- docked call window

export interface DockCall { meetingId: string; title: string; path: string }
let docked: DockCall | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
export function openCallDock(c: DockCall) { docked = c; emit(); }
export function closeCallDock() { docked = null; emit(); }
const subscribe = (f: () => void) => { listeners.add(f); return () => listeners.delete(f); };
export const useCallDock = () => useSyncExternalStore(subscribe, () => docked, () => null);

const CallDock = lazyPage(() => import("./call-dock-r23"), "CallDock", { quiet: true });
/** In the app shell: the docked call window, loaded only while a call is open. */
export function CallDockHost() {
  const call = useCallDock();
  // MEET fixes: also while the tab's call is shown in the floating window (the person left the meeting page).
  const session = useCallSession();
  if (!call && session?.view !== "dock") return null;
  return <Suspense fallback={null}><CallDock /></Suspense>;
}

/** The meeting page joins on its own when opened from the docked window's Expand (?join=1), once. */
export function useJoinFromDock(ready: boolean, enter: () => void, meetingId?: string) {
  const done = useRef(false);
  useEffect(() => {
    // MEET fixes: a call this tab is already in is shown, not joined a second time.
    if (done.current || !ready || sessionFor(meetingId) || new URLSearchParams(window.location.search).get("join") !== "1") return;
    done.current = true;
    enter();
  }, [ready, enter, meetingId]);
}

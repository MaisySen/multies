/**
 * Round 23 (R23.3): the docked call window and the room extras (a hint when the browser blocks
 * screen share, camera or microphone, and the leave signal). Loaded with LiveKit, only when needed.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { VideoConference, useRoomContext } from "@livekit/components-react";
import "@livekit/components-styles";
import { RoomEvent } from "livekit-client";
import { IconClose, IconMaximize, IconNotes, IconPhoneOff, IconExternalLink, IconScreenShare } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { closeCallDock, useCallDock } from "./call-r23";
import { PreJoin, type JoinPrefs } from "./prejoin-r31";
import { useCallNotesDoc } from "./call-panel-r31";
import { DockSoFar, LobbyRequests } from "./lobby-r32";
import { DOCK_SIZE, dockSize, setCallView, sessionFor, useCallSession } from "@/web/lib/call-session-meet";
import { beginCall, CallStage, leaveCall, reportLeft } from "./call-session-room";
import { useMe } from "@/web/lib/queries";
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-meetings"; // R104B

/**
 * Inside a call: a short hint when the browser blocks screen share, camera or microphone, and the leave signal.
 * MEET fixes: a view of the tab's call session (reportOnUnmount false) does not report leaving when it closes,
 * because the call carries on in the other view; the session reports when it really hangs up.
 */
export function CallRoomExtras({ meetingId, reportOnUnmount = true }: { meetingId?: string; reportOnUnmount?: boolean }) {
  const room = useRoomContext();
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const onError = () => setBlocked(true);
    room.on(RoomEvent.MediaDevicesError, onError);
    return () => { room.off(RoomEvent.MediaDevicesError, onError); if (meetingId && reportOnUnmount) reportLeft(meetingId); };
  }, [room, meetingId, reportOnUnmount]);
  if (!blocked) return null;
  return (
    <div role="status" className="absolute left-1/2 top-3 z-20 flex max-w-md -translate-x-1/2 items-start gap-2 rounded-xl border border-line bg-elevated p-3 text-[12.5px] text-fg shadow-pop" data-testid="share-blocked">
      <IconScreenShare className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
      <p>{tr("meetings.your_browser_blocked_the_screen_camera_or_microp")}</p>
      <button type="button" aria-label={tr("meetings.close_hint")} onClick={() => setBlocked(false)} className="text-subtle hover:text-fg"><IconClose className="h-3.5 w-3.5" /></button>
    </div>
  );
}

interface Join { url: string; token: string; room: string }


/**
 * MEET fixes: the browser's own picture in picture for the call (the window stays on top when the person
 * switches tab or app). It takes the first other person's camera, else any video in the call.
 */
function PopOut({ root }: { root: HTMLElement | null }) {
  const supported = typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled;
  if (!supported) return null;
  const pop = async () => {
    const pick = root?.querySelector<HTMLVideoElement>("[data-lk-local-participant=false] video") ?? root?.querySelector<HTMLVideoElement>("video");
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (pick) await pick.requestPictureInPicture();
    } catch { /* the browser said no (no video playing yet): nothing to do */ }
  };
  return <button type="button" onClick={() => void pop()} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg" aria-label={tr("meetings.pop_out")} title={tr("meetings.pop_out")} data-testid="call-dock-popout"><IconExternalLink className="h-3.5 w-3.5" aria-hidden /></button>;
}

/**
 * The docked call: a floating window over the app, anchored bottom right, resizable from its top
 * left corner, so the person keeps reading and writing in chat. Expand opens the full meeting page.
 *
 * MEET fixes (12 Nov 2026): the window and the meeting page show the same call (call-session-meet.ts). Leaving
 * the meeting page for any other page keeps the call here; Expand goes back to the page without hanging up.
 * From a chat card the window still starts with the pre-join check, then joins.
 */
export function CallDock() {
  const ask = useCallDock();
  const session = useCallSession();
  const navigate = useNavigate();
  const [size, setSize] = useState(DOCK_SIZE);
  const [screen, setScreen] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setScreen({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  // Round 31: the pre-join step comes first; its choices carry into the room. The notes doc is made as the call starts.
  const [prefs, setPrefs] = useState<JoinPrefs | null>(null);
  const [prefsFor, setPrefsFor] = useState<string | undefined>(ask?.meetingId);
  if (prefsFor !== ask?.meetingId) { setPrefsFor(ask?.meetingId); setPrefs(null); }
  const me = useMe();
  const docked = session?.view === "dock" ? session : null;
  // A chat card asking for a call this tab is already in shows that call (no second join).
  const joining = ask && !sessionFor(ask.meetingId) ? ask : null;
  const call = docked ?? joining;
  const docId = useCallNotesDoc(docked ? docked.meetingId : undefined, true);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  // Round 32: the token is asked for after pre-join, so a name changed for this call reaches the room.
  const join = useQuery({
    queryKey: ["call-dock", joining?.meetingId, prefs?.name ?? ""], enabled: !!joining && !!prefs, retry: false, staleTime: Infinity, gcTime: 0,
    queryFn: () => api.post<Join>(`/meetings/${joining!.meetingId}/join`, prefs?.name ? { name: prefs.name } : {}),
  });
  useEffect(() => {
    if (!joining || !prefs || !join.data) return;
    beginCall({ meetingId: joining.meetingId, title: joining.title, path: joining.path, join: join.data, prefs, view: "dock" });
    closeCallDock();
  }, [joining, prefs, join.data]);
  useEffect(() => { if (ask && sessionFor(ask.meetingId)) { setCallView(ask.meetingId, "dock"); closeCallDock(); } }, [ask]);
  if (!call) return null;
  const leave = () => { closeCallDock(); if (docked) leaveCall(docked.meetingId); };
  const expand = () => {
    if (docked) { setCallView(docked.meetingId, "full"); navigate(docked.path); return; }
    closeCallDock(); navigate(`${call.path}?join=1`);
  };
  const onDown = (e: ReactPointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, ...size }; (e.target as HTMLElement).setPointerCapture(e.pointerId); };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setSize({ w: Math.min(Math.max(320, d.w + d.x - e.clientX), window.innerWidth - 32), h: Math.min(Math.max(220, d.h + d.y - e.clientY), window.innerHeight - 32) });
  };
  const shown = dockSize(size, screen);
  return (
    <section ref={setRoot} aria-label={tr("meetings.call_title", { title: call.title })} className="fixed bottom-[calc(1rem+var(--tabbar-h,0px))] right-2 z-40 flex flex-col overflow-hidden rounded-2xl border border-line bg-elevated shadow-pop sm:right-4" style={{ width: shown.w, height: shown.h }} data-testid="call-dock" data-meeting-id={call.meetingId}>
      <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} className="absolute left-0 top-0 z-10 h-4 w-4 cursor-nwse-resize max-sm:hidden" aria-hidden title={tr("meetings.resize")} />
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-ok" aria-hidden />
        <h2 className="min-w-[4rem] flex-1 truncate text-[13px] font-semibold">{call.title}</h2>
        {docked && <DockSoFar meetingId={docked.meetingId} />}
        {docked && <PopOut root={root} />}
        {docId && <button type="button" onClick={() => navigate(`/app/docs/${docId}`)} className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg" data-testid="call-dock-notes"><IconNotes className="h-3.5 w-3.5" aria-hidden /><span className="max-sm:hidden">{tr("meetings.notes")}</span></button>}
        <button type="button" onClick={expand} className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg" aria-label={tr("meetings.expand")} data-testid="call-dock-expand"><IconMaximize className="h-3.5 w-3.5" aria-hidden /><span className="max-sm:hidden">{tr("meetings.expand")}</span></button>
        <button type="button" onClick={leave} className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-danger/10 px-2 text-[12.5px] font-medium text-danger hover:bg-danger/15" data-testid="call-dock-leave"><IconPhoneOff className="h-3.5 w-3.5" aria-hidden />{tr("meetings.leave")}</button>
      </header>
      <div className="relative min-h-0 flex-1" data-lk-theme="default">
        {docked ? (
          docked.state === "failed" ? (
            <p className="p-4 text-[13px] text-muted" data-testid="call-dock-failed">{tr("meetings.couldn_t_connect_to_the_call_check_your_connecti")}</p>
          ) : (
            <CallStage session={docked}>
              <VideoConference />
              <CallRoomExtras meetingId={docked.meetingId} reportOnUnmount={false} />
              <LobbyRequests meetingId={docked.meetingId} className="absolute right-2 top-2 z-30 w-64 max-w-[calc(100%-1rem)]" />
            </CallStage>
          )
        ) : !prefs ? (
          <div className="h-full overflow-y-auto"><PreJoin compact title={call.title} who={{ mode: "member", name: me.data?.user?.name || me.data?.user?.email || "you", workspace: me.data?.organization?.name }} onJoin={setPrefs} onCancel={leave} /></div>
        ) : (
          <p className="p-4 text-[13px] text-muted">{join.error ? (join.error as Error).message : tr("meetings.connecting")}</p>
        )}
      </div>
    </section>
  );
}

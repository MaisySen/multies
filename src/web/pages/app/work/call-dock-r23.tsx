/**
 * Round 23 (R23.3): the docked call window and the room extras (a hint when the browser blocks
 * screen share, camera or microphone, and the leave signal). Loaded with LiveKit, only when needed.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { LiveKitRoom, VideoConference, useRoomContext } from "@livekit/components-react";
import "@livekit/components-styles";
import { RoomEvent } from "livekit-client";
import { IconClose, IconMaximize, IconNotes, IconPhoneOff, IconScreenShare } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { closeCallDock, useCallDock } from "./call-r23";
import { PreJoin, type JoinPrefs } from "./prejoin-r31";
import { useCallNotesDoc } from "./call-panel-r31";
import { DockSoFar, LobbyRequests } from "./lobby-r32";
import { roomMedia } from "@/web/lib/prejoin-prefs";
import { useMe } from "@/web/lib/queries";

/** Tells the server this app left the call, a moment after disconnecting, so an empty room ends the call once. */
function reportLeft(meetingId: string) {
  window.setTimeout(() => { void api.post(`/chat/calls/${meetingId}/left`, {}).catch(() => undefined); }, 2500);
}

/** Inside a LiveKitRoom: a short hint when the browser blocks screen share, camera or microphone, and the leave signal. */
export function CallRoomExtras({ meetingId }: { meetingId?: string }) {
  const room = useRoomContext();
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const onError = () => setBlocked(true);
    room.on(RoomEvent.MediaDevicesError, onError);
    return () => { room.off(RoomEvent.MediaDevicesError, onError); if (meetingId) reportLeft(meetingId); };
  }, [room, meetingId]);
  if (!blocked) return null;
  return (
    <div role="status" className="absolute left-1/2 top-3 z-20 flex max-w-md -translate-x-1/2 items-start gap-2 rounded-xl border border-line bg-elevated p-3 text-[12.5px] text-fg shadow-pop" data-testid="share-blocked">
      <IconScreenShare className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
      <p>Your browser blocked the screen, camera or microphone. Allow it from the icon at the left of the address bar, then try again. On a Mac, also allow screen recording for your browser in System Settings, Privacy and Security.</p>
      <button type="button" aria-label="Close hint" onClick={() => setBlocked(false)} className="text-subtle hover:text-fg"><IconClose className="h-3.5 w-3.5" /></button>
    </div>
  );
}

interface Join { url: string; token: string; room: string }

/**
 * The docked call: a floating window over the app, anchored bottom right, resizable from its top
 * left corner, so the person keeps reading and writing in chat. Expand opens the full meeting page.
 */
export function CallDock() {
  const call = useCallDock();
  const navigate = useNavigate();
  const [size, setSize] = useState({ w: 440, h: 380 });
  // Round 31: the pre-join step comes first; its choices carry into the room. The notes doc is made as the call starts.
  const [prefs, setPrefs] = useState<JoinPrefs | null>(null);
  const [prefsFor, setPrefsFor] = useState<string | undefined>(call?.meetingId);
  if (prefsFor !== call?.meetingId) { setPrefsFor(call?.meetingId); setPrefs(null); }
  const me = useMe();
  const docId = useCallNotesDoc(prefs ? call?.meetingId : undefined, true);
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  // Round 32: the token is asked for after pre-join, so a name changed for this call reaches the room.
  const join = useQuery({
    queryKey: ["call-dock", call?.meetingId, prefs?.name ?? ""], enabled: !!call && !!prefs, retry: false, staleTime: Infinity, gcTime: 0,
    queryFn: () => api.post<Join>(`/meetings/${call!.meetingId}/join`, prefs?.name ? { name: prefs.name } : {}),
  });
  if (!call) return null;
  const leave = () => { closeCallDock(); };
  const expand = () => { closeCallDock(); navigate(`${call.path}?join=1`); };
  const onDown = (e: ReactPointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, ...size }; (e.target as HTMLElement).setPointerCapture(e.pointerId); };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setSize({ w: Math.min(Math.max(320, d.w + d.x - e.clientX), window.innerWidth - 32), h: Math.min(Math.max(220, d.h + d.y - e.clientY), window.innerHeight - 32) });
  };
  return (
    <section aria-label={`Call: ${call.title}`} className="fixed bottom-[calc(1rem+var(--tabbar-h,0px))] right-4 z-40 flex flex-col overflow-hidden rounded-2xl border border-line bg-elevated shadow-pop" style={{ width: size.w, height: size.h }} data-testid="call-dock">
      <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} className="absolute left-0 top-0 z-10 h-4 w-4 cursor-nwse-resize" aria-hidden title="Resize" />
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-ok" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{call.title}</h2>
        {prefs && <DockSoFar meetingId={call.meetingId} />}
        {docId && <button type="button" onClick={() => navigate(`/app/docs/${docId}`)} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg" data-testid="call-dock-notes"><IconNotes className="h-3.5 w-3.5" aria-hidden />Notes</button>}
        <button type="button" onClick={expand} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg" data-testid="call-dock-expand"><IconMaximize className="h-3.5 w-3.5" aria-hidden />Expand</button>
        <button type="button" onClick={leave} className="inline-flex h-7 items-center gap-1 rounded-md bg-danger/10 px-2 text-[12.5px] font-medium text-danger hover:bg-danger/15" data-testid="call-dock-leave"><IconPhoneOff className="h-3.5 w-3.5" aria-hidden />Leave</button>
      </header>
      <div className="relative min-h-0 flex-1" data-lk-theme="default">
        {!prefs ? (
          <div className="h-full overflow-y-auto"><PreJoin compact title={call.title} who={{ mode: "member", name: me.data?.user?.name || me.data?.user?.email || "you" }} onJoin={setPrefs} onCancel={leave} /></div>
        ) : join.data ? (
          <LiveKitRoom serverUrl={join.data.url} token={join.data.token} connect {...roomMedia(prefs)} onDisconnected={leave} style={{ height: "100%" }}>
            <VideoConference />
            <CallRoomExtras meetingId={call.meetingId} />
            <LobbyRequests meetingId={call.meetingId} className="absolute right-2 top-2 z-30 w-64" />
          </LiveKitRoom>
        ) : (
          <p className="p-4 text-[13px] text-muted">{join.error ? (join.error as Error).message : "Connecting"}</p>
        )}
      </div>
    </section>
  );
}


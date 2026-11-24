/**
 * MEET fixes (12 Nov 2026): connects the tab's one call session (web/lib/call-session-meet.ts) to the video
 * service, and the stage both views draw it on. The meeting page and the floating call window each wrap the
 * same Room in <CallStage>, so moving between them never hangs up: the people, the audio and the camera carry on.
 * Loaded with LiveKit, only when a call opens.
 */
import type { CSSProperties, ReactNode } from "react";
import { RoomContext } from "@livekit/components-react";
import { Room, RoomEvent } from "livekit-client";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { loadPrefs, roomMedia, type JoinPrefs } from "@/web/lib/prejoin-prefs";
import { endCallSession, getCallSession, sessionFor, setCallState, startCallSession, type CallJoin, type CallSession, type CallView } from "@/web/lib/call-session-meet";

/** Tells the server this app left the call, a moment after hanging up, so an empty room ends the call once. */
export function reportLeft(meetingId: string) {
  window.setTimeout(() => { void api.post(`/chat/calls/${meetingId}/left`, {}).catch(() => undefined); }, 2500);
}

/** Joins the call (or returns the one this tab is already in for that meeting). */
export function beginCall(o: { meetingId: string; title: string; path: string; join: CallJoin; prefs?: JoinPrefs; view: CallView }): CallSession {
  const existing = sessionFor(o.meetingId);
  if (existing) return startCallSession({ ...o, connection: existing.connection }).session;
  const media = roomMedia(o.prefs ?? loadPrefs());
  const room = new Room(media.options);
  const { session, replaced } = startCallSession({ ...o, connection: room });
  if (replaced) reportLeft(replaced.meetingId);
  let connected = false;
  room.on(RoomEvent.Connected, () => { connected = true; setCallState(room, "connected"); });
  room.on(RoomEvent.Disconnected, () => {
    const s = getCallSession();
    if (!s || s.connection !== room) return; // hung up here: already handled
    if (connected) { endCallSession(s.meetingId); reportLeft(s.meetingId); } else setCallState(room, "failed", "disconnected");
  });
  room.connect(o.join.url, o.join.token)
    .then(() => Promise.all([
      room.localParticipant.setMicrophoneEnabled(!!media.audio, typeof media.audio === "object" ? media.audio : undefined),
      room.localParticipant.setCameraEnabled(!!media.video, typeof media.video === "object" ? media.video : undefined),
    ]).catch(() => undefined)) // a blocked camera or microphone shows the hint (MediaDevicesError), the call stays
    .catch((e: unknown) => setCallState(room, "failed", e instanceof Error ? e.message : "failed"));
  return session;
}

/** Leave: hang up, forget the call, and tell the server. */
export function leaveCall(meetingId: string) {
  if (endCallSession(meetingId)) reportLeft(meetingId);
}

/** The call's room for everything inside (the video grid, controls, recording, the lobby list). */
export function CallStage({ session, className, style, children }: { session: CallSession; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <RoomContext.Provider value={session.connection as Room}>
      <div className={cn("lk-room-container", className)} data-lk-theme="default" style={{ height: "100%", ...style }} data-call-state={session.state}>{children}</div>
    </RoomContext.Provider>
  );
}

/**
 * MEET fixes (12 Nov 2026): one call per browser tab, kept while the person moves around the app.
 *
 * Before this the meeting page owned its call: opening chat, tasks or any other page unmounted it, the video
 * service hung up, and the person dropped out of the meeting (and if they were alone the meeting ended and its
 * link stopped working). The floating call window (the dock) had its own, second connection. Now one session
 * holds the one connection, and the meeting page and the floating window are two views of it:
 *
 * - "full": the meeting page shows the call.
 * - "dock": the floating window over the app shows it (picture in picture inside the app).
 *
 * Leaving the meeting page while in the call turns the session into the dock; opening the meeting page again
 * (or Expand on the dock) turns it back. Only Leave, a hang up from the other side, or starting another call ends
 * it. This file is the state only, with no video code, so it is unit tested on its own (tests/meet-fix-pol6.test.ts);
 * call-session-room.tsx connects it to LiveKit.
 */
import { useSyncExternalStore } from "react";
import type { JoinPrefs } from "./prejoin-prefs";

export type CallView = "full" | "dock";
export type CallState = "connecting" | "connected" | "failed";
export interface CallJoin { url: string; token: string; room: string; meeting?: { id: string } }
/** What a view needs to hang up; the LiveKit Room in the app, a stub in tests. */
export interface CallConnection { disconnect(): unknown }

export interface CallSession<C extends CallConnection = CallConnection> {
  meetingId: string;
  title: string;
  /** The meeting page, for Expand. */
  path: string;
  join: CallJoin;
  prefs?: JoinPrefs;
  view: CallView;
  state: CallState;
  error?: string;
  connection: C;
}

let current: CallSession | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const f of listeners) f(); };
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

export function getCallSession(): CallSession | null { return current; }
export function useCallSession(): CallSession | null { return useSyncExternalStore(subscribe, () => current, () => null); }

/** The session for this meeting, if this tab is in its call (or connecting to it). */
export function sessionFor(meetingId: string | undefined): CallSession | null {
  return meetingId && current && current.meetingId === meetingId && current.state !== "failed" ? current : null;
}

/**
 * Starts the tab's call. One call at a time: a call to another meeting is hung up first (its leave is reported
 * by the caller from the returned `replaced`). A second start for the meeting already connected is refused (the
 * existing session is returned) so one person never joins twice from one tab, which the video service treats
 * as the same person and drops one of.
 */
export function startCallSession<C extends CallConnection>(s: Omit<CallSession<C>, "state"> & { state?: CallState }): { session: CallSession; started: boolean; replaced: CallSession | null } {
  const same = sessionFor(s.meetingId);
  if (same) { if (same.view !== s.view) setCallView(s.meetingId, s.view); return { session: current!, started: false, replaced: null }; }
  const replaced = current;
  if (replaced) safeDisconnect(replaced.connection);
  current = { ...s, state: s.state ?? "connecting" };
  emit();
  return { session: current, started: true, replaced };
}

/** Connection news from the video service. Ignored once the session is gone or replaced. */
export function setCallState(connection: CallConnection, state: CallState, error?: string) {
  if (!current || current.connection !== connection || (current.state === state && current.error === error)) return;
  current = { ...current, state, error };
  emit();
}

export function setCallView(meetingId: string, view: CallView) {
  if (!current || current.meetingId !== meetingId || current.view === view) return;
  current = { ...current, view };
  emit();
}

/** Hangs up and forgets the call. Returns the session that ended (null when there was none for that meeting). */
export function endCallSession(meetingId?: string): CallSession | null {
  if (!current || (meetingId && current.meetingId !== meetingId)) return null;
  const ended = current;
  current = null;
  safeDisconnect(ended.connection);
  emit();
  return ended;
}

/**
 * The meeting page is going away (the person opened another page in the app). A live or connecting call moves
 * to the floating window instead of hanging up; a call that failed to connect is dropped.
 */
export function meetingPageClosed(meetingId: string | undefined) {
  if (!meetingId || !current || current.meetingId !== meetingId) return;
  if (current.state === "failed") { endCallSession(meetingId); return; }
  setCallView(meetingId, "dock");
}

/** The meeting page opened: its call, if this tab has one, shows full size again. */
export function meetingPageOpened(meetingId: string | undefined) {
  if (meetingId && sessionFor(meetingId)) setCallView(meetingId, "full");
}

function safeDisconnect(c: CallConnection) {
  try { void Promise.resolve(c.disconnect()).catch(() => undefined); } catch { /* already gone */ }
}

/** The floating window's starting size. */
export const DOCK_SIZE = { w: 440, h: 380 };
/** The size it is drawn at: inside the screen with a margin (it used to run off a 375 px phone screen). */
export function dockSize(want: { w: number; h: number }, screen: { w: number; h: number }) {
  return { w: Math.max(Math.min(want.w, screen.w - 16), Math.min(280, screen.w - 16)), h: Math.max(Math.min(want.h, screen.h - 140), 200) };
}

/** Tests only. */
export function resetCallSessionForTests() { current = null; listeners.clear(); }

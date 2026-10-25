import { useEffect, useMemo, useRef, useState } from "react";
import { PenLine } from "lucide-react";
import { api, ApiError } from "@/web/lib/api";

/**
 * Round 22 (R22.3): live presence in a shared inbox thread. The open thread (or a reply to it in
 * Compose) beats every 15 seconds with its state; the answer is everyone else in the thread. The
 * server keeps this in memory only. Hidden tabs, closed threads and closed Compose windows leave.
 */
export type PresenceState = "viewing" | "replying";
export interface PresencePerson { userId: string; name: string; state: PresenceState; since: string; lastSeen: string; tabs: number }
export interface PresenceNote { type: "draft_taken_over"; draftId: string; byName: string; subject: string; at: string }
export interface PresenceView { people: PresencePerson[]; notes: PresenceNote[] }

const BEAT_MS = 15_000;
const EMPTY: PresenceView = { people: [], notes: [] };

export function useThreadPresence(threadId: string | null | undefined, state: PresenceState): PresenceView {
  const [view, setView] = useState<PresenceView>(EMPTY);
  const clientId = useMemo(() => Math.random().toString(36).slice(2) + Date.now().toString(36), []);
  const stateRef = useRef(state);
  const beatRef = useRef<() => void>(() => {});
  stateRef.current = state;

  useEffect(() => {
    if (!threadId) return;
    let stopped = false;
    const timer: { id?: ReturnType<typeof setInterval> } = {};
    const path = `/threads/${encodeURIComponent(threadId)}/presence`;
    const beat = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        const v = await api.post<PresenceView>(path, { clientId, state: stateRef.current });
        if (!stopped) setView(v);
      } catch (e) {
        // No access (or the thread is gone): stop beating.
        if (e instanceof ApiError && (e.status === 404 || e.status === 401 || e.status === 403)) { stopped = true; clearInterval(timer.id); }
      }
    };
    const leave = () => {
      void fetch(`/api${path}/leave`, { method: "POST", credentials: "same-origin", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) }).catch(() => {});
    };
    beatRef.current = () => void beat();
    timer.id = setInterval(() => void beat(), BEAT_MS);
    void beat();
    const onVisible = () => (document.visibilityState === "hidden" ? leave() : void beat());
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", leave);
    return () => {
      stopped = true;
      clearInterval(timer.id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", leave);
      beatRef.current = () => {};
      leave();
      setView(EMPTY);
    };
  }, [threadId, clientId]);

  // A change of state (viewing to replying) goes out at once, not at the next beat.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    beatRef.current();
  }, [state]);

  return view;
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

/** In Compose, above Send: someone else is replying to the same thread. Never blocks. */
export function AlsoReplying({ people }: { people: PresencePerson[] }) {
  const replying = people.filter((p) => p.state === "replying");
  if (!replying.length) return null;
  const names = replying.map((p) => firstName(p.name));
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return (
    <div role="status" data-testid="also-replying" className="flex shrink-0 items-center gap-2 border-t border-warn/20 bg-warn-soft px-4 py-2 text-[13px] text-warn">
      <PenLine className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{who} {replying.length === 1 ? "is" : "are"} also replying. Send anyway?</span>
    </div>
  );
}

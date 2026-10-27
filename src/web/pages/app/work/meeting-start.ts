import type { NavigateFunction } from "react-router";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { toast } from "sonner";

/** Makes a meeting from a thread, task or contact and opens it. Kept apart from the meeting page so the video code loads only there. */
/**
 * R40 (MB-207): Start now on the Meetings page. Makes a 30 minute meeting that starts this minute (the same create
 * call as Schedule), copies the guest link and opens the room page ready to join. Returns the meeting id, or null.
 */
export async function startMeetingNow(navigate: NavigateFunction, copy: (text: string) => Promise<void> = (t) => navigator.clipboard.writeText(t)): Promise<string | null> {
  try {
    const r = await api.post<{ meeting: { id: string; guestUrl?: string } }>("/meetings", { title: "Meeting now", startsAt: new Date().toISOString(), durationMin: 30 });
    let copied = false;
    if (r.meeting.guestUrl) { try { await copy(r.meeting.guestUrl); copied = true; } catch { /* clipboard blocked: the link is on the meeting page */ } }
    toast.success(copied ? "Meeting started. Guest link copied" : "Meeting started. Share the guest link from the meeting page");
    navigate(`/app/meetings/${r.meeting.id}?join=1`);
    return r.meeting.id;
  } catch (e) { showError(e as Error); return null; }
}

export async function startMeeting(source: { type: "thread" | "task" | "contact"; id: string }, navigate: NavigateFunction) {
  try {
    const r = await api.post<{ meeting: { id: string } }>("/meetings", { source });
    navigate(`/app/meetings/${r.meeting.id}`);
  } catch (e) { showError(e as Error); }
}

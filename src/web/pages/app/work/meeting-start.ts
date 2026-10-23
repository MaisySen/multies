import type { NavigateFunction } from "react-router";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";

/** Makes a meeting from a thread, task or contact and opens it. Kept apart from the meeting page so the video code loads only there. */
export async function startMeeting(source: { type: "thread" | "task" | "contact"; id: string }, navigate: NavigateFunction) {
  try {
    const r = await api.post<{ meeting: { id: string } }>("/meetings", { source });
    navigate(`/app/meetings/${r.meeting.id}`);
  } catch (e) { showError(e as Error); }
}

/**
 * VID1: the permit for a video recording of a call. The video is composited and recorded in the admin's own
 * browser and saved on their device; nothing is uploaded and nothing is stored here. This only answers who may
 * start one: owners and admins of the workspace the meeting belongs to, while VIDEO_REC_VID1 is on. It writes
 * nothing. Loaded inside the route handler so Worker startup does not grow.
 */
import type { Deps } from "../../context";
import { HttpError, notFound } from "../../lib/errors";
import type { SuiteActor } from "./common";
import { getMeeting } from "./meetings";
import { featureOn } from "../console/flags"; // OPS1 feature flags

export const VIDEO_ADMIN_ONLY = "Only workspace owners and admins can record video.";

export async function videoRecordingPermit(deps: Deps, a: SuiteActor, meetingId: string) {
  if (!featureOn(deps, "videoRecVid1", a.orgId) || !deps.config.meetings) throw notFound("Page"); // OPS1: per workspace flag
  if (a.agentId || a.apiKeyId || !a.userId) throw new HttpError(403, "forbidden", "People record video from the meeting room.");
  const meeting = await getMeeting(deps, a, meetingId);
  if (a.role !== "owner" && a.role !== "admin") throw new HttpError(403, "video_recording_admin_only", VIDEO_ADMIN_ONLY);
  if (meeting.status === "cancelled") throw new HttpError(409, "meeting_cancelled", "This meeting was cancelled.");
  return { ok: true as const, meeting: { id: meeting.id, title: meeting.title } };
}

/**
 * Round 23 (R23.2): recording a call from the meeting room (cookie session). The browser uploads each
 * audio chunk as base64 in JSON (the app's cookie routes take JSON only), the server sends it on to the
 * workspace's own OpenAI or Groq key and keeps only the text. Mounted beside meetingRoutes at /api/meetings.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { fromB64 } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import { parseBody, requireAuth } from "../middleware";
import { MAX_CHUNK_BYTES } from "../services/ai/transcribe";
import { appendChunk, deleteRecording, listRecordings, recordingSetup, startRecording, stopRecording } from "../services/suite/meeting-recordings";

/** Base64 of a 24 MB chunk plus the JSON around it. */
const MAX_REQUEST_BYTES = Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 4096;

export const ChunkBody = z.object({
  audioBase64: z.string().min(1),
  mime: z.string().max(100).optional(),
  /** Where in the call this chunk starts, in seconds (shown as [mm:ss] in the transcript). */
  offsetSec: z.number().min(0).max(86_400).nullable().optional(),
  /** How long the recording has run so far, in seconds. */
  durationSec: z.number().min(0).max(86_400).nullable().optional(),
});
export const StopBody = z.object({ durationSec: z.number().min(0).max(86_400).nullable().optional() });

export function meetingRecordingRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/:id/recordings", async (c) => c.json({ recordings: await listRecordings(c.var.deps, c.var.auth, c.req.param("id")), setup: await recordingSetup(c.var.deps, c.var.auth) }))
    // VID1: who may save a video of the call on their own device (owners and admins; 404 while VIDEO_REC_VID1 is off). Writes nothing.
    .post("/:id/recordings/video", async (c) => {
      const { videoRecordingPermit } = await import("../services/suite/video-rec-vid1");
      return c.json(await videoRecordingPermit(c.var.deps, c.var.auth, c.req.param("id")));
    })
    .post("/:id/recordings", async (c) => {
      const r = await startRecording(c.var.deps, c.var.auth, c.req.param("id"));
      return c.json(r, r.joined ? 200 : 201);
    })
    .put("/:id/recordings/:rid/chunks/:seq", async (c) => {
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > MAX_REQUEST_BYTES) throw new HttpError(413, "chunk_too_large", "That audio chunk is over 24 MB. Upload it in smaller pieces.");
      const seq = /^\d{1,6}$/.test(c.req.param("seq")) ? Number(c.req.param("seq")) : -1;
      const b = await parseBody(c, ChunkBody);
      let audio: Uint8Array;
      try { audio = fromB64(b.audioBase64); } catch { throw new HttpError(422, "validation_failed", "audioBase64 must be base64."); }
      return c.json(await appendChunk(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("rid"), { seq, audio, mime: b.mime ?? "audio/webm", offsetSec: b.offsetSec ?? null, durationSec: b.durationSec ?? null }));
    })
    .post("/:id/recordings/:rid/stop", async (c) => c.json(await stopRecording(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("rid"), await parseBody(c, StopBody))))
    .delete("/:id/recordings/:rid", async (c) => c.json(await deleteRecording(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("rid"))));
}

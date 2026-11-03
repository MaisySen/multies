/**
 * VID1: an owner or admin saves a video of the whole call on their own device. This file holds the "Record this
 * call" dialog and the hook that runs one video recording; the compositor and recorder load only when a video
 * recording starts (dynamic import). Nothing is uploaded: the server only answers who may start one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { IconFolder, IconVideo, IconWarning } from "@/web/components/ui/icon";
import { pickVideoType, sizeText, videoFileName, type Saved, type VideoEvent, type Writable } from "@/web/lib/video-rec-vid1";
import type { VideoSession } from "@/web/lib/video-session-vid1";
import type { LayoutMode, PieceStore, Quality, QualityId } from "@/web/lib/video-rec-vid2";
import { RecordSettings } from "./video-vid2-ui";
import { iosTooOld, partFileName, pickPhoneVideoType, readyVideos } from "@/web/lib/video-phone-vid3";
import { t as tt } from "@/web/i18n";

export const VIDEO_INTRO = "A video of the whole call is saved to this device when you stop. Nothing is uploaded.";
export const VIDEO_TRANSCRIPT_ON = "A transcript and summary are made too, as with every recording.";
export const VIDEO_TRANSCRIPT_OFF = "The transcript is off. Add an AI key in Settings > AI to get one with the video.";
/** PAR1: the workspace AI switch is off: the video records, nothing goes to an AI provider. */
export const VIDEO_TRANSCRIPT_AI_OFF = "AI is off for this workspace, so no transcript is made. The video still records.";
export const VIDEO_BANNER_NOTE = "Everyone in the call sees a Recording banner while you record.";
export const VIDEO_FILE_HINT = "Choose where to save the video. It is written as the call goes, so long calls are fine.";
export const VIDEO_MEMORY_HINT = "The video is kept in this tab and saved when you stop. For calls over an hour, Chrome or Edge can save it as it records.";
export const VIDEO_UNSUPPORTED = "This browser can't record video. You can still record audio and a transcript.";
export const VIDEO_CONSENT_SELF = "Everyone in the call sees that you are saving a video of it on this device.";
export const VIDEO_CONSENT_OTHERS = "They keep the video on their own device. Everyone in the call sees this.";

type Picker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ name: string; createWritable: () => Promise<Writable>; remove?: () => Promise<void> }>;
const picker = () => (typeof window !== "undefined" ? (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker : undefined);

/** What this browser can do: the recording type, and whether it can write to a file as the call goes. */
export function videoSupport(phone = false) {
  const MR = (globalThis as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder;
  const canvasOk = typeof document !== "undefined" && typeof (document.createElement("canvas") as HTMLCanvasElement & { captureStream?: unknown }).captureStream === "function";
  const pick = phone ? pickPhoneVideoType : pickVideoType; // VID3: mp4 first on a phone (Photos and the gallery take it)
  const type = canvasOk && typeof AudioContext !== "undefined" ? pick(MR?.isTypeSupported?.bind(MR)) : null;
  // VID3: a phone keeps the video for a Save tap (phone browsers have no save picker; an emulated one is ignored).
  return { type, file: !phone && !!picker() && typeof window !== "undefined" && window.isSecureContext };
}

export function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface VideoStartArgs { writable: Writable | null; fileName: string; mime: string; audio: MediaStream | null; transcript: boolean;
  /** VID2: quality, the layout (read every frame), the meeting for recovery, and the side files written at the end. */
  vid2?: { quality: Quality; layout: () => LayoutMode; meetingId: string | null; title: string; sideFiles: (fileName: string) => { name: string; text: string }[] };
  /** VID3: recording on a phone: saved in parts at the phone's memory budget, and kept for the person's Save tap (no download on its own). */
  phone?: { warn: number; part: number } }

/** VID2: a text file saved next to the video (chat log, transcript). */
export function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  download(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** One video recording in this room: start, stop and save, the size warning, errors, leaving the page. */
export function useVideoRecording(room: Room) {
  const session = useRef<VideoSession | null>(null);
  const meta = useRef<{ fileName: string; file: boolean; transcript: boolean; vid2?: VideoStartArgs["vid2"]; phone?: VideoStartArgs["phone"]; part: number; offsetSec: number; mime: string } | null>(null);
  /** VID3: a part is being saved while the next one starts. */
  const rolling = useRef(false);
  const keep = useRef<PieceStore | null>(null);
  const [active, setActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [fps, setFps] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [saved, setSaved] = useState<{ url: string; name: string } | null>(null);
  const stopRef = useRef<() => Promise<Saved | null>>(async () => null);
  const partRef = useRef<() => Promise<void>>(async () => undefined);

  const finish = useCallback(async (): Promise<Saved | null> => {
    const s = session.current;
    const m = meta.current;
    if (!s || !m) return null;
    session.current = null;
    let out: Saved | null = null;
    // VID2: saving is never silent: the size so far while the last pieces are written.
    if (m.vid2) toast.loading(`Saving the video, ${sizeText(s.recording.bytes || 1)}`, { id: "video-saving", description: m.fileName });
    try {
      out = await s.stop();
    } catch (e) {
      showError(e as Error);
    }
    setActive(false);
    setPaused(false);
    toast.dismiss("video-size");
    if (m.vid2) toast.dismiss("video-saving");
    if (m.phone && out?.kind === "memory" && out.blob && out.blob.size) {
      // VID3: a phone only opens its share sheet from a tap, so the video waits for the person's Save tap.
      const k = keep.current;
      readyVideos.add(partFileName(m.fileName, m.part), out.blob, { group: m.fileName, keepId: k?.id ?? null, release: k ? () => void k.finish().catch(() => undefined) : null });
      if (out.reason !== "error") toast.success(tt("meetingrec.video_ready", { size: sizeText(out.blob.size) }));
    } else if (out?.kind === "memory" && out.blob && out.blob.size) {
      const url = URL.createObjectURL(out.blob);
      setSaved((old) => { if (old) URL.revokeObjectURL(old.url); return { url, name: m.fileName }; });
      download(url, m.fileName);
      if (out.reason !== "error") toast.success(m.vid2 ? `Video saved, ${sizeText(out.blob.size)}` : "Video saved", { description: m.fileName });
    } else if (out?.kind === "file" && out.bytes > 0) {
      if (out.reason !== "error") toast.success(m.vid2 ? `Video saved, ${sizeText(out.bytes)}` : "Video saved", { description: `Saved to ${m.fileName}` });
    } else if (out && out.reason !== "error") {
      toast.error("The video was empty, so nothing was saved.");
    }
    // VID2: the chat (and anything else asked for) saved next to the video, then the pieces on the device go.
    const savedOk = !!out && ((out.kind === "memory" && !!out.blob?.size) || (out.kind === "file" && out.bytes > 0));
    if (m.vid2 && savedOk && m.phone) {
      // VID3: the chat joins the video in the Save list (one share with it when the phone takes several files).
      for (const f of m.vid2.sideFiles(m.fileName)) readyVideos.addSide(m.fileName, f);
    } else if (m.vid2 && savedOk) {
      for (const f of m.vid2.sideFiles(m.fileName)) saveText(f.name, f.text);
      // The pieces go in the background: ending the banner for everyone never waits on the device's storage.
      const k = keep.current;
      if (k) void k.finish().catch(() => undefined);
    }
    keep.current = null;
    return out;
  }, []);
  stopRef.current = finish;

  const onEvent = useCallback((e: VideoEvent) => {
    const m = meta.current;
    if (e.type === "warn" && m?.phone) {
      toast.warning(tt("meetingrec.part_warn", { size: sizeText(e.bytes) }), {
        id: "video-size",
        duration: Infinity,
        description: tt("meetingrec.part_warn_hint"),
        action: { label: tt("meetingrec.save_part"), onClick: () => void partRef.current() },
      });
    } else if (e.type === "limit" && m?.phone) {
      toast(tt("meetingrec.part_saved", { size: sizeText(e.bytes) }), { description: tt("meetingrec.part_saved_hint") });
      void partRef.current();
    } else if (e.type === "warn") {
      toast.warning(`The video is ${sizeText(e.bytes)} so far`, {
        id: "video-size",
        duration: Infinity,
        description: "This browser keeps it in memory. Stop and save now to keep it safe, then start a new recording if you need to.",
        action: { label: "Stop and save", onClick: () => void stopRef.current() },
      });
    } else if (e.type === "limit") {
      toast.warning(`The video reached ${sizeText(e.bytes)}, so it was stopped and saved.`, { description: "Start a new recording to keep going." });
      void stopRef.current();
    } else if (e.type === "error") {
      toast.error(`The video stopped recording: ${e.message}.`, { description: m?.transcript ? "What was recorded is saved. The transcript keeps going." : "What was recorded is saved." });
      void stopRef.current();
    }
  }, []);

  const start = useCallback(async (a: VideoStartArgs) => {
    const { startVideoSession } = await import("@/web/lib/video-session-vid1");
    meta.current = { fileName: a.fileName, file: !!a.writable, transcript: a.transcript, vid2: a.vid2, phone: a.phone, part: 1, offsetSec: 0, mime: a.mime };
    let draw: Parameters<typeof startVideoSession>[0]["draw"];
    if (a.vid2) {
      // VID2: every piece is kept on this device as it comes, so a crash or a closed tab loses nothing.
      const [{ PieceStore }, { idbBackend, keepStorage }] = await Promise.all([import("@/web/lib/video-rec-vid2"), import("@/web/lib/video-store-vid2")]);
      void keepStorage();
      keep.current = new PieceStore(idbBackend, { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, meetingId: a.vid2.meetingId, title: a.vid2.title, fileName: a.fileName, mime: a.mime, startedAt: Date.now() });
      keep.current.onFail = (reason) => toast.warning("This video isn't being kept safe on this device", { description: `It still records and saves when you stop. The browser said: ${reason}`, duration: 15_000 });
      await keep.current.begin();
      const q = a.vid2.quality;
      draw = { width: q.w, height: q.h, fps: q.fps, layout: a.vid2.layout, onFps: (f) => setFps(f) };
      setFps(q.fps);
    }
    try {
      session.current = await startVideoSession({ room, audio: a.audio, mime: a.mime, writable: a.writable, onEvent, draw, videoBits: a.vid2?.quality.videoBits, keep: keep.current ?? undefined,
        limits: a.phone && !a.writable ? { warn: a.phone.warn, hard: a.phone.part } : undefined });
    } catch (e) {
      await keep.current?.finish().catch(() => undefined);
      keep.current = null;
      throw e;
    }
    setElapsed(0);
    setPaused(false);
    setActive(true);
  }, [room, onEvent]);

  // While recording: the clock, a warning before closing or reloading the tab, and stop and save on leaving.
  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setElapsed((meta.current?.offsetSec ?? 0) + (session.current?.recording.elapsedSec ?? 0)), 1000);
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    // The call itself hangs up on beforeunload, before the person can choose to stay. While a video records it
    // hangs up on pagehide only (when the page really goes), so choosing Stay keeps the call and the recording.
    const hangUp = (room as unknown as { onPageLeave?: EventListener }).onPageLeave;
    if (typeof hangUp === "function") window.removeEventListener("beforeunload", hangUp);
    return () => {
      clearInterval(tick);
      window.removeEventListener("beforeunload", warn);
      if (typeof hangUp === "function" && room.state !== "disconnected") window.addEventListener("beforeunload", hangUp);
    };
  }, [active, room]);
  // Leaving the room or the page while recording: stop and save what was recorded; the last saved link is freed later.
  const savedUrl = useRef<string | null>(null);
  savedUrl.current = saved?.url ?? null;
  useEffect(() => () => {
    if (session.current) void stopRef.current();
    const url = savedUrl.current;
    if (url) setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);
  const mixer = useCallback(() => session.current?.mixer ?? null, []);

  /** VID2: pause and resume. Answers whether it took (false when this browser can't pause a recording). */
  const pause = useCallback(() => {
    const ok = !!session.current?.recording.pause();
    if (ok) { setPaused(true); setElapsed((meta.current?.offsetSec ?? 0) + (session.current?.recording.elapsedSec ?? 0)); }
    return ok;
  }, []);
  const resume = useCallback(() => {
    const ok = !!session.current?.recording.resume();
    if (ok) setPaused(false);
    return ok;
  }, []);

  /**
   * VID3: saves what is recorded so far as a part (it joins the Save list) and keeps recording into a new part at
   * once, on the same picture and sound. Used at a phone's memory budget, and from the warning's Save this part.
   */
  const savePart = useCallback(async () => {
    const s = session.current;
    const m = meta.current;
    if (!s || !m?.phone || m.file || rolling.current) return;
    rolling.current = true;
    toast.dismiss("video-size");
    const wasPaused = s.recording.paused;
    const old = s.recording;
    const oldKeep = keep.current;
    let nextKeep: PieceStore | null = null;
    try {
      if (m.vid2 && oldKeep) {
        const [{ PieceStore: Store }, { idbBackend }] = await Promise.all([import("@/web/lib/video-rec-vid2"), import("@/web/lib/video-store-vid2")]);
        nextKeep = new Store(idbBackend, { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, meetingId: m.vid2.meetingId, title: m.vid2.title, fileName: partFileName(m.fileName, m.part + 1), mime: m.mime, startedAt: Date.now() });
        await nextKeep.begin();
      }
      const out = await s.rollover({ keep: nextKeep ?? undefined });
      if (session.current !== s) return;
      m.offsetSec += old.elapsedSec;
      if (out.blob && out.blob.size) {
        readyVideos.add(partFileName(m.fileName, m.part), out.blob, { group: m.fileName, keepId: oldKeep?.id ?? null, release: oldKeep ? () => void oldKeep.finish().catch(() => undefined) : null });
      }
      m.part += 1;
      keep.current = nextKeep;
      if (wasPaused && s.recording.pause()) setPaused(true);
    } catch (e) {
      showError(e as Error);
    } finally {
      rolling.current = false;
    }
  }, []);
  partRef.current = savePart;

  return { active, elapsed, saved, start, stop: finish, mixer, paused, pause, resume, fps, savePart };
}

/** The "Record this call" dialog: what is saved where, whether a transcript comes too, then start. */
export function VideoRecordDialog({ open, onClose, meetingId, title, transcriptReady, aiOff = false, canAudioOnly, onAudioOnly, onStart, vid2, phone = false }: {
  open: boolean; onClose: () => void; meetingId: string; title?: string; transcriptReady: boolean; aiOff?: boolean; canAudioOnly: boolean;
  onAudioOnly: () => void; onStart: (writable: Writable | null, fileName: string, mime: string) => Promise<void>;
  /** VID2: layout and quality picked before starting (the layout can change again while recording). */
  vid2?: { layout: LayoutMode; setLayout: (l: LayoutMode) => void; quality: QualityId; setQuality: (q: QualityId) => void; hd: boolean };
  /** VID3: recording on a phone (mp4 first, kept until the person taps Save, plain words for an old iPhone). */
  phone?: boolean;
}) {
  const [permit, setPermit] = useState<{ ok: boolean; title: string | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState<"file" | "memory" | null>(null);
  const support = useRef(videoSupport(phone));

  useEffect(() => {
    if (!open) return;
    support.current = videoSupport(phone);
    setPermit(null);
    let live = true;
    api.post<{ ok: true; meeting: { title: string | null } }>(`/meetings/${meetingId}/recordings/video`, {})
      .then((r) => { if (live) setPermit({ ok: true, title: r.meeting.title, error: null }); })
      .catch((e: Error) => { if (live) setPermit({ ok: false, title: null, error: e.message || "You can't record video in this call." }); });
    return () => { live = false; };
  }, [open, meetingId, phone]);

  const type = support.current.type;
  const fileName = (ext: "webm" | "mp4") => videoFileName(permit?.title ?? title ?? "", new Date(), ext);

  const go = async (mode: "file" | "memory") => {
    if (!type || !permit?.ok) return;
    const name = fileName(type.ext);
    let writable: Writable | null = null;
    let handle: Awaited<ReturnType<Picker>> | null = null;
    if (mode === "file") {
      const pick = picker();
      if (!pick) return;
      try {
        // Called first, inside the click: browsers only open the save picker for a direct click.
        handle = await pick({ suggestedName: name, types: [{ description: "Video", accept: { [type.mime.split(";")[0]]: [`.${type.ext}`] } }] });
        writable = await handle.createWritable();
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        toast.error("Couldn't open that file for writing. Try another place, or save at the end instead.");
        return;
      }
    }
    setBusy(mode);
    try {
      await onStart(writable, handle?.name ?? name, type.mime);
    } catch (e) {
      await writable?.close().catch(() => undefined);
      await handle?.remove?.().catch(() => undefined);
      toast.error(`The video couldn't start: ${(e as Error).message || "the browser refused"}.`);
    } finally { setBusy(null); }
  };

  const footer = !type ? (
    <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:justify-end">
      <Button variant="ghost" className="max-sm:w-full" onClick={onClose}>Close</Button>
      {canAudioOnly && <Button className="max-sm:w-full" onClick={onAudioOnly} data-testid="video-rec-audio-only">Record audio only</Button>}
    </div>
  ) : support.current.file ? (
    <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:justify-end">
      <Button variant="ghost" className="max-sm:w-full" onClick={() => void go("memory")} loading={busy === "memory"} disabled={!permit?.ok || !!busy} data-testid="video-rec-memory">Save at the end instead</Button>
      <Button className="max-sm:w-full" onClick={() => void go("file")} loading={busy === "file"} disabled={!permit?.ok || !!busy} data-testid="video-rec-file"><IconFolder className="h-4 w-4" />Choose where to save</Button>
    </div>
  ) : (
    <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:justify-end">
      <Button variant="ghost" className="max-sm:w-full" onClick={onClose}>Cancel</Button>
      <Button className="max-sm:w-full" onClick={() => void go("memory")} loading={busy === "memory"} disabled={!permit?.ok || !!busy} data-testid="video-rec-memory"><IconVideo className="h-4 w-4" />Start recording</Button>
    </div>
  );

  return (
    <Dialog open={open} onClose={onClose} title="Record this call" footer={footer}>
      <div className="space-y-3 text-[13px]" data-testid="video-rec-dialog">
        {!type ? (
          <p className="flex items-start gap-2 text-fg" data-testid="video-rec-unsupported"><IconWarning className="mt-0.5 h-4 w-4 shrink-0 text-muted" />{phone && typeof navigator !== "undefined" && iosTooOld(navigator.userAgent) ? tt("meetingrec.ios_too_old") : phone ? tt("meetingrec.phone_unsupported") : VIDEO_UNSUPPORTED}</p>
        ) : (
          <>
            <p className="text-fg">{VIDEO_INTRO}</p>
            <p className={transcriptReady ? "text-muted" : "text-fg"} data-testid="video-rec-transcript">{transcriptReady ? VIDEO_TRANSCRIPT_ON : aiOff ? VIDEO_TRANSCRIPT_AI_OFF : VIDEO_TRANSCRIPT_OFF}</p>
            <p className="text-muted">{VIDEO_BANNER_NOTE}</p>
            {vid2 && <RecordSettings {...vid2} />}
            <p className="rounded-lg border border-line px-3 py-2 text-muted" data-testid="video-rec-where">{support.current.file ? VIDEO_FILE_HINT : phone ? tt("meetingrec.phone_hint") : VIDEO_MEMORY_HINT}</p>
          </>
        )}
        {permit && !permit.ok && <p role="alert" className="text-danger" data-testid="video-rec-refused">{permit.error}</p>}
      </div>
    </Dialog>
  );
}

/**
 * Round 23 (R23.2): recording a call. RecordingLayer sits inside the LiveKit room: the Record control,
 * the red Recording banner everyone in the call sees (a data message on RECORDING_TOPIC, sent again
 * whenever someone joins), and a one time notice for people who join while it is on. RecordingSection
 * is the meeting page's "Recording and transcript" list. Transcripts run on the workspace's own OpenAI or
 * Groq key; without one the Record control opens a setup prompt.
 */
import { LoadErrorInline } from "@/web/components/load-error-t1g"; // POL1
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, Track, type RemoteTrack } from "livekit-client";
import { IconChecklist, IconCircle, IconDocs, IconDownload, IconKey, IconMic, IconSquare, IconTrash, IconVideo } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { useConfig, useMe } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { zonedDateTime } from "@/web/lib/format";
import { showError } from "@/web/lib/show-error";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { useDialogs } from "@/web/components/ui/confirm";
import { Dialog } from "@/web/components/ui/dialog";
import { Badge, Card } from "@/web/components/ui/misc";
import { blobToBase64, CallRecorder, decodeSignal, encodeSignal, RECORDING_TOPIC, UploadQueue, type Chunk, type RecordingSignal } from "@/web/lib/call-recorder";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows"; // R30
import { useVideoRecording, VideoRecordDialog, VIDEO_CONSENT_OTHERS, VIDEO_CONSENT_SELF } from "./video-record-vid1"; // VID1
import type { Writable } from "@/web/lib/video-rec-vid1"; // VID1

export interface ActionItem { text: string; assignee: string | null; due: string | null }
export interface Recording {
  id: string; meetingId: string; status: "recording" | "processing" | "done" | "failed"; stale: boolean;
  startedBy: { id: string; name: string }; startedAt: string; endedAt: string | null; durationSec: number; chunks: number;
  transcript: string; truncated: boolean; summary: string | null; actionItems: ActionItem[]; provider: string | null; error: string | null;
}
export interface RecordingSetup { ready: boolean; provider: string | null; providerName: string | null; code: string | null; message: string | null; canConfigure: boolean }
interface RecordingList { recordings: Recording[]; setup: RecordingSetup }

export const SETUP_TEXT = "Add your OpenAI or Groq key in Settings > AI to record and transcribe. Multies doesn't charge for this; your provider bills your key.";
/** POL1: what the meeting page says while recording is not set up (admins can act, members are told who can). */
export const SETUP_ADMIN_TEXT = "Recording and transcripts need an AI key that can turn speech into text. Add one in Settings > AI. Multies doesn't charge for this.";
export const SETUP_MEMBER_TEXT = "Recording isn't set up for this workspace yet. An admin can turn it on in Settings > AI.";
export const CONSENT_TEXT = "Everyone in the call sees that this is being recorded.";
const isSetupCode = (code: string | null | undefined) => !!code && code.startsWith("recording_needs_");

export const duration = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min${s && m < 10 ? ` ${s} s` : ""}` : `${s} s`;
};

/** The setup prompt: a link to Settings > AI for owners and admins, "ask an admin" for everyone else. */
export function RecordSetupPrompt({ setup, compact }: { setup: Pick<RecordingSetup, "canConfigure" | "providerName" | "provider"> | null; compact?: boolean }) {
  const wrong = setup?.provider && setup.provider !== "openai" && setup.provider !== "groq";
  return (
    <div className={compact ? "" : "flex items-start gap-3"} data-testid="record-setup">
      {!compact && <IconKey className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
      <div className="min-w-0 flex-1 text-[13px]">
        {/* POL1: plain words without provider names; only people who can act are asked to. */}
        {setup?.canConfigure ? (
          <>
            {wrong && <p className="mb-1 text-muted">The AI key in Settings can't turn speech into text.</p>}
            <p className="text-fg">{SETUP_ADMIN_TEXT}</p>
            <ButtonLink size="sm" variant="secondary" className="mt-3" to="/app/settings#ai" data-testid="record-setup-link">Open Settings &gt; AI</ButtonLink>
          </>
        ) : <p className="text-muted" data-testid="record-ask-admin">{SETUP_MEMBER_TEXT}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- in the room

type Join = { meeting?: { id: string } } & Record<string, unknown>;

/** Inside <LiveKitRoom>. Members get the Record control; everyone (guests too) gets the banner. */
export function RecordingLayer({ join, title }: { join: unknown; title?: string }) {
  const meetingId = (join as Join | null)?.meeting?.id ?? null;
  const room = useRoomContext();
  const me = useMe();
  const config = useConfig();
  const myName = me.data?.user?.name || me.data?.user?.email || "Someone";
  // VID1: owners and admins can also save a video of the call on their own device (VIDEO_REC_VID1).
  const role = me.data?.organization?.role;
  const vid1 = !!config.data?.videoRecVid1; // VID1 on: the Stop control is solid red so it reads over any video
  const videoAllowed = vid1 && !!me.data?.user && (role === "owner" || role === "admin");
  const video = useVideoRecording(room);
  const { active: videoActive, mixer: videoMixer } = video;
  const [videoOpen, setVideoOpen] = useState(false);
  const [signal, setSignal] = useState<RecordingSignal | null>(null);
  const [mine, setMine] = useState<{ id: string; startedAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setup, setSetup] = useState<RecordingSetup | null>(null);
  const [download, setDownload] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<CallRecorder | null>(null);
  const queue = useRef<UploadQueue | null>(null);
  const noticed = useRef(false);
  const noticedVideo = useRef(false);
  /** What this person is broadcasting while they record (sent again to everyone who joins). */
  const mySignal = useRef<RecordingSignal | null>(null);
  const stopping = useRef(false);
  const recordingMine = !!mine || video.active;

  const broadcast = useCallback(async (s: RecordingSignal) => {
    try { await room.localParticipant.publishData(encodeSignal(s), { reliable: true, topic: RECORDING_TOPIC }); } catch { /* the banner still shows locally */ }
  }, [room]);
  const announce = useCallback((s: RecordingSignal | null) => {
    mySignal.current = s;
    setSignal(s);
    if (s) { noticed.current = true; noticedVideo.current = noticedVideo.current || !!s.video; void broadcast(s); }
  }, [broadcast]);

  // The banner: data messages from whoever records.
  useEffect(() => {
    const onData = (payload: Uint8Array, _p?: unknown, _k?: unknown, topic?: string) => {
      if (topic !== RECORDING_TOPIC) return;
      const s = decodeSignal(payload);
      if (!s) return;
      setSignal(s.on ? s : null);
      if (s.on && s.video && !noticedVideo.current) {
        noticedVideo.current = true;
        noticed.current = true;
        toast(`${s.by} is saving a video of this call`, { description: VIDEO_CONSENT_OTHERS });
      } else if (s.on && !noticed.current) { noticed.current = true; toast(`${s.by} is recording this call`, { description: CONSENT_TEXT }); }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room]);

  // A member who joins late reads the state once from the server (no polling in the room).
  useEffect(() => {
    if (!meetingId) return;
    let live = true;
    api.get<RecordingList>(`/meetings/${meetingId}/recordings`).then((r) => {
      if (!live) return;
      setSetup(r.setup);
      const on = r.recordings.find((x) => x.status === "recording" && !x.stale);
      if (on && !recorder.current && !mySignal.current) {
        setSignal((cur) => cur ?? { on: true, by: on.startedBy.name, recordingId: on.id, startedAt: on.startedAt });
        if (!noticed.current) { noticed.current = true; toast(`${on.startedBy.name} is recording this call`, { description: CONSENT_TEXT }); }
      }
    }).catch(() => undefined);
    return () => { live = false; };
  }, [meetingId]);

  // While recording: every remote audio track joins the mix(es), and newcomers hear that it is on.
  useEffect(() => {
    if (!recordingMine) return;
    const mixers = () => [recorder.current, videoMixer()].filter((m): m is NonNullable<typeof m> => !!m);
    const onTrack = (track: RemoteTrack) => { if (track.kind === Track.Kind.Audio) for (const m of mixers()) m.addTrack(track.mediaStreamTrack); };
    const onGone = (track: RemoteTrack) => { if (track.kind === Track.Kind.Audio) for (const m of mixers()) m.removeTrack(track.mediaStreamTrack); };
    const onJoin = () => { if (mySignal.current) void broadcast(mySignal.current); };
    const onLocal = () => { const t = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack; if (t) for (const m of mixers()) m.addTrack(t); };
    room.on(RoomEvent.TrackSubscribed, onTrack).on(RoomEvent.TrackUnsubscribed, onGone).on(RoomEvent.ParticipantConnected, onJoin).on(RoomEvent.LocalTrackPublished, onLocal);
    const tick = setInterval(() => setElapsed(recorder.current?.elapsedSec ?? 0), 1000);
    return () => { room.off(RoomEvent.TrackSubscribed, onTrack).off(RoomEvent.TrackUnsubscribed, onGone).off(RoomEvent.ParticipantConnected, onJoin).off(RoomEvent.LocalTrackPublished, onLocal); clearInterval(tick); };
  }, [recordingMine, room, broadcast, videoMixer]);

  /** The audio recording for the transcript (R23.2). Answers the started recording, or null when it did not start. */
  const startAudio = async (o: { quiet?: boolean } = {}): Promise<{ id: string; startedAt: string } | null> => {
    if (!meetingId) return null;
    if (setup && !setup.ready) { if (!o.quiet) setSetupOpen(true); return null; }
    if (typeof MediaRecorder === "undefined" || typeof AudioContext === "undefined") { toast.error("This browser can't record audio. Try Chrome, Edge, Firefox or Safari."); return null; }
    try {
      const { recording } = await api.post<{ recording: { id: string; startedAt: string; startedBy: { id: string } }; joined: boolean }>(`/meetings/${meetingId}/recordings`, {});
      if (recording.startedBy.id !== me.data?.user?.id) { toast("Someone in the call is already recording."); return null; }
      const upload = async (c: Chunk) => {
        await api.put(`/meetings/${meetingId}/recordings/${recording.id}/chunks/${c.seq}`, { audioBase64: await blobToBase64(c.blob), mime: c.blob.type, offsetSec: c.offsetSec, durationSec: c.durationSec });
      };
      queue.current = new UploadQueue(upload);
      const r = new CallRecorder((c) => queue.current?.add(c));
      const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
      if (mic) r.addTrack(mic);
      for (const p of room.remoteParticipants.values()) for (const pub of p.audioTrackPublications.values()) if (pub.track) r.addTrack(pub.track.mediaStreamTrack);
      await r.start();
      recorder.current = r;
      setDownload(null);
      const started = { id: recording.id, startedAt: recording.startedAt };
      setMine(started);
      return started;
    } catch (e) {
      if (e instanceof ApiError && isSetupCode(e.code)) { if (!o.quiet) setSetupOpen(true); } else showError(e as Error);
      return null;
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      const started = await startAudio();
      if (started) announce({ on: true, by: myName, recordingId: started.id, startedAt: started.startedAt });
    } finally { setBusy(false); }
  };

  /** VID1: the dialog's Start. The transcript runs too when the AI key is set; the video starts either way. */
  const startWithVideo = async (writable: Writable | null, fileName: string, mime: string) => {
    const audio = setup?.ready ? await startAudio({ quiet: true }) : null;
    try {
      await video.start({ writable, fileName, mime, audio: audio ? recorder.current?.stream ?? null : null, transcript: !!audio });
    } catch (e) {
      // The video could not start: the transcript (if it started) keeps going and says so on the banner.
      if (audio) announce({ on: true, by: myName, recordingId: audio.id, startedAt: audio.startedAt });
      throw e;
    }
    setVideoOpen(false);
    announce({ on: true, by: myName, recordingId: audio?.id ?? null, startedAt: audio?.startedAt ?? new Date().toISOString(), video: true });
  };

  const stopAudio = async (cur: { id: string; startedAt: string }) => {
    if (!meetingId || !recorder.current) return;
    try {
      const whole = await recorder.current.stop();
      const durationSec = recorder.current.elapsedSec;
      recorder.current = null;
      await queue.current?.flush();
      if (whole) setDownload(URL.createObjectURL(whole));
      const r = await api.post<{ recording: Recording; posted: { type: string } | null }>(`/meetings/${meetingId}/recordings/${cur.id}/stop`, { durationSec });
      toast.success(r.recording.status === "done" && r.posted ? (r.posted.type === "chat" ? "Summary posted to the chat" : "Summary sent to the attendees") : "Recording stopped");
      if (queue.current?.failed) toast.error(`Part of the audio didn't transcribe: ${queue.current.failed.message}`);
    } catch (e) { showError(e as Error); } finally { setMine(null); }
  };

  const stop = async () => {
    if (!recordingMine) return;
    setBusy(true);
    stopping.current = true;
    try {
      // The video first (it records the mix the transcript recorder owns), then the transcript.
      if (video.active) await video.stop();
      const was = mySignal.current;
      void broadcast({ on: false, by: myName, recordingId: was?.recordingId ?? mine?.id ?? null, startedAt: null });
      mySignal.current = null;
      setSignal(null);
      if (mine) await stopAudio(mine);
    } finally { stopping.current = false; setBusy(false); }
  };

  // VID1: a video that stopped on its own (size limit, recorder error, leaving) ends the banner if nothing else records.
  useEffect(() => {
    if (videoActive || stopping.current || !mySignal.current?.video) return;
    if (mine) announce({ on: true, by: myName, recordingId: mine.id, startedAt: mine.startedAt });
    else { void broadcast({ on: false, by: myName, recordingId: mySignal.current.recordingId, startedAt: null }); mySignal.current = null; setSignal(null); }
  }, [videoActive, mine, myName, announce, broadcast]);

  const shown = video.active ? video.elapsed : elapsed;
  return (
    <div style={{ position: "relative", height: 0, zIndex: 20 }}>
      <div className="pointer-events-none absolute inset-x-0 top-2 flex flex-col items-center gap-2 px-3" data-testid="recording-layer">
        {signal && (
          <div role="status" className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-[#d70015] px-3 py-1.5 text-[12.5px] font-medium text-white shadow-lg" data-testid="recording-banner" data-video={signal.video ? "1" : undefined}>
            <IconCircle filled className="h-2.5 w-2.5 shrink-0 animate-pulse" />
            <span className="shrink-0">{signal.video ? "Recording video" : "Recording"}</span>
            <span className={cn("min-w-0 truncate font-normal", vid1 ? "text-white" : "text-white/85")}>started by {recordingMine ? "you" : signal.by}{recordingMine ? ` · ${Math.floor(shown / 60)}:${String(shown % 60).padStart(2, "0")}` : ""}</span>
          </div>
        )}
        {meetingId && (
          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
            {recordingMine
              ? <Button size="sm" variant="danger" loading={busy} onClick={() => void stop()} className={vid1 ? "bg-bad text-white shadow-lg hover:bg-bad/90" : undefined} data-testid="record-stop"><IconSquare filled className="h-3.5 w-3.5" />Stop recording</Button>
              : !signal && <Button size="sm" variant="secondary" loading={busy} onClick={() => (videoAllowed ? setVideoOpen(true) : void start())} data-testid="record-start">{videoAllowed ? <IconVideo className="h-3.5 w-3.5" /> : <IconMic className="h-3.5 w-3.5" />}Record</Button>}
            {download && !recordingMine && <a href={download} download="call-audio.webm" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/90 px-3 text-[13px] font-medium text-fg shadow"><IconDownload className="h-4 w-4" />Download audio</a>}
            {video.saved && !recordingMine && <a href={video.saved.url} download={video.saved.name} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/90 px-3 text-[13px] font-medium text-fg shadow" data-testid="video-save-again"><IconDownload className="h-4 w-4" />Save video</a>}
          </div>
        )}
        {recordingMine && <p className="max-w-full rounded-md bg-black/60 px-2 py-1 text-center text-[12px] text-white" data-testid="record-consent">{video.active ? VIDEO_CONSENT_SELF : CONSENT_TEXT}</p>}
      </div>
      <Dialog open={setupOpen} onClose={() => setSetupOpen(false)} title="Record and transcribe">
        <RecordSetupPrompt setup={setup} compact />
      </Dialog>
      {videoAllowed && meetingId && (
        <VideoRecordDialog open={videoOpen} onClose={() => setVideoOpen(false)} meetingId={meetingId} title={title} transcriptReady={!!setup?.ready}
          canAudioOnly={!!setup?.ready} onAudioOnly={() => { setVideoOpen(false); void start(); }} onStart={startWithVideo} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- on the meeting page

/** "Recording and transcript": every recording of the meeting with its summary and transcript. */
export function RecordingSection({ meetingId }: { meetingId: string }) {
  const { confirm, dialogs } = useDialogs();
  const qc = useQueryClient();
  const key = ["meeting-recordings", meetingId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<RecordingList>(`/meetings/${meetingId}/recordings`),
    // Only while something is still being written: a cheap read every 10 seconds.
    refetchInterval: (query) => (query.state.data?.recordings.some((r) => r.status === "processing" || (r.status === "recording" && !r.stale)) ? 10_000 : false),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const remove = async (r: Recording) => {
    if (!(await confirm({ title: `Delete the recording from ${new Date(r.startedAt).toLocaleString()}?`, description: "Its transcript and summary go with it.", confirmLabel: "Delete recording" }))) return;
    try { await api.del(`/meetings/${meetingId}/recordings/${r.id}`); refresh(); } catch (e) { showError(e as Error); }
  };
  const finish = async (r: Recording) => {
    try { await api.post(`/meetings/${meetingId}/recordings/${r.id}/stop`, {}); refresh(); } catch (e) { showError(e as Error); }
  };
  const data = q.data;
  return (
    <Card className="mt-4 p-5" data-testid="recording-section">
      {dialogs}
      <div className="flex items-center gap-2">
        <IconDocs className="h-4 w-4 text-muted" />
        <h2 className="text-[13px] font-semibold">Recording and transcript</h2>
      </div>
      {!data ? (q.error ? <LoadErrorInline onRetry={() => q.refetch()} className="mt-3" /> : <SkeletonRows rows={2} rowHeight={40} label="Loading recording" className="mt-2" />) : ( // POL1: a failed read says so
        <>
          {!data.recordings.length && (data.setup.ready
            ? <p className="mt-2 text-[13px] text-muted">No recordings yet. Press Record in the call to get a transcript; the summary is posted to the chat afterwards.</p>
            : <div className="mt-3"><RecordSetupPrompt setup={data.setup} /></div>)}
          <ul className="mt-3 space-y-3">
            {data.recordings.map((r) => (
              <li key={r.id} className="rounded-lg border border-line p-4" data-testid="recording-item">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <StatusBadge r={r} />
                  <span className="font-medium">{zonedDateTime(r.startedAt)}</span>
                  <span className="text-muted">· {duration(r.durationSec)} · recorded by {r.startedBy.name}</span>
                  <span className="ml-auto flex gap-1">
                    {r.status === "recording" && r.stale && <Button size="sm" variant="secondary" onClick={() => void finish(r)}>Finish and summarise</Button>}
                    <Button size="sm" variant="ghost" aria-label="Delete recording" onClick={() => void remove(r)} data-testid="recording-delete"><IconTrash className="h-4 w-4" /></Button>
                  </span>
                </div>
                {r.summary && <p className="mt-3 whitespace-pre-line text-[13.5px] leading-relaxed" data-testid="recording-summary">{r.summary}</p>}
                {r.actionItems.length > 0 && (
                  <div className="mt-3">
                    <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle"><IconChecklist className="h-3.5 w-3.5" />Action items</h3>
                    <ul className="mt-1.5 space-y-1 text-[13px]">
                      {r.actionItems.map((a, i) => <li key={i} className="flex gap-2"><span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" /><span>{a.text}{(a.assignee || a.due) && <span className="text-muted"> · {[a.assignee, a.due && `due ${a.due}`].filter(Boolean).join(", ")}</span>}</span></li>)}
                    </ul>
                  </div>
                )}
                {r.error && <p className="mt-2 text-[12.5px] text-muted">{r.error}</p>}
                {r.transcript && (
                  <details className="mt-3 text-[13px]" data-testid="recording-transcript">
                    <summary className="cursor-pointer select-none font-medium text-brand-hover">Transcript</summary>
                    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-fill p-3 font-sans text-[13px] leading-relaxed">{r.transcript}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function StatusBadge({ r }: { r: Recording }) {
  if (r.status === "recording") return r.stale ? <Badge tone="warn">Stopped without finishing</Badge> : <Badge tone="bad" dot>Recording</Badge>;
  if (r.status === "processing") return <Badge tone="brand" dot>Summarising</Badge>;
  if (r.status === "failed") return <Badge tone="warn">Transcript only</Badge>;
  return <Badge tone="ok">Done</Badge>;
}

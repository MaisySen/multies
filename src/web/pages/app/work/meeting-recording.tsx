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
import { useChat, useRoomContext } from "@livekit/components-react";
import { createPortal } from "react-dom";
import { RoomEvent, Track, type RemoteTrack } from "livekit-client";
import { IconChecklist, IconCircle, IconDocs, IconDownload, IconKey, IconMic, IconPause, IconPlay, IconSquare, IconTrash, IconVideo } from "@/web/components/ui/icon";
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
import { saveText, useVideoRecording, VideoRecordDialog, VIDEO_CONSENT_OTHERS, VIDEO_CONSENT_SELF } from "./video-record-vid1"; // VID1
import { canOffer1080, chatLog, QUALITIES, sideName, transcriptText, type LayoutMode, type QualityId } from "@/web/lib/video-rec-vid2"; // VID2
import { ChoiceGroup, PAUSED_NOTE, RecoverRecording } from "./video-vid2-ui"; // VID2
import { videoFileName, type Writable } from "@/web/lib/video-rec-vid1"; // VID1

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
/** VID2: when a recording signal is sent again (a reliable message can sit unsent until the next one goes). */
const RESEND_MS = [600, 1500, 3000, 6000];
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
  // VID2 (VIDEO_REC_VID2): pause and resume, speaker or gallery view, quality, crash safe pieces, chat and transcript files.
  const vid2 = vid1 && !!config.data?.videoRecVid2;
  const [layout, setLayoutState] = useState<LayoutMode>("speaker");
  const layoutRef = useRef<LayoutMode>("speaker");
  const setLayout = useCallback((l: LayoutMode) => { layoutRef.current = l; setLayoutState(l); }, []);
  const [quality, setQuality] = useState<QualityId>("hd720");
  const hd = typeof navigator !== "undefined" && canOffer1080(navigator.hardwareConcurrency, (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  const { chatMessages } = useChat();
  const chatRef = useRef(chatMessages);
  chatRef.current = chatMessages;
  const recStart = useRef(0);
  /** VID2: who sent the recording signal now shown (so it clears when they leave the call). */
  const signalFrom = useRef<string | null>(null);
  const transcriptWanted = useRef<string | null>(null);
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
    // VID2: each change (on, paused, resumed) is said again shortly after, so everyone's banner always matches.
    if (s && vid2) for (const ms of RESEND_MS) setTimeout(() => { if (mySignal.current === s) void broadcast(s); }, ms);
  }, [broadcast, vid2]);

  // The banner: data messages from whoever records.
  useEffect(() => {
    const onData = (payload: Uint8Array, from?: { identity?: string }, _k?: unknown, topic?: string) => {
      if (topic !== RECORDING_TOPIC) return;
      const s = decodeSignal(payload);
      if (!s) return;
      signalFrom.current = s.on ? from?.identity ?? null : null;
      setSignal(s.on ? s : null);
      if (s.on && s.video && !noticedVideo.current) {
        noticedVideo.current = true;
        noticed.current = true;
        toast(`${s.by} is saving a video of this call`, { description: VIDEO_CONSENT_OTHERS });
      } else if (s.on && !noticed.current) { noticed.current = true; toast(`${s.by} is recording this call`, { description: CONSENT_TEXT }); }
    };
    // VID2: whoever was recording left the call (their recording stops and saves on its own): the banner goes too.
    const onLeft = (p: { identity: string }) => { if (vid2 && signalFrom.current && p.identity === signalFrom.current) { signalFrom.current = null; setSignal(null); } };
    room.on(RoomEvent.DataReceived, onData).on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => { room.off(RoomEvent.DataReceived, onData).off(RoomEvent.ParticipantDisconnected, onLeft); };
  }, [room, vid2]);

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
    recStart.current = Date.now();
    transcriptWanted.current = vid2 && audio ? fileName : null;
    const startedWhen = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const vid2Args = vid2 ? {
      quality: QUALITIES[quality === "hd1080" && hd ? "hd1080" : "hd720"], layout: () => layoutRef.current, meetingId, title: title ?? "",
      // The call's chat while it recorded, saved next to the video with the same name.
      sideFiles: (name: string) => {
        const since = recStart.current;
        const lines = chatRef.current.filter((c) => c.timestamp >= since - 1000).map((c) => ({ at: c.timestamp, from: c.from?.name || c.from?.identity || "Someone", text: c.message }));
        return [{ name: sideName(name, "chat"), text: chatLog(title ?? "", since, lines, startedWhen) }];
      },
    } : undefined;
    try {
      await video.start({ writable, fileName, mime, audio: audio ? recorder.current?.stream ?? null : null, transcript: !!audio, vid2: vid2Args });
    } catch (e) {
      // The video could not start: the transcript (if it started) keeps going and says so on the banner.
      if (audio) announce({ on: true, by: myName, recordingId: audio.id, startedAt: audio.startedAt });
      throw e;
    }
    setVideoOpen(false);
    announce({ on: true, by: myName, recordingId: audio?.id ?? null, startedAt: audio?.startedAt ?? new Date().toISOString(), video: true });
  };

  /** VID2: the transcript saved next to the video once the server has it (it may take a minute after Stop). */
  const saveTranscript = async (id: string, first: Recording, fileName: string) => {
    const when = new Date(first.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    let r: Recording | undefined = first;
    for (let i = 0; i < 24 && r && !r.transcript && (r.status === "processing" || r.status === "recording"); i++) {
      await new Promise((res) => setTimeout(res, 5000));
      try { r = (await api.get<RecordingList>(`/meetings/${meetingId}/recordings`)).recordings.find((x) => x.id === id); } catch { /* try again */ }
    }
    if (r?.transcript) saveText(sideName(fileName, "transcript"), transcriptText(title ?? "", when, r.transcript));
    else toast("The transcript isn't ready yet", { description: "It shows under Recording and transcript on the meeting page when it is, with Save transcript." });
  };

  /** VID2: pause and resume; everyone's banner and tile dots follow. The transcript hears nothing while paused. */
  const pauseOrResume = () => {
    const cur = mySignal.current;
    if (!cur) return;
    if (video.paused) {
      if (!video.resume()) return;
      recorder.current?.setMuted(false);
      announce({ ...cur, paused: false });
    } else {
      if (!video.pause()) { toast.error("This browser can't pause a recording. Stop and start a new one instead."); return; }
      recorder.current?.setMuted(true);
      announce({ ...cur, paused: true });
    }
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
      if (transcriptWanted.current) void saveTranscript(cur.id, r.recording, transcriptWanted.current);
      transcriptWanted.current = null;
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
      const off: RecordingSignal = { on: false, by: myName, recordingId: was?.recordingId ?? mine?.id ?? null, startedAt: null };
      void broadcast(off);
      // VID2: "stopped" is said again a moment later, so a message lost on the way never leaves a banner up.
      if (vid2) for (const ms of RESEND_MS) setTimeout(() => { if (!mySignal.current) void broadcast(off); }, ms);
      mySignal.current = null;
      setSignal(null);
      if (mine) await stopAudio(mine);
    } finally { stopping.current = false; setBusy(false); }
  };

  // VID2 (MB-351): the call hangs up only when the page really goes (pagehide), never on beforeunload alone. A
  // beforeunload can fire and the page stay (Stay on a leave prompt, a check like a layout change test), and the
  // call then dropped. VID1 put the hang up back on beforeunload after each recording; VID2 keeps it off.
  useEffect(() => {
    if (!vid2) return;
    const hangUp = (room as unknown as { onPageLeave?: EventListener }).onPageLeave;
    if (typeof hangUp === "function") window.removeEventListener("beforeunload", hangUp);
  }, [vid2, room, videoActive, room.state]);

  // VID1: a video that stopped on its own (size limit, recorder error, leaving) ends the banner if nothing else records.
  useEffect(() => {
    if (videoActive || stopping.current || !mySignal.current?.video) return;
    if (mine) announce({ on: true, by: myName, recordingId: mine.id, startedAt: mine.startedAt });
    else { void broadcast({ on: false, by: myName, recordingId: mySignal.current.recordingId, startedAt: null }); mySignal.current = null; setSignal(null); }
  }, [videoActive, mine, myName, announce, broadcast]);

  const shown = video.active ? video.elapsed : elapsed;
  // VID2: a dot on every tile and a pill in the call's header for everyone while it records (grey while paused).
  const layerRef = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const recState = signal ? (signal.paused ? "paused" : "on") : null;
  useEffect(() => {
    if (!vid2) return;
    const screen = layerRef.current?.closest<HTMLElement>("[data-testid=call-screen]") ?? null;
    setSlot(screen?.querySelector<HTMLElement>("[data-rec-slot]") ?? null);
    if (!screen) return;
    if (recState) screen.dataset.rec = recState; else delete screen.dataset.rec;
    return () => { delete screen.dataset.rec; };
  }, [vid2, recState]);
  return (
    <div ref={layerRef} style={{ position: "relative", height: 0, zIndex: 20 }}>
      {vid2 && slot && recState && createPortal(
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold leading-none text-white", recState === "paused" ? "bg-[#3a3a3c]" : "bg-[#d70015]")} data-testid="rec-header-pill">
          {recState === "paused" ? <IconPause className="h-3 w-3" aria-hidden /> : <IconCircle filled className="h-2 w-2" aria-hidden />}
          {recState === "paused" ? "Paused" : "Rec"}<span className="sr-only">{recState === "paused" ? ", recording paused" : ", this call is being recorded"}</span>
        </span>, slot)}
      <div className="pointer-events-none absolute inset-x-0 top-2 flex flex-col items-center gap-2 px-3" data-testid="recording-layer">
        {signal && (
          <div role="status" className={cn("pointer-events-auto flex max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-[12.5px] font-medium text-white shadow-lg", signal.paused ? "bg-[#3a3a3c]" : "bg-[#d70015]")} data-testid="recording-banner" data-video={signal.video ? "1" : undefined} data-paused={signal.paused ? "1" : undefined}>
            {signal.paused ? <IconPause className="h-3 w-3 shrink-0" aria-hidden /> : <IconCircle filled className="h-2.5 w-2.5 shrink-0 animate-pulse" />}
            <span className="shrink-0">{signal.paused ? "Recording paused" : signal.video ? "Recording video" : "Recording"}</span>
            <span className={cn("min-w-0 truncate font-normal", vid1 ? "text-white" : "text-white/85")}>started by {recordingMine ? "you" : signal.by}{recordingMine ? ` · ${Math.floor(shown / 60)}:${String(shown % 60).padStart(2, "0")}` : ""}</span>
          </div>
        )}
        {meetingId && (
          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
            {vid2 && video.active && (
              <Button size="sm" variant="secondary" onClick={pauseOrResume} className="shadow-lg" data-testid={video.paused ? "record-resume" : "record-pause"}>
                {video.paused ? <IconPlay className="h-3.5 w-3.5" aria-hidden /> : <IconPause className="h-3.5 w-3.5" aria-hidden />}{video.paused ? "Resume" : "Pause"}
              </Button>
            )}
            {recordingMine
              ? <Button size="sm" variant="danger" loading={busy} onClick={() => void stop()} className={vid1 ? "bg-[#d70015]! text-white! shadow-lg hover:bg-[#b80012]!" : undefined} data-testid="record-stop"><IconSquare filled className="h-3.5 w-3.5" />Stop recording</Button>
              : !signal && <Button size="sm" variant="secondary" loading={busy} onClick={() => (videoAllowed ? setVideoOpen(true) : void start())} data-testid="record-start">{videoAllowed ? <IconVideo className="h-3.5 w-3.5" /> : <IconMic className="h-3.5 w-3.5" />}Record</Button>}
            {download && !recordingMine && <a href={download} download="call-audio.webm" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/90 px-3 text-[13px] font-medium text-fg shadow"><IconDownload className="h-4 w-4" />Download audio</a>}
            {video.saved && !recordingMine && <a href={video.saved.url} download={video.saved.name} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/90 px-3 text-[13px] font-medium text-fg shadow" data-testid="video-save-again"><IconDownload className="h-4 w-4" />Save video</a>}
          </div>
        )}
        {vid2 && video.active && (
          <div className="pointer-events-auto max-w-full">
            <ChoiceGroup label="Recording layout" compact onDark value={layout} onChange={setLayout} testid="rec-layout"
              options={[{ value: "speaker", label: "Speaker" }, { value: "gallery", label: "Gallery" }]} />
          </div>
        )}
        {recordingMine && <p className="max-w-full rounded-md bg-black/60 px-2 py-1 text-center text-[12px] text-white" data-testid="record-consent">{video.paused ? PAUSED_NOTE : video.active ? VIDEO_CONSENT_SELF : CONSENT_TEXT}</p>}
        {vid2 && videoAllowed && !recordingMine && <div className="pointer-events-auto w-full max-w-xl"><RecoverRecording meetingId={meetingId} onDark /></div>}
      </div>
      <Dialog open={setupOpen} onClose={() => setSetupOpen(false)} title="Record and transcribe">
        <RecordSetupPrompt setup={setup} compact />
      </Dialog>
      {videoAllowed && meetingId && (
        <VideoRecordDialog open={videoOpen} onClose={() => setVideoOpen(false)} meetingId={meetingId} title={title} transcriptReady={!!setup?.ready}
          canAudioOnly={!!setup?.ready} onAudioOnly={() => { setVideoOpen(false); void start(); }} onStart={startWithVideo}
          vid2={vid2 ? { layout, setLayout, quality, setQuality, hd } : undefined} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- on the meeting page

/** "Recording and transcript": every recording of the meeting with its summary and transcript. */
export function RecordingSection({ meetingId, title }: { meetingId: string; title?: string }) {
  const vid2Save = !!useConfig().data?.videoRecVid2; // VID2: Save transcript next to the video
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
                    {vid2Save && <Button size="sm" variant="secondary" className="mt-2" data-testid="recording-transcript-save"
                      onClick={() => saveText(sideName(videoFileName(title ?? "", new Date(r.startedAt), "webm"), "transcript"), transcriptText(title ?? "", new Date(r.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), r.transcript))}>
                      <IconDownload className="h-4 w-4" aria-hidden />Save transcript</Button>}
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

/**
 * VID1: one video recording of a LiveKit call in the admin's browser: the compositor's canvas track plus the
 * mixed sound, recorded by MediaRecorder into the file the person chose or into memory. Dynamic import only.
 * Nothing here talks to the server: the video only goes to the person's own device.
 */
import { Track, type Participant, type Room } from "livekit-client";
import { AudioMixer } from "./call-recorder";
import { CallCompositor, type CompositorOptions, type SourceTile } from "./video-compositor-vid1";
import { FileSink, MemorySink, VideoRecording, type RecorderCtor, type Saved, type Sink, type VideoEvent, type Writable } from "./video-rec-vid1";

/** Every camera and screen share in the room, local person first, in join order. */
export function roomTiles(room: Room): SourceTile[] {
  const people: Participant[] = [room.localParticipant, ...[...room.remoteParticipants.values()].sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0))];
  const out: SourceTile[] = [];
  for (const p of people) {
    const name = (p.name || p.identity || "Guest").slice(0, 80);
    const cam = p.getTrackPublication(Track.Source.Camera);
    const camTrack = cam?.track && !cam.isMuted ? cam.track.mediaStreamTrack : null;
    out.push({ id: `${p.identity}:camera`, kind: "camera", name, speaking: p.isSpeaking, hasVideo: !!camTrack && camTrack.readyState === "live", track: camTrack });
    const scr = p.getTrackPublication(Track.Source.ScreenShare);
    const scrTrack = scr?.track && !scr.isMuted ? scr.track.mediaStreamTrack : null;
    if (scrTrack && scrTrack.readyState === "live") out.push({ id: `${p.identity}:screen`, kind: "screen", name, speaking: false, hasVideo: true, track: scrTrack });
  }
  return out;
}

/** Every audio track in the room (the person's own microphone and everyone else's). */
export function roomAudio(room: Room): MediaStreamTrack[] {
  const out: MediaStreamTrack[] = [];
  const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
  if (mic) out.push(mic);
  for (const p of room.remoteParticipants.values()) for (const pub of p.audioTrackPublications.values()) if (pub.track) out.push(pub.track.mediaStreamTrack);
  return out;
}

export interface VideoSession {
  recording: VideoRecording;
  /** The stand alone mix when no transcript recorder runs (tracks are added to it as people join). */
  mixer: AudioMixer | null;
  stop(): Promise<Saved>;
  /**
   * VID3: a phone's memory is small, so a long call is saved in parts: the current recording is finished (its file
   * answered) and a new one starts at once on the same picture and sound. recording points at the new one after.
   */
  rollover(next: { keep?: { put(b: Blob): Promise<void> } }): Promise<Saved>;
  /** VID2: the frame rate the drawing runs at now (it steps down on a slow device). */
  frameRate(): number;
}

export async function startVideoSession(o: {
  room: Room;
  /** The transcript recorder's mix, when a transcript runs too. */
  audio: MediaStream | null;
  mime: string;
  /** The file the person chose (written as the call goes); memory when absent. */
  writable: Writable | null;
  onEvent: (e: VideoEvent) => void;
  /** VID2: frame size, frame rate, layout and step down; video bits per second; pieces kept on the device. */
  draw?: CompositorOptions;
  videoBits?: number;
  keep?: { put(b: Blob): Promise<void> };
  /** VID3: a phone's memory limits (warning, then the part is saved); VID1's 1.5 GB and 2 GB when absent. */
  limits?: { warn: number; hard: number };
}): Promise<VideoSession> {
  const Recorder = (globalThis as { MediaRecorder?: RecorderCtor }).MediaRecorder;
  if (!Recorder) throw new Error("This browser can't record video.");
  let mixer: AudioMixer | null = null;
  let compositor: CallCompositor | null = null;
  try {
    if (!o.audio) {
      mixer = new AudioMixer();
      for (const t of roomAudio(o.room)) mixer.addTrack(t);
      await mixer.resume();
    }
    compositor = new CallCompositor(() => roomTiles(o.room), o.draw);
    const video = compositor.start();
    const sound = (o.audio ?? mixer!.stream).getAudioTracks();
    const stream = new MediaStream([video, ...sound]);
    const sink: Sink = o.writable ? new FileSink(o.writable) : new MemorySink(o.mime.split(";")[0] || "video/webm");
    const make = (s: Sink, keep?: { put(b: Blob): Promise<void> }) => new VideoRecording({ stream, mime: o.mime, sink: s, Recorder, onEvent: o.onEvent, videoBits: o.videoBits, keep, warnBytes: o.limits?.warn, hardBytes: o.limits?.hard });
    const comp = compositor;
    comp.onFail = (message) => o.onEvent({ type: "error", message: `drawing the video failed (${message})` });
    const first = make(sink, o.keep);
    first.start();
    let done: Promise<Saved> | null = null;
    const session: VideoSession = {
      recording: first,
      mixer,
      frameRate: () => comp.frameRate,
      async rollover(next) {
        if (done) return done;
        const old = session.recording;
        const saved = await old.stop();
        if (done) return saved;
        const fresh = make(new MemorySink(o.mime.split(";")[0] || "video/webm"), next.keep);
        fresh.start();
        session.recording = fresh;
        return saved;
      },
      stop() {
        if (done) return done;
        done = session.recording.stop().finally(async () => {
          comp.dispose();
          video.stop();
          await mixer?.close();
        });
        return done;
      },
    };
    return session;
  } catch (e) {
    compositor?.dispose();
    await mixer?.close();
    throw e;
  }
}

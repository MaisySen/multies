/**
 * Round 23 (R23.2): records a call in the browser. The local mic and every remote audio track are mixed
 * into one AudioContext destination and recorded with MediaRecorder (opus, about 32 kbps). Every
 * SEGMENT_MS the segment recorder is stopped and started again, so each uploaded chunk is a whole file
 * the transcription API can read on its own; a second recorder keeps the whole call in this tab for
 * "Download audio" at Stop. Nothing here talks to LiveKit or the server directly: the caller adds
 * tracks and passes the uploader, which keeps the queue logic testable without media.
 */
export const SEGMENT_MS = 5 * 60_000;
export const AUDIO_BITS = 32_000;
/** The data message topic everyone in the room listens on for the Recording banner. */
export const RECORDING_TOPIC = "multies.recording";

export interface RecordingSignal { on: boolean; by: string; recordingId: string | null; startedAt: string | null }

export function encodeSignal(s: RecordingSignal): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({ v: 1, ...s })));
}
export function decodeSignal(bytes: Uint8Array): RecordingSignal | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(bytes)) as Partial<RecordingSignal> & { v?: number };
    if (o.v !== 1 || typeof o.on !== "boolean") return null;
    return { on: o.on, by: typeof o.by === "string" ? o.by.slice(0, 80) : "Someone", recordingId: typeof o.recordingId === "string" ? o.recordingId : null, startedAt: typeof o.startedAt === "string" ? o.startedAt : null };
  } catch {
    return null;
  }
}

export interface Chunk { seq: number; blob: Blob; offsetSec: number; durationSec: number }
export type Uploader = (c: Chunk) => Promise<void>;

/**
 * Uploads chunks one at a time, in sequence order, retrying a failed one (with a pause) before moving
 * on, so the server always receives seq 0, 1, 2 ... Chunks added while one is uploading wait their turn.
 */
export class UploadQueue {
  private queue: Chunk[] = [];
  private running: Promise<void> | null = null;
  failed: Error | null = null;
  constructor(private upload: Uploader, private opts: { tries?: number; pauseMs?: number } = {}) {}

  add(c: Chunk) {
    this.queue.push(c);
    this.queue.sort((a, b) => a.seq - b.seq);
    if (!this.running) this.running = this.drain().finally(() => { this.running = null; });
  }

  get pending() { return this.queue.length; }

  private async drain() {
    while (this.queue.length) {
      const c = this.queue[0];
      const tries = this.opts.tries ?? 3;
      for (let i = 0; i < tries; i++) {
        try {
          await this.upload(c);
          this.failed = null;
          break;
        } catch (err) {
          this.failed = err instanceof Error ? err : new Error(String(err));
          // A refusal the server will repeat (no key, stopped, too large) is not retried.
          const status = (err as { status?: number }).status ?? 0;
          if ((status >= 400 && status < 500 && status !== 429) || i === tries - 1) break;
          await new Promise((r) => setTimeout(r, (this.opts.pauseMs ?? 3000) * (i + 1)));
        }
      }
      this.queue.shift();
    }
  }

  /** Resolves once every chunk added so far has been tried. */
  async flush() { while (this.running) await this.running; }
}

export const recorderMime = () => {
  const MR = (globalThis as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder;
  for (const t of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"]) if (MR?.isTypeSupported?.(t)) return t;
  return "";
};

/** Mixes tracks into one stream and records it in self contained segments. Browser only. */
export class CallRecorder {
  private ctx: AudioContext;
  private dest: MediaStreamAudioDestinationNode;
  private sources = new Map<string, MediaStreamAudioSourceNode>();
  private segment: MediaRecorder | null = null;
  private whole: MediaRecorder | null = null;
  private wholeParts: Blob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private segmentStart = 0;
  private startedAt = 0;
  private stopping = false;
  readonly mime = recorderMime();

  constructor(private onChunk: (c: Chunk) => void) {
    this.ctx = new AudioContext();
    this.dest = this.ctx.createMediaStreamDestination();
  }

  /** Adds (or keeps) a track in the mix. Safe to call twice with the same track. */
  addTrack(track: MediaStreamTrack) {
    if (track.kind !== "audio" || this.sources.has(track.id)) return;
    const node = this.ctx.createMediaStreamSource(new MediaStream([track]));
    node.connect(this.dest);
    this.sources.set(track.id, node);
  }

  removeTrack(track: MediaStreamTrack) {
    this.sources.get(track.id)?.disconnect();
    this.sources.delete(track.id);
  }

  private startSegment() {
    const r = new MediaRecorder(this.dest.stream, { mimeType: this.mime || undefined, audioBitsPerSecond: AUDIO_BITS });
    const parts: Blob[] = [];
    const seq = this.seq++;
    const startMs = Date.now();
    this.segmentStart = startMs;
    r.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    r.onstop = () => {
      const blob = new Blob(parts, { type: r.mimeType || this.mime || "audio/webm" });
      if (blob.size) this.onChunk({ seq, blob, offsetSec: Math.round((startMs - this.startedAt) / 1000), durationSec: Math.round((Date.now() - this.startedAt) / 1000) });
    };
    r.start();
    this.segment = r;
  }

  async start() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.startedAt = Date.now();
    this.startSegment();
    this.whole = new MediaRecorder(this.dest.stream, { mimeType: this.mime || undefined, audioBitsPerSecond: AUDIO_BITS });
    this.whole.ondataavailable = (e) => { if (e.data.size) this.wholeParts.push(e.data); };
    this.whole.start(60_000);
    this.timer = setInterval(() => {
      if (this.stopping) return;
      const old = this.segment;
      this.startSegment();
      old?.stop();
    }, SEGMENT_MS);
  }

  get elapsedSec() { return this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0; }
  get segmentAgeSec() { return this.segmentStart ? Math.round((Date.now() - this.segmentStart) / 1000) : 0; }

  /** Stops both recorders; resolves with the whole call's audio for Download audio. */
  async stop(): Promise<Blob | null> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    const done = (r: MediaRecorder | null) => new Promise<void>((res) => {
      if (!r || r.state === "inactive") return res();
      r.addEventListener("stop", () => setTimeout(res, 0), { once: true });
      r.stop();
    });
    await Promise.all([done(this.segment), done(this.whole)]);
    for (const n of this.sources.values()) n.disconnect();
    this.sources.clear();
    await this.ctx.close().catch(() => undefined);
    return this.wholeParts.length ? new Blob(this.wholeParts, { type: this.whole?.mimeType || this.mime || "audio/webm" }) : null;
  }
}

export const blobToBase64 = (b: Blob) => new Promise<string>((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
  fr.onerror = () => rej(fr.error ?? new Error("Could not read the audio."));
  fr.readAsDataURL(b);
});

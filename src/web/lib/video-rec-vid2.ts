/**
 * VID2: the pure parts of the meeting recording upgrade (pause and resume, speaker or gallery view, quality with
 * an automatic step down, crash safe pieces kept on this device, chat and transcript side files). No DOM here, so
 * it runs in unit tests. Like VID1, nothing in VID2 uploads anything: the video only ever goes to the person's device.
 */
import { CANVAS_H, CANVAS_W, GAP, layoutTiles, type Placement, type Rect, type TileInput } from "./video-rec-vid1";

// ---------------------------------------------------------------- layouts

export type LayoutMode = "gallery" | "speaker";
/** Most people in the strip under the speaker (the last cell turns into "+N more" past it). */
export const MAX_STRIP = 6;
/** Share of the height the speaker gets in speaker view; the strip has the rest. */
export const SPEAKER_SHARE = 0.76;
/** The speaker must talk this long before the big tile switches to them, so it does not flicker on a cough. */
export const SPEAKER_HOLD_MS = 1500;

const put = (t: TileInput, r: Rect): Placement => ({ id: t.id, kind: t.kind, name: t.name, speaking: t.speaking, hasVideo: t.hasVideo, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } });

/** A centred row of n 16:9 cells in the box. */
function row(n: number, box: Rect, gap: number): Rect[] {
  if (n <= 0) return [];
  const h0 = box.h - 2 * gap;
  const wMax = (box.w - gap * (n + 1)) / n;
  const w = Math.max(1, Math.min((h0 * 16) / 9, wMax));
  const h = Math.min(h0, (w * 9) / 16);
  const total = n * w + (n - 1) * gap;
  const left = box.x + (box.w - total) / 2;
  return Array.from({ length: n }, (_, i) => ({ x: left + i * (w + gap), y: box.y + (box.h - h) / 2, w, h }));
}

/**
 * Speaker view: the person talking fills most of the frame and everyone else sits in a strip below, in join order.
 * A screen share always takes the big area (exactly as gallery view does), so a shared screen is never small.
 */
export function layoutSpeaker(tiles: TileInput[], speakerId: string | null, W = CANVAS_W, H = CANVAS_H, gap = GAP): Placement[] {
  if (!tiles.length) return [];
  if (tiles.some((t) => t.kind === "screen")) return layoutTiles(tiles, W, H, gap);
  const main = tiles.find((t) => t.id === speakerId) ?? tiles[0];
  const others = tiles.filter((t) => t !== main);
  if (!others.length) return [put(main, { x: gap, y: gap, w: W - 2 * gap, h: H - 2 * gap })];
  const mainH = Math.round(H * SPEAKER_SHARE) - gap;
  const mainW = Math.min(W - 2 * gap, (mainH * 16) / 9);
  const out = [put(main, { x: (W - mainW) / 2, y: gap, w: mainW, h: mainH })];
  const strip: Rect = { x: 0, y: gap + mainH, w: W, h: H - gap - mainH };
  const over = others.length > MAX_STRIP;
  const shown = over ? others.slice(0, MAX_STRIP - 1) : others;
  const rects = row(shown.length + (over ? 1 : 0), strip, gap);
  shown.forEach((t, i) => out.push(put(t, rects[i])));
  if (over) {
    const r = rects[rects.length - 1];
    const n = others.length - shown.length;
    out.push({ id: null, kind: "more", name: `+${n} more`, speaking: false, hasVideo: false, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, more: n });
  }
  return out;
}

export function layoutFor(mode: LayoutMode, tiles: TileInput[], speakerId: string | null, W = CANVAS_W, H = CANVAS_H): Placement[] {
  return mode === "speaker" ? layoutSpeaker(tiles, speakerId, W, H) : layoutTiles(tiles, W, H);
}

export interface SpeakerPick { id: string | null; since: number; candidate: string | null; candidateSince: number }
export const noSpeaker = (): SpeakerPick => ({ id: null, since: 0, candidate: null, candidateSince: 0 });

/**
 * Who has the big tile: the person speaking, once they have spoken for SPEAKER_HOLD_MS; the last speaker keeps it
 * through silence. With nobody picked yet, the first camera with video (else the first tile) gets it.
 */
export function pickSpeaker(tiles: TileInput[], prev: SpeakerPick, now: number, hold = SPEAKER_HOLD_MS): SpeakerPick {
  const cams = tiles.filter((t) => t.kind === "camera");
  const stillHere = prev.id && cams.some((t) => t.id === prev.id) ? prev.id : null;
  const talking = cams.find((t) => t.speaking && t.id !== stillHere) ?? null;
  const fallback = stillHere ?? (cams.find((t) => t.hasVideo) ?? cams[0])?.id ?? null;
  if (!talking) return { id: fallback, since: stillHere ? prev.since : now, candidate: null, candidateSince: 0 };
  const candidateSince = prev.candidate === talking.id ? prev.candidateSince : now;
  if (!stillHere || now - candidateSince >= hold) return { id: talking.id, since: now, candidate: null, candidateSince: 0 };
  return { id: stillHere, since: prev.since, candidate: talking.id, candidateSince };
}

// ---------------------------------------------------------------- quality

export type QualityId = "hd720" | "hd1080";
export interface Quality { id: QualityId; label: string; w: number; h: number; fps: number; videoBits: number }
export const QUALITIES: Record<QualityId, Quality> = {
  hd720: { id: "hd720", label: "720p", w: 1280, h: 720, fps: 30, videoBits: 4_000_000 },
  hd1080: { id: "hd1080", label: "1080p", w: 1920, h: 1080, fps: 30, videoBits: 8_000_000 },
};
export const AUDIO_BITS_VID2 = 128_000;
/** Frame rates the drawing steps down through when the device can't keep up (never below the last). */
export const FPS_STEPS = [30, 24, 20, 15];

/** 1080p is offered on devices with at least 4 cores (and 4 GB when the browser says); 720p everywhere. */
export function canOffer1080(cores: number | undefined, memoryGb: number | undefined) {
  return (cores ?? 0) >= 4 && (memoryGb === undefined || memoryGb >= 4);
}

/**
 * Watches the drawing: each tick reports when it ran and how long the draw took. Over a window, if more than a fifth
 * of the frames came late or a draw took most of a frame, the next lower frame rate is answered (else null).
 */
export class FrameMeter {
  private ticks: { at: number; cost: number }[] = [];
  private since = 0;
  dropped = 0;
  frames = 0;
  constructor(public fps: number, private windowMs = 5000) {}
  tick(at: number, cost: number): number | null {
    if (!this.since) this.since = at;
    const interval = 1000 / this.fps;
    const last = this.ticks[this.ticks.length - 1];
    this.frames++;
    if (last) { const late = Math.floor((at - last.at) / interval) - 1; if (late > 0) this.dropped += late; }
    this.ticks.push({ at, cost });
    if (at - this.since < this.windowMs) return null;
    const n = this.ticks.length;
    const expected = Math.max(1, Math.round((at - this.since) / interval));
    const lateShare = 1 - Math.min(1, n / expected);
    const avgCost = this.ticks.reduce((s, t) => s + t.cost, 0) / n;
    this.ticks = [];
    this.since = at;
    if (lateShare <= 0.2 && avgCost <= interval * 0.7) return null;
    const i = FPS_STEPS.indexOf(this.fps);
    const next = i >= 0 && i < FPS_STEPS.length - 1 ? FPS_STEPS[i + 1] : FPS_STEPS.find((f) => f < this.fps) ?? null;
    if (next === null) return null;
    this.fps = next;
    return next;
  }
}

// ---------------------------------------------------------------- pause and resume

/** Recorded time without the paused stretches. */
export class PauseClock {
  private startedAt: number | null = null;
  private pausedAt: number | null = null;
  private pausedMs = 0;
  start(now: number) { this.startedAt = now; this.pausedAt = null; this.pausedMs = 0; }
  get paused() { return this.pausedAt !== null; }
  pause(now: number) { if (this.startedAt !== null && this.pausedAt === null) this.pausedAt = now; }
  resume(now: number) { if (this.pausedAt !== null) { this.pausedMs += now - this.pausedAt; this.pausedAt = null; } }
  elapsedMs(now: number) { if (this.startedAt === null) return 0; return Math.max(0, (this.pausedAt ?? now) - this.startedAt - this.pausedMs); }
}

// ---------------------------------------------------------------- pieces kept on this device (crash safe)

export interface StoredMeta {
  id: string;
  meetingId: string | null;
  title: string;
  fileName: string;
  mime: string;
  startedAt: number;
  /** Last piece written (a heartbeat): a recording still running in another tab is never offered for recovery. */
  updatedAt: number;
  pieces: number;
  bytes: number;
  done: boolean;
}

/** Where pieces are kept: IndexedDB in the browser, a map in unit tests. */
export interface PieceBackend {
  putMeta(m: StoredMeta): Promise<void>;
  metas(): Promise<StoredMeta[]>;
  putPiece(id: string, seq: number, b: Blob): Promise<void>;
  pieces(id: string): Promise<{ seq: number; blob: Blob }[]>;
  remove(id: string): Promise<void>;
}

/** Older than this with no new piece: the tab that recorded it is gone. */
export const STALE_MS = 20_000;
/** Pieces of a recording nobody recovered are removed after a week. */
export const KEEP_MS = 7 * 24 * 3600_000;

export const recoverable = (metas: StoredMeta[], now: number, stale = STALE_MS) =>
  metas.filter((m) => !m.done && m.pieces > 0 && m.bytes > 0 && now - m.updatedAt >= stale && now - m.updatedAt < KEEP_MS).sort((a, b) => b.startedAt - a.startedAt);

/** Writes each piece of one recording as it comes; finish() removes them once the video is safely saved. */
export class PieceStore {
  private chain: Promise<void> = Promise.resolve();
  private meta: StoredMeta;
  failed = false;
  constructor(private db: PieceBackend, meta: Omit<StoredMeta, "updatedAt" | "pieces" | "bytes" | "done">, private now: () => number = Date.now) {
    this.meta = { ...meta, updatedAt: now(), pieces: 0, bytes: 0, done: false };
  }
  get id() { return this.meta.id; }
  get bytes() { return this.meta.bytes; }
  begin() { this.chain = this.chain.then(() => this.db.putMeta({ ...this.meta })).catch(() => { this.failed = true; }); return this.chain; }
  put(b: Blob) {
    const seq = this.meta.pieces++;
    this.chain = this.chain.then(async () => {
      if (this.failed) return;
      await this.db.putPiece(this.meta.id, seq, b);
      this.meta.bytes += b.size;
      this.meta.updatedAt = this.now();
      await this.db.putMeta({ ...this.meta });
    }).catch(() => { this.failed = true; });
    return this.chain;
  }
  async finish() { await this.chain; await this.db.remove(this.meta.id).catch(() => undefined); }
  async flushed() { await this.chain; }
}

/** Rebuilds a recording from its pieces, in order. */
export async function rebuild(db: PieceBackend, m: StoredMeta): Promise<Blob | null> {
  const parts = (await db.pieces(m.id)).sort((a, b) => a.seq - b.seq).map((p) => p.blob);
  return parts.length ? new Blob(parts, { type: m.mime.split(";")[0] || "video/webm" }) : null;
}

/** Old leftovers nobody recovered, and finished entries, are cleared. */
export async function sweep(db: PieceBackend, now: number) {
  for (const m of await db.metas()) if (m.done || now - m.updatedAt >= KEEP_MS) await db.remove(m.id).catch(() => undefined);
}

export class MemoryBackend implements PieceBackend {
  m = new Map<string, StoredMeta>();
  p = new Map<string, Map<number, Blob>>();
  async putMeta(x: StoredMeta) { this.m.set(x.id, { ...x }); }
  async metas() { return [...this.m.values()].map((x) => ({ ...x })); }
  async putPiece(id: string, seq: number, b: Blob) { if (!this.p.has(id)) this.p.set(id, new Map()); this.p.get(id)!.set(seq, b); }
  async pieces(id: string) { return [...(this.p.get(id) ?? new Map<number, Blob>()).entries()].map(([seq, blob]) => ({ seq, blob })); }
  async remove(id: string) { this.m.delete(id); this.p.delete(id); }
}

// ---------------------------------------------------------------- side files

/** "Meeting Weekly sync 3 Nov 2026 14.05.webm" -> "Meeting Weekly sync 3 Nov 2026 14.05 chat.txt". */
export function sideName(videoName: string, what: "chat" | "transcript", ext = "txt") {
  const base = videoName.replace(/\.(webm|mp4|mkv)$/i, "").trim() || "Meeting";
  return `${base} ${what}.${ext}`;
}

export interface ChatLine { at: number; from: string; text: string }
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const oneLine = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\n/g, "\n    ").trim();

/** The call's chat while it recorded, one line each: time into the recording, who, what. Plain text, UTF 8. */
export function chatLog(title: string, startedAt: number, lines: ChatLine[], when: string) {
  const head = [`Chat from ${title || "the meeting"}`, `Recording started ${when}`, ""];
  const body = lines.length
    ? [...lines].sort((a, b) => a.at - b.at).map((l) => `[${clock(l.at - startedAt)}] ${l.from.slice(0, 80) || "Someone"}: ${oneLine(l.text)}`)
    : ["No chat messages while this was recorded."];
  return [...head, ...body, ""].join("\n");
}

/** The transcript as text, with the meeting name on top. */
export function transcriptText(title: string, when: string, transcript: string) {
  return [`Transcript of ${title || "the meeting"}`, `Recording started ${when}`, "", transcript.trim(), ""].join("\n");
}

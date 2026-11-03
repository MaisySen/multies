/**
 * VID1: the pure parts of recording a whole call as video in the admin's own browser: the tile layout, the
 * recording type, the file name and the recording state machine with its two sinks (a file the person chose,
 * written as the call goes, or memory saved at Stop). No DOM here except what is passed in, so it runs in unit
 * tests. Nothing in VID1 uploads anything: the video only ever goes to the person's own device.
 */
export const CANVAS_W = 1280;
export const CANVAS_H = 720;
export const FPS = 30;
export const VIDEO_BITS = 2_500_000;
export const VIDEO_AUDIO_BITS = 128_000;
/** One second chunks: the file sink writes as the call goes; the memory sink can count bytes as it grows. */
export const TIMESLICE_MS = 1000;
/** Memory path only: a warning with Stop and save at 1.5 GB, and a stop and save on its own at 2 GB. */
export const WARN_BYTES = 1.5 * 1024 ** 3;
export const HARD_BYTES = 2 * 1024 ** 3;
export const GAP = 8;
/** At most 16 tiles in the grid (the 16th becomes "+N more"), at most 5 beside a screen share. */
export const MAX_GRID = 16;
export const MAX_SIDE = 5;
export const SCREEN_SHARE = 0.78;

export type TileKind = "camera" | "screen";
export interface TileInput { id: string; kind: TileKind; name: string; speaking: boolean; hasVideo: boolean }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Placement { id: string | null; kind: TileKind | "more"; name: string; speaking: boolean; hasVideo: boolean; rect: Rect; more?: number }

const place = (t: TileInput, rect: Rect): Placement => ({ id: t.id, kind: t.kind, name: t.name, speaking: t.speaking, hasVideo: t.hasVideo, rect });
const moreTile = (n: number, rect: Rect): Placement => ({ id: null, kind: "more", name: `+${n} more`, speaking: false, hasVideo: false, rect, more: n });
const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

/** Fits 16:9 cells into a box: the cell size for a cols x rows grid with gaps. */
function cellFor(boxW: number, boxH: number, cols: number, rows: number, gap: number) {
  const availW = (boxW - gap * (cols + 1)) / cols;
  const availH = (boxH - gap * (rows + 1)) / rows;
  const w = Math.max(1, Math.min(availW, (availH * 16) / 9));
  return { w, h: (w * 9) / 16 };
}

/** A centred grid of n cells in the box (the last row centred too). */
function grid(n: number, box: Rect, gap: number): Rect[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: box.x + gap, y: box.y + gap, w: box.w - 2 * gap, h: box.h - 2 * gap }];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cell = cellFor(box.w, box.h, cols, rows, gap);
  const totalH = rows * cell.h + (rows - 1) * gap;
  const top = box.y + (box.h - totalH) / 2;
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, n - r * cols);
    const rowW = inRow * cell.w + (inRow - 1) * gap;
    const left = box.x + (box.w - rowW) / 2;
    for (let c = 0; c < inRow; c++) out.push({ x: left + c * (cell.w + gap), y: top + r * (cell.h + gap), w: cell.w, h: cell.h });
  }
  return out;
}

/** A centred column of n cells in the box. */
function column(n: number, box: Rect, gap: number): Rect[] {
  if (n <= 0) return [];
  const w0 = box.w - 2 * gap;
  const hMax = (box.h - gap * (n + 1)) / n;
  const h = Math.max(1, Math.min((w0 * 9) / 16, hMax));
  const w = Math.min(w0, (h * 16) / 9);
  const totalH = n * h + (n - 1) * gap;
  const top = box.y + (box.h - totalH) / 2;
  return Array.from({ length: n }, (_, i) => ({ x: box.x + (box.w - w) / 2, y: top + i * (h + gap), w, h }));
}

/**
 * Where each tile goes on the recording. No screen share: a grid of everyone. A screen share: the newest share
 * fills most of the frame and everyone else goes in a column beside it. Order is kept as given (join order), so
 * tiles do not jump around when someone speaks; the speaker gets a ring instead.
 */
export function layoutTiles(tiles: TileInput[], W = CANVAS_W, H = CANVAS_H, gap = GAP): Placement[] {
  const screens = tiles.filter((t) => t.kind === "screen");
  if (!screens.length) {
    const shown = tiles.length > MAX_GRID ? tiles.slice(0, MAX_GRID - 1) : tiles;
    const rects = grid(shown.length + (tiles.length > MAX_GRID ? 1 : 0), { x: 0, y: 0, w: W, h: H }, gap);
    const out = shown.map((t, i) => place(t, round(rects[i])));
    if (tiles.length > MAX_GRID) out.push(moreTile(tiles.length - shown.length, round(rects[rects.length - 1])));
    return out;
  }
  const main = screens[screens.length - 1];
  const others = tiles.filter((t) => t !== main);
  if (!others.length) return [place(main, round({ x: gap, y: gap, w: W - 2 * gap, h: H - 2 * gap }))];
  const mainW = Math.round(W * SCREEN_SHARE) - gap;
  const out: Placement[] = [place(main, round({ x: gap, y: gap, w: mainW, h: H - 2 * gap }))];
  const side: Rect = { x: gap + mainW, y: 0, w: W - gap - mainW, h: H };
  const shown = others.length > MAX_SIDE ? others.slice(0, MAX_SIDE - 1) : others;
  const rects = column(shown.length + (others.length > MAX_SIDE ? 1 : 0), side, gap);
  shown.forEach((t, i) => out.push(place(t, round(rects[i]))));
  if (others.length > MAX_SIDE) out.push(moreTile(others.length - shown.length, round(rects[rects.length - 1])));
  return out;
}

/** Initials for a tile with no camera: up to two letters. */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = [...parts[0]][0] ?? "";
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] ?? "" : "";
  return (first + last).toUpperCase();
}

// ---------------------------------------------------------------- type and name

export const VIDEO_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
] as const;

/** The first type this browser records: webm (vp9, else vp8) with opus, mp4 where only that works (Safari). */
export function pickVideoType(isTypeSupported: ((t: string) => boolean) | undefined): { mime: string; ext: "webm" | "mp4" } | null {
  if (!isTypeSupported) return null;
  for (const t of VIDEO_TYPES) {
    try { if (isTypeSupported(t)) return { mime: t, ext: t.startsWith("video/mp4") ? "mp4" : "webm" }; } catch { /* a browser that throws on a type does not take it */ }
  }
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Nov 2026 11.30" in the person's local time (no colon: file systems refuse it). */
export function fileDate(d: Date) {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Makes any text safe as part of a file name on Windows, macOS and Linux, with no dashes. */
export function cleanFilePart(s: string) {
  return [...s].map((ch) => { const n = ch.charCodeAt(0); return n < 32 || n === 127 ? " " : ch; }).join("")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\u2010-\u2015\u2212-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .trim();
}

/** "Meeting Weekly sync 3 Nov 2026 11.30.webm"; an empty or unsafe title gives "Meeting 3 Nov 2026 11.30.webm". */
export function videoFileName(title: string | null | undefined, d: Date, ext: "webm" | "mp4") {
  let t = cleanFilePart(title ?? "");
  if (/^meeting$/i.test(t)) t = "";
  if (/^meeting\s/i.test(t)) t = t.slice(8).trim();
  const base = cleanFilePart(`Meeting ${t ? `${t} ` : ""}${fileDate(d)}`);
  const cut = base.length > 120 ? base.slice(0, 120).trim() : base;
  return `${cut}.${ext}`;
}

// ---------------------------------------------------------------- where the bytes go

export interface Sink {
  readonly kind: "file" | "memory";
  readonly bytes: number;
  write(b: Blob): Promise<void>;
  /** Finishes: the file sink closes the file and answers null; the memory sink answers the whole video. PAR1: with the
   * recorded length (ms, pauses left out) a webm gets its duration written into the header (MB-352). */
  close(durationMs?: number): Promise<Blob | null>;
}

/** Keeps the video in this tab until Stop (Safari, Firefox, or when the person did not pick a file). */
export class MemorySink implements Sink {
  readonly kind = "memory" as const;
  private parts: Blob[] = [];
  bytes = 0;
  constructor(private type: string) {}
  async write(b: Blob) { this.parts.push(b); this.bytes += b.size; }
  async close(durationMs?: number) {
    let out = this.parts.length ? new Blob(this.parts, { type: this.type }) : null;
    this.parts = [];
    if (out && durationMs && /webm/i.test(this.type)) {
      try { out = await (await import("./webm-duration-par1")).withWebmDuration(out, durationMs); } catch { /* keep the file as recorded */ }
    }
    return out;
  }
}

/** The part of FileSystemWritableFileStream the file sink uses (seek and the positional write only to fix the header). */
export interface Writable {
  write(b: Blob | { type: "write"; position: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
  seek?(position: number): Promise<void>;
}

/** Writes each chunk, in order, to the file the person chose; long calls keep almost nothing in memory. */
export class FileSink implements Sink {
  readonly kind = "file" as const;
  bytes = 0;
  private chain: Promise<void> = Promise.resolve();
  private head: Blob | null = null;
  constructor(private w: Writable) {}
  write(b: Blob) {
    if (!this.head) this.head = b.slice(0, 4096);
    this.chain = this.chain.then(() => this.w.write(b)).then(() => { this.bytes += b.size; });
    return this.chain;
  }
  async close(durationMs?: number) {
    await this.chain.catch(() => undefined);
    // PAR1 (MB-352): the length goes into the header with one same size write at its place; nothing else moves.
    if (durationMs && this.head && typeof this.w.seek === "function" && /webm/i.test(this.head.type || "webm")) {
      try {
        const { webmDurationPatch } = await import("./webm-duration-par1");
        const p = webmDurationPatch(new Uint8Array(await this.head.arrayBuffer()), durationMs);
        if (p) await this.w.write({ type: "write", position: p.offset, data: p.bytes });
      } catch { /* the video stays as recorded, only without a length */ }
    }
    await this.w.close().catch(() => undefined);
    return null;
  }
}

// ---------------------------------------------------------------- the recording

export type VideoState = "idle" | "recording" | "stopping" | "saved" | "failed";
export type VideoEvent =
  | { type: "state"; state: VideoState }
  | { type: "warn"; bytes: number }
  | { type: "limit"; bytes: number }
  | { type: "error"; message: string };

export interface RecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
  /** VID2: pause and resume (paused time is left out of the file). */
  pause?(): void;
  resume?(): void;
  addEventListener(type: "stop", fn: () => void, opts?: { once?: boolean }): void;
}
export type RecorderCtor = new (stream: MediaStream, opts: { mimeType?: string; videoBitsPerSecond?: number; audioBitsPerSecond?: number }) => RecorderLike;

export interface Saved { blob: Blob | null; bytes: number; kind: "file" | "memory"; reason: "stopped" | "limit" | "error"; error: string | null }

const errText = (e: unknown) => {
  const err = (e as { error?: unknown })?.error ?? e;
  const m = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return m.trim() || "the browser stopped the recorder";
};

/**
 * One video recording: idle -> recording -> stopping -> saved, or failed when the recorder could not start.
 * A recorder error or a file write error mid call stops it and saves what was recorded (reason "error"); the
 * memory sink warns at WARN_BYTES and stops and saves on its own at HARD_BYTES (reason "limit").
 */
export class VideoRecording {
  state: VideoState = "idle";
  private recorder: RecorderLike | null = null;
  private pending: Promise<void> = Promise.resolve();
  private warned = false;
  private writeFailed = false;
  private reason: Saved["reason"] = "stopped";
  private error: string | null = null;
  private stopped: Promise<Saved> | null = null;
  startedAt = 0;
  /** VID2: when the current pause began (0 = not paused) and the paused time so far. */
  private pausedAt = 0;
  private pausedMs = 0;

  constructor(private o: { stream: MediaStream; mime: string; sink: Sink; Recorder: RecorderCtor; onEvent?: (e: VideoEvent) => void; now?: () => number; warnBytes?: number; hardBytes?: number;
    /** VID2: bits per second for the video (VIDEO_BITS when absent). */
    videoBits?: number;
    /** VID2: every piece is also kept on this device as it comes, so a crash loses nothing. */
    keep?: { put(b: Blob): Promise<void> } }) {}

  get sink() { return this.o.sink; }
  get bytes() { return this.o.sink.bytes; }
  get paused() { return this.pausedAt > 0; }
  get elapsedSec() {
    if (!this.startedAt) return 0;
    const now = this.pausedAt || (this.o.now ?? Date.now)();
    return Math.max(0, Math.round((now - this.startedAt - this.pausedMs) / 1000));
  }

  /** VID2: pauses the recorder; nothing is recorded until resume. Answers false when this browser can't pause. */
  pause(): boolean {
    const r = this.recorder;
    if (this.state !== "recording" || this.pausedAt || !r?.pause || r.state !== "recording") return false;
    try { r.pause(); } catch { return false; }
    this.pausedAt = (this.o.now ?? Date.now)();
    return true;
  }

  resume(): boolean {
    const r = this.recorder;
    if (this.state !== "recording" || !this.pausedAt || !r?.resume) return false;
    try { r.resume(); } catch { return false; }
    this.pausedMs += (this.o.now ?? Date.now)() - this.pausedAt;
    this.pausedAt = 0;
    return true;
  }

  private set(state: VideoState) { this.state = state; this.o.onEvent?.({ type: "state", state }); }

  start() {
    if (this.state !== "idle") throw new Error("This recording already started.");
    try {
      const r = new this.o.Recorder(this.o.stream, { mimeType: this.o.mime || undefined, videoBitsPerSecond: this.o.videoBits ?? VIDEO_BITS, audioBitsPerSecond: VIDEO_AUDIO_BITS });
      r.ondataavailable = (e) => { if (e.data && e.data.size) this.pending = this.pending.then(() => this.take(e.data)); };
      r.onerror = (e) => { void this.fail(errText(e)); };
      r.start(TIMESLICE_MS);
      this.recorder = r;
    } catch (e) {
      this.error = errText(e);
      this.set("failed");
      this.o.onEvent?.({ type: "error", message: this.error });
      throw e;
    }
    this.startedAt = (this.o.now ?? Date.now)();
    this.set("recording");
  }

  private async take(b: Blob) {
    if (this.writeFailed) return;
    void this.o.keep?.put(b);
    try {
      await this.o.sink.write(b);
    } catch (e) {
      this.writeFailed = true;
      void this.fail(`the video file could not be written (${errText(e)})`);
      return;
    }
    if (this.o.sink.kind !== "memory" || this.state !== "recording") return;
    const bytes = this.o.sink.bytes;
    if (bytes >= (this.o.hardBytes ?? HARD_BYTES)) {
      this.reason = "limit";
      this.o.onEvent?.({ type: "limit", bytes });
      void this.stop();
    } else if (!this.warned && bytes >= (this.o.warnBytes ?? WARN_BYTES)) {
      this.warned = true;
      this.o.onEvent?.({ type: "warn", bytes });
    }
  }

  private async fail(message: string) {
    if (this.error || this.state === "saved") return;
    this.error = message;
    this.reason = "error";
    this.o.onEvent?.({ type: "error", message });
    await this.stop();
  }

  /** Stops the recorder, waits for the last chunk, finishes the sink. Safe to call more than once. */
  stop(): Promise<Saved> {
    if (this.stopped) return this.stopped;
    this.stopped = (async () => {
      if (this.state === "idle" || this.state === "failed") return { blob: null, bytes: 0, kind: this.o.sink.kind, reason: this.reason, error: this.error };
      this.set("stopping");
      if (this.pausedAt) { this.pausedMs += (this.o.now ?? Date.now)() - this.pausedAt; this.pausedAt = 0; }
      const r = this.recorder;
      if (r && r.state !== "inactive") {
        await new Promise<void>((res) => {
          r.addEventListener("stop", () => setTimeout(res, 0), { once: true });
          try { r.stop(); } catch { res(); }
        });
      }
      await this.pending.catch(() => undefined);
      const recordedMs = this.startedAt ? Math.max(0, (this.o.now ?? Date.now)() - this.startedAt - this.pausedMs) : 0;
      const blob = await this.o.sink.close(recordedMs || undefined);
      this.set("saved");
      return { blob, bytes: this.o.sink.bytes, kind: this.o.sink.kind, reason: this.reason, error: this.error };
    })();
    return this.stopped;
  }
}

/** "1.5 GB", "320 MB": the size in the warning. */
export function sizeText(bytes: number) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, "")} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

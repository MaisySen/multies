/**
 * VID1: draws every person's camera and screen share onto one canvas for the video recording (grid, names,
 * the speaker's ring, the share given the big tile) and turns it into a video track. Loaded only when an admin
 * starts a video recording (dynamic import), never at page load. Frames are drawn on ticks from a small same
 * origin worker, because a hidden tab stops animation frames and slows timers but still delivers worker messages.
 */
import { CANVAS_H, CANVAS_W, FPS, initials, layoutTiles, type Placement, type TileInput } from "./video-rec-vid1";

export interface SourceTile extends TileInput { track: MediaStreamTrack | null }

const BG = "#111214";
const TILE_BG = "#25262b";
const AVATAR = ["#3b5bdb", "#0b7285", "#2b8a3e", "#a61e4d", "#5f3dc4", "#c2410c", "#1864ab", "#087f5b"];

function hue(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR[h % AVATAR.length];
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** The text cut to fit maxW with an ellipsis. */
function fit(g: CanvasRenderingContext2D, text: string, maxW: number) {
  if (g.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (g.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo ? `${text.slice(0, lo).trimEnd()}…` : "…";
}

export class CallCompositor {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private holder: HTMLDivElement;
  private videos = new Map<string, HTMLVideoElement>();
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private brand = "#2f6fed";
  private font = "system-ui, sans-serif";
  /** Set when drawing failed (for example a canvas the browser lost); the recording stops and saves. */
  onFail: ((message: string) => void) | null = null;
  private failed = false;

  constructor(private source: () => SourceTile[]) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    const g = this.canvas.getContext("2d", { alpha: false });
    if (!g) throw new Error("This browser can't draw the video.");
    this.g = g;
    // Hidden, in the page (some browsers only decode video elements that are in the document).
    this.holder = document.createElement("div");
    this.holder.setAttribute("aria-hidden", "true");
    this.holder.dataset.testid = "video-rec-sources";
    Object.assign(this.holder.style, { position: "fixed", left: "-4px", top: "-4px", width: "2px", height: "2px", overflow: "hidden", opacity: "0", pointerEvents: "none" });
    document.body.appendChild(this.holder);
    const css = getComputedStyle(document.documentElement);
    this.brand = css.getPropertyValue("--color-brand").trim() || this.brand;
    this.font = getComputedStyle(document.body).fontFamily || this.font;
  }

  /** Starts drawing and answers the canvas video track. */
  start(): MediaStreamTrack {
    const capture = (this.canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream;
    if (typeof capture !== "function") throw new Error("This browser can't record the call as video.");
    this.draw();
    const track = capture.call(this.canvas, FPS).getVideoTracks()[0];
    if (!track) throw new Error("This browser can't record the call as video.");
    try {
      this.worker = new Worker(new URL("./video-tick-vid1.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = () => this.draw();
      this.worker.onerror = () => this.useTimer();
      this.worker.postMessage({ fps: FPS });
    } catch {
      this.useTimer();
    }
    return track;
  }

  private useTimer() {
    this.worker?.terminate();
    this.worker = null;
    if (!this.timer) this.timer = setInterval(() => this.draw(), Math.round(1000 / FPS));
  }

  /** Keeps one hidden video element per track: new tracks get one, gone tracks lose theirs. */
  private sync(tiles: SourceTile[]) {
    const want = new Map<string, MediaStreamTrack>();
    for (const t of tiles) if (t.track && t.hasVideo) want.set(t.track.id, t.track);
    for (const [id, v] of this.videos) {
      if (!want.has(id)) { v.pause(); v.srcObject = null; v.remove(); this.videos.delete(id); }
    }
    for (const [id, track] of want) {
      if (this.videos.has(id)) continue;
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.srcObject = new MediaStream([track]);
      this.holder.appendChild(v);
      void v.play().catch(() => undefined);
      this.videos.set(id, v);
    }
  }

  private draw() {
    if (this.failed) return;
    try {
      const tiles = this.source();
      this.sync(tiles);
      const g = this.g;
      g.fillStyle = BG;
      g.fillRect(0, 0, CANVAS_W, CANVAS_H);
      const placed = layoutTiles(tiles);
      if (!placed.length) {
        g.fillStyle = "rgba(255,255,255,0.7)";
        g.font = `500 22px ${this.font}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText("Waiting for people to join", CANVAS_W / 2, CANVAS_H / 2);
        return;
      }
      const byId = new Map(tiles.map((t) => [t.id, t]));
      for (const p of placed) this.tile(p, p.id ? byId.get(p.id) ?? null : null);
    } catch (e) {
      this.failed = true;
      this.onFail?.(e instanceof Error ? e.message : "drawing the video failed");
    }
  }

  private tile(p: Placement, src: SourceTile | null) {
    const g = this.g;
    const { x, y, w, h } = p.rect;
    const r = Math.min(12, w / 12, h / 12);
    g.save();
    roundRect(g, x, y, w, h, r);
    g.clip();
    g.fillStyle = p.kind === "screen" ? "#000" : TILE_BG;
    g.fillRect(x, y, w, h);
    const v = src?.track ? this.videos.get(src.track.id) : undefined;
    const ready = !!v && p.hasVideo && v.readyState >= 2 && v.videoWidth > 0;
    if (ready && v) {
      const vw = v.videoWidth, vh = v.videoHeight;
      // Cameras fill the tile (cropped); a screen share is shown whole (letterboxed).
      const scale = p.kind === "screen" ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
      const dw = vw * scale, dh = vh * scale;
      g.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else if (p.kind === "more") {
      g.fillStyle = "rgba(255,255,255,0.85)";
      g.font = `600 ${Math.round(Math.max(14, Math.min(28, h / 6)))}px ${this.font}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(p.name, x + w / 2, y + h / 2);
    } else {
      const d = Math.min(w, h) * 0.34;
      g.fillStyle = hue(p.name);
      g.beginPath();
      g.arc(x + w / 2, y + h / 2, d / 2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff";
      g.font = `600 ${Math.round(d * 0.4)}px ${this.font}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(p.kind === "screen" ? "…" : initials(p.name), x + w / 2, y + h / 2 + 1);
    }
    g.restore();
    if (p.kind !== "more") this.label(p);
    if (p.speaking && p.kind === "camera") {
      g.save();
      g.lineWidth = 3;
      g.strokeStyle = this.brand;
      roundRect(g, x + 1.5, y + 1.5, w - 3, h - 3, Math.max(0, r - 1.5));
      g.stroke();
      g.restore();
    }
  }

  private label(p: Placement) {
    const g = this.g;
    const { x, y, w, h } = p.rect;
    const size = Math.round(Math.max(11, Math.min(18, h / 11)));
    const pad = Math.round(size * 0.55);
    const margin = Math.round(Math.max(6, Math.min(12, h / 24)));
    g.font = `600 ${size}px ${this.font}`;
    const text = fit(g, p.kind === "screen" ? `${p.name}'s screen` : p.name, w - 2 * margin - 2 * pad);
    const tw = g.measureText(text).width;
    const bh = size + pad * 1.2;
    const bx = x + margin, by = y + h - margin - bh;
    g.fillStyle = "rgba(0,0,0,0.58)";
    roundRect(g, bx, by, tw + 2 * pad, bh, bh / 2);
    g.fill();
    g.fillStyle = "#fff";
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(text, bx + pad, by + bh / 2 + 0.5);
  }

  dispose() {
    this.failed = true;
    this.worker?.postMessage({ stop: true });
    this.worker?.terminate();
    this.worker = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const v of this.videos.values()) { v.pause(); v.srcObject = null; }
    this.videos.clear();
    this.holder.remove();
  }
}

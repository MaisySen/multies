/**
 * VID3: recording a call on a phone browser (iPhone Safari, Android Chrome). The pure parts: is this a phone, which
 * recording type a phone should use (mp4 first so Photos and the gallery take it), how much a phone may keep in
 * memory before the video is saved as a part, how the video is saved (the share sheet, else a download link), and the
 * list of videos waiting for the person's Save tap. No DOM here except what is passed in, so it runs in unit tests.
 * Like VID1 and VID2, nothing in VID3 uploads anything: the video only ever goes to the person's own device.
 */

export interface DeviceHints { ua: string; maxTouchPoints?: number; platform?: string; coarse?: boolean }

/** iPhone, iPad (iPadOS says "Macintosh" with touch), Android phones and tablets: a device whose browser has no save as picker. */
export function isPhoneDevice(h: DeviceHints): boolean {
  const ua = h.ua || "";
  if (/iPhone|iPod|iPad|Android|Mobile/i.test(ua)) return true;
  // iPadOS 13+ asks for the desktop site: a Mac user agent with a touch screen.
  if (/Macintosh/i.test(ua) && (h.maxTouchPoints ?? 0) > 1) return true;
  return false;
}

export const isAppleMobile = (h: DeviceHints) => /iPhone|iPod|iPad/i.test(h.ua || "") || (/Macintosh/i.test(h.ua || "") && (h.maxTouchPoints ?? 0) > 1);

/** The iOS version from a user agent ("OS 14_4 like Mac OS X" gives [14, 4]); null when it is not iOS or not stated. */
export function iosVersion(ua: string): [number, number] | null {
  const m = /(?:iPhone|iPad|iPod)[^)]*?OS (\d+)[_.](\d+)/i.exec(ua || "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Safari on iOS records video from 14.5 (MediaRecorder on by default). Older versions get a plain message. */
export function iosTooOld(ua: string): boolean {
  const v = iosVersion(ua);
  return !!v && (v[0] < 14 || (v[0] === 14 && v[1] < 5));
}

/** On a phone mp4 comes first: iPhone Photos only takes mp4 or mov, and the Android gallery plays mp4 everywhere. */
export const PHONE_VIDEO_TYPES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4;codecs=h264,aac",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

/** The first type this phone records, asked of the browser (never assumed). */
export function pickPhoneVideoType(isTypeSupported: ((t: string) => boolean) | undefined): { mime: string; ext: "webm" | "mp4" } | null {
  if (!isTypeSupported) return null;
  for (const t of PHONE_VIDEO_TYPES) {
    try { if (isTypeSupported(t)) return { mime: t, ext: t.startsWith("video/mp4") ? "mp4" : "webm" }; } catch { /* a browser that throws on a type does not take it */ }
  }
  return null;
}

/** The file extension that matches what the recorder really made (Safari may answer a plainer type than asked). */
export function extFor(mime: string, asked: "webm" | "mp4"): "webm" | "mp4" {
  if (/mp4|quicktime/i.test(mime)) return "mp4";
  if (/webm/i.test(mime)) return "webm";
  return asked;
}

/** A phone's frame and bits: 720p at 24 frames and 2 Mbit/s, about 15 MB a minute, so a part lasts about half an hour. */
export const PHONE_QUALITY = { id: "hd720" as const, label: "720p", w: 1280, h: 720, fps: 24, videoBits: 2_000_000 };

const MB = 1024 ** 2;
/**
 * How much of a video a phone keeps in memory. iPhone Safari stops a tab that uses much more than about 1 GB, and
 * Android Chrome gives a tab a share of the device memory (navigator.deviceMemory, rounded, at most 8). The warning
 * offers "Save this part" at warn; at part the video is saved as a part on its own and recording carries on in a new one.
 */
export function phoneBudget(h: DeviceHints & { deviceMemoryGb?: number }): { warn: number; part: number } {
  let part: number;
  if (isAppleMobile(h)) part = 400 * MB;
  else if ((h.deviceMemoryGb ?? 0) >= 8) part = 700 * MB;
  else if ((h.deviceMemoryGb ?? 0) >= 4) part = 450 * MB;
  else if (h.deviceMemoryGb !== undefined) part = 250 * MB;
  else part = 400 * MB;
  return { warn: Math.round(part * 0.75), part };
}

/** "Meeting Weekly sync 4 Nov 2026 01.30 part 2.mp4" (part 1 keeps the plain name). */
export function partFileName(fileName: string, part: number): string {
  if (part <= 1) return fileName;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? `${fileName.slice(0, dot)} part ${part}${fileName.slice(dot)}` : `${fileName} part ${part}`;
}

export interface ShareNav { canShare?: (d: { files?: File[] }) => boolean; share?: (d: { files?: File[]; title?: string }) => Promise<void> }

/**
 * How the video is saved on a phone: "share" when the browser can share these files (the share sheet offers Save to
 * Files, Save video to Photos, Drive), else "download" (a link the person taps, saved to Downloads).
 */
export function saveMode(nav: ShareNav | undefined, files: File[]): "share" | "download" {
  try { if (nav?.share && nav.canShare && files.length && nav.canShare({ files })) return "share"; } catch { /* a browser that throws can't share them */ }
  return "download";
}

/**
 * Which files go into one share: the video with its side files (chat, transcript) when the browser takes them
 * together, else the video alone and the side files offered as a second step.
 */
export function shareGroups(nav: ShareNav | undefined, video: File, sides: File[]): { now: File[]; later: File[] } {
  if (sides.length && saveMode(nav, [video, ...sides]) === "share") return { now: [video, ...sides], later: [] };
  return { now: [video], later: sides };
}

/** What happens when the page goes to the background while a phone records: pause when the browser can, else stop and save. */
export const backgroundAction = (canPause: boolean): "pause" | "stop" => (canPause ? "pause" : "stop");

// ---------------------------------------------------------------- videos waiting for the person's Save tap

export interface ReadyVideo {
  id: string;
  name: string;
  blob: Blob;
  /** Text files that go with it (chat log, transcript), added as they arrive. */
  sides: { name: string; text: string }[];
  /** How many times the person saved it (the share sheet closed with a choice, or the link was tapped). */
  saves: number;
  sidesSaved: boolean;
  /** The recording's own name (a part's side files belong to the whole recording, so they join its last part). */
  group: string;
  /** The crash safe pieces kept for it on this device (VID2), let go once it is saved or discarded. */
  keepId: string | null;
  release: (() => void) | null;
}

type Listener = () => void;

/**
 * The videos a phone recorded and has not let go of yet. A phone browser only opens the share sheet from a tap, so
 * Stop puts the video here and a Save button shows it; it stays (in this tab only) until the person taps Done. It
 * lives outside the call so hanging up keeps it, and the meeting page shows the same list.
 */
export class ReadyList {
  private items: ReadyVideo[] = [];
  private listeners = new Set<Listener>();
  private seq = 0;
  list() { return this.items; }
  subscribe(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private emit() { this.items = [...this.items]; for (const l of this.listeners) l(); }
  add(name: string, blob: Blob, o: { group?: string; keepId?: string | null; release?: (() => void) | null } = {}): string {
    const id = `v${++this.seq}`;
    this.items.push({ id, name, blob, sides: [], saves: 0, sidesSaved: false, group: o.group ?? name, keepId: o.keepId ?? null, release: o.release ?? null });
    this.emit();
    return id;
  }
  /** The kept pieces that belong to a video in this list (the recovery offer leaves them alone). */
  keepIds(): string[] { return this.items.map((x) => x.keepId).filter((x): x is string => !!x); }
  private letGo(v: ReadyVideo) { const r = v.release; v.release = null; try { r?.(); } catch { /* best effort */ } }
  /** A side file for the recording with this name (the transcript arrives a minute after Stop); it joins its last part. Answers whether it found it. */
  addSide(group: string, side: { name: string; text: string }): boolean {
    const v = [...this.items].reverse().find((x) => x.group === group);
    if (!v || v.sides.some((s) => s.name === side.name)) return !!v;
    v.sides = [...v.sides, side];
    v.sidesSaved = false;
    this.emit();
    return true;
  }
  saved(id: string, withSides: boolean) {
    const v = this.items.find((x) => x.id === id);
    if (!v) return;
    v.saves++;
    if (withSides) v.sidesSaved = true;
    this.letGo(v);
    this.emit();
  }
  sidesSaved(id: string) {
    const v = this.items.find((x) => x.id === id);
    if (!v) return;
    v.sidesSaved = true;
    this.emit();
  }
  remove(id: string) {
    const v = this.items.find((x) => x.id === id);
    if (v) this.letGo(v);
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.items.length !== before) this.emit();
  }
}

/** The one list for this tab. */
export const readyVideos = new ReadyList();

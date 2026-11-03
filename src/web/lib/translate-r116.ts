/**
 * R116 Translate and read aloud, the browser side: preferences per person on this device, translation through
 * POST /api/translate in small calls, and read aloud on the device's own speech engine (no server, no network).
 * Loaded only with the R116 chunk (components/lang-tools-r116.tsx).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { useMe } from "./queries";
import {
  batches, detectLanguage, isR116Language, languageLabel, pickVoice, readPrefs, R116_LIMITS, R116_PREFS_KEY, SPEECH_TAGS, speechChunks, uniqueTexts,
  type Piece, type R116Language, type R116Prefs,
} from "@/shared/translate-r116";

// ------------------------------------------------------------------ preferences

const PREFS_EVENT = "multies-r116-prefs";
const localeLanguage = (locale?: string | null): R116Language => {
  const c = String(locale ?? (typeof navigator === "undefined" ? "en" : navigator.language) ?? "en").slice(0, 2).toLowerCase();
  return isR116Language(c) ? c : "en";
};

/** The person's translate settings on this device: the last language chosen and whether to offer translation. */
export function useR116Prefs(): [R116Prefs, (p: Partial<R116Prefs>) => void] {
  const me = useMe();
  const uid = me.data?.user.id ?? "anon";
  const fallback = localeLanguage(me.data?.user.locale);
  const read = useCallback((): R116Prefs => {
    try { return readPrefs(localStorage.getItem(R116_PREFS_KEY(uid)), fallback); } catch { return { target: fallback, autoOffer: true }; }
  }, [uid, fallback]);
  const [prefs, setPrefsState] = useState<R116Prefs>(read);
  useEffect(() => {
    setPrefsState(read());
    const on = () => setPrefsState(read());
    window.addEventListener(PREFS_EVENT, on);
    return () => window.removeEventListener(PREFS_EVENT, on);
  }, [read]);
  const set = useCallback((p: Partial<R116Prefs>) => {
    const next = { ...read(), ...p };
    try { localStorage.setItem(R116_PREFS_KEY(uid), JSON.stringify(next)); } catch { /* storage blocked: kept for this page only */ }
    setPrefsState(next);
    window.dispatchEvent(new Event(PREFS_EVENT));
  }, [read, uid]);
  return [prefs, set];
}

// ------------------------------------------------------------------ translation

export type TranslateResult = { map: Map<string, string>; source: R116Language | null; target: R116Language; same: boolean };
const memo = new Map<string, TranslateResult>();

/**
 * Translates the pieces of one mail, doc or message. `key` names its version (for example the message id): the same
 * version in the same language is translated once per page load.
 */
export async function translatePieces(key: string, pieces: Piece[], target: R116Language, onProgress?: (done: number, total: number) => void): Promise<TranslateResult> {
  const texts = uniqueTexts(pieces);
  if (texts.length === 0) throw new Error("There is no text to translate here.");
  if (texts.reduce((n, t) => n + t.length, 0) > R116_LIMITS.totalChars) throw new Error("That is a lot of text to translate at once. Select a part and translate that.");
  const source = detectLanguage(texts.join("\n"));
  if (source === target) return { map: new Map(), source, target, same: true };
  const k = `${key}|${target}|${texts.length}|${texts[0]?.slice(0, 80)}`;
  const hit = memo.get(k);
  if (hit) return hit;
  const groups = batches(texts);
  const map = new Map<string, string>();
  let done = 0;
  onProgress?.(0, groups.length);
  for (const g of groups) {
    const r = await api.post<{ texts: string[]; same: boolean }>("/translate", { texts: g.map((i) => texts[i]), target, source });
    g.forEach((i, n) => { if (r.texts[n]) map.set(texts[i], r.texts[n]); });
    onProgress?.(++done, groups.length);
  }
  const out = { map, source, target, same: false };
  if (memo.size > 100) memo.delete(memo.keys().next().value as string);
  memo.set(k, out);
  return out;
}

/** The readable words of sanitised mail HTML (styles and scripts dropped), for read aloud and the language guess. */
export function htmlText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("style,script,noscript,template,head").forEach((n) => n.remove());
    doc.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
    doc.querySelectorAll("p,div,li,tr,h1,h2,h3,h4,h5,h6,blockquote").forEach((n) => n.append("\n"));
    return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  } catch { return ""; }
}

// ------------------------------------------------------------------ read aloud

export type SpeechState = { status: "idle" | "playing" | "paused"; owner: string | null; rate: number; note: string | null };
let speech: SpeechState = { status: "idle", owner: null, rate: 1, note: null };
const subs = new Set<() => void>();
const emit = (p: Partial<SpeechState>) => { speech = { ...speech, ...p }; subs.forEach((f) => f()); };
let queue: string[] = [], at = 0, gen = 0, voice: SpeechSynthesisVoice | null = null, lang = "en";

export const useSpeech = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => speech, () => speech);
export const speechSupported = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";

async function deviceVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = window.speechSynthesis;
  const now = s.getVoices();
  if (now.length) return now;
  await new Promise<void>((res) => {
    const t = setTimeout(res, 1_200);
    s.addEventListener("voiceschanged", () => { clearTimeout(t); res(); }, { once: true });
  });
  return s.getVoices();
}

function speakNext(my: number) {
  if (my !== gen) return;
  if (at >= queue.length) { emit({ status: "idle", owner: null, note: null }); return; }
  const u = new SpeechSynthesisUtterance(queue[at]);
  if (voice) u.voice = voice;
  u.lang = lang;
  u.rate = speech.rate;
  u.onend = () => { if (my !== gen) return; at++; speakNext(my); };
  u.onerror = (e) => {
    if (my !== gen || e.error === "interrupted" || e.error === "canceled") return;
    gen++;
    emit({ status: "idle", note: "Reading stopped. Try Read aloud again." });
  };
  window.speechSynthesis.speak(u);
}

/** Reads `text` aloud for `owner` (one reading at a time on the page), in a voice of the text's language. */
export async function startReading(owner: string, text: string): Promise<void> {
  stopReading();
  if (!speechSupported()) { emit({ owner, note: "Read aloud is not available in this browser." }); return; }
  const parts = speechChunks(text);
  if (parts.length === 0) { emit({ owner, note: "There is nothing to read here." }); return; }
  const my = ++gen;
  const code = detectLanguage(text) ?? "en";
  emit({ status: "playing", owner, note: null });
  const list = await deviceVoices();
  if (my !== gen) return;
  const pick = pickVoice(list, code);
  if (!pick.voice && list.length > 0) {
    gen++;
    emit({ status: "idle", owner, note: `This device has no ${languageLabel(code)} voice. Add one in your device's speech settings, or translate the text first.` });
    return;
  }
  voice = pick.voice;
  lang = pick.voice?.lang ?? SPEECH_TAGS[code][0];
  queue = parts; at = 0;
  emit({ status: "playing", owner, note: pick.fallback ? `No ${languageLabel(code)} voice on this device, so a ${languageLabel(pick.fallback)} voice reads it.` : null });
  speakNext(my);
}
export function pauseReading() { if (speech.status !== "playing") return; window.speechSynthesis.pause(); emit({ status: "paused" }); }
export function resumeReading() { if (speech.status !== "paused") return; window.speechSynthesis.resume(); emit({ status: "playing" }); }
/** Stops reading (only `owner`'s reading when given). */
export function stopReading(owner?: string) {
  if (owner && speech.owner !== owner) return;
  gen++; queue = []; at = 0;
  if (speechSupported()) window.speechSynthesis.cancel();
  if (speech.status !== "idle" || speech.owner || speech.note) emit({ status: "idle", owner: null, note: null });
}
export function setReadingRate(rate: number) {
  emit({ rate });
  if (speech.status !== "playing" || !queue.length) return;
  const my = ++gen;
  window.speechSynthesis.cancel();
  setTimeout(() => speakNext(my), 0);
}
if (typeof window !== "undefined") window.addEventListener("pagehide", () => stopReading());

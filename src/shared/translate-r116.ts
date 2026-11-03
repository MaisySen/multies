/**
 * R116 Translate and read aloud: the pure parts shared by the server route, the web app and the unit tests.
 * Languages (the codes the built in translation already supports), a small source language guess, text and HTML
 * splitting for translation, and the speech tag for each language. No DOM, no network, no model here.
 */

/** Target and source languages: the same codes and names as the Tools translation (TRANSLATE_LANGUAGES). */
export const R116_LANGUAGES = {
  en: "English", ne: "Nepali", hi: "Hindi", zh: "Chinese", ar: "Arabic", vi: "Vietnamese", id: "Indonesian",
  es: "Spanish", fr: "French", de: "German", ja: "Japanese", ko: "Korean",
} as const;
export type R116Language = keyof typeof R116_LANGUAGES;
export const isR116Language = (v: unknown): v is R116Language => typeof v === "string" && Object.hasOwn(R116_LANGUAGES, v);
export const languageLabel = (code: string | null | undefined) => (code && isR116Language(code) ? R116_LANGUAGES[code] : "another language");

/** Speech synthesis tags, most specific first, for picking a device voice. */
export const SPEECH_TAGS: Record<R116Language, string[]> = {
  en: ["en-AU", "en-GB", "en-US", "en"], ne: ["ne-NP", "ne"], hi: ["hi-IN", "hi"], zh: ["zh-CN", "zh-TW", "zh-HK", "zh"], ar: ["ar-SA", "ar"],
  vi: ["vi-VN", "vi"], id: ["id-ID", "id"], es: ["es-ES", "es-MX", "es-US", "es"], fr: ["fr-FR", "fr-CA", "fr"], de: ["de-DE", "de"],
  ja: ["ja-JP", "ja"], ko: ["ko-KR", "ko"],
};

/** Limits. Server: one call. Client: one whole mail, doc or selection (split into calls of BATCH_CHARS). */
export const R116_LIMITS = {
  /** Strings and characters one translate call takes (the server refuses more with 413). */
  callTexts: 60, callChars: 4_000,
  /** What the app sends per call (under callChars so one call stays one small reservation on the meter). */
  batchChars: 3_000, batchTexts: 40,
  /** The most text one translation of a mail, doc or selection takes. */
  totalChars: 24_000,
  /** One piece of text sent for translation is at most this long (longer text is split at sentences). */
  pieceChars: 1_200,
  /** Translate calls a person may make a minute. */
  perMinute: 30,
} as const;

const NE_WORDS = ["छ", "छन्", "हो", "हुन्छ", "लाई", "भएको", "गर्न", "पनि", "हुने", "गरेको", "थियो", "तपाईं", "हामी", "कृपया", "बाँकी", "अहिलेसम्म", "छैन", "गर्नुहोस्", "मात्र", "भने"];
const HI_WORDS = ["है", "हैं", "का", "की", "के", "में", "नहीं", "और", "से", "यह", "था", "आप", "हम", "कृपया", "करें", "लिए", "गया", "किया", "भी", "तो"];
const LATIN: Partial<Record<R116Language, string[]>> = {
  en: ["the", "and", "is", "to", "of", "you", "for", "in", "that", "it", "with", "this", "are", "your", "we", "be", "on", "have", "will", "please"],
  es: ["el", "la", "los", "las", "que", "y", "es", "por", "para", "con", "una", "del", "gracias", "usted", "pero", "como", "muy", "hola"],
  fr: ["le", "les", "des", "et", "est", "pour", "une", "pas", "vous", "dans", "avec", "du", "sur", "je", "nous", "merci", "bonjour", "mais"],
  de: ["der", "die", "das", "und", "ist", "nicht", "mit", "ich", "sie", "zu", "den", "ein", "eine", "für", "auf", "wir", "danke", "bitte"],
  id: ["dan", "yang", "di", "ini", "itu", "dengan", "untuk", "tidak", "ada", "saya", "kami", "akan", "dari", "ke", "anda", "terima", "kasih"],
  vi: ["của", "và", "là", "không", "được", "có", "cho", "với", "này", "những", "các", "một", "chúng", "tôi", "bạn", "cảm", "ơn"],
};

/**
 * A best guess of the language a text is written in, from its script and its commonest words. Returns null for text
 * too short or too mixed to tell. Devanagari is Nepali unless Hindi's common words outnumber Nepali's.
 */
export function detectLanguage(input: string): R116Language | null {
  const text = input.replace(/https?:\/\/\S+|\S+@\S+|[0-9]+/g, " ").slice(0, 6_000);
  let deva = 0, arab = 0, hang = 0, kana = 0, han = 0, latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x0900 && c <= 0x097f) deva++;
    else if (c >= 0x0600 && c <= 0x06ff) arab++;
    else if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff)) hang++;
    else if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if (c >= 0x4e00 && c <= 0x9fff) han++;
    else if (/\p{Script=Latin}/u.test(ch)) latin++;
  }
  const total = deva + arab + hang + kana + han + latin;
  if (total < 3) return null;
  const top = Math.max(deva, arab, hang, kana + han, latin);
  if (top === deva) {
    const words = text.split(/[\s,.;:!?()"'।॥-]+/).filter(Boolean);
    const ne = words.filter((w) => NE_WORDS.includes(w)).length, hi = words.filter((w) => HI_WORDS.includes(w)).length;
    return hi > ne ? "hi" : "ne";
  }
  if (top === arab) return "ar";
  if (top === hang) return "ko";
  if (top === kana + han) return kana > 0 ? "ja" : "zh";
  const words = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length === 0) return null;
  let best: R116Language | null = null, score = 0;
  for (const [code, list] of Object.entries(LATIN) as [R116Language, string[]][]) {
    const s = words.reduce((n, w) => n + (list.includes(w) ? 1 : 0), 0) + (code === "vi" ? (text.match(/[ơưăđạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu)?.length ?? 0) / 2 : 0);
    if (s > score) { score = s; best = code; }
  }
  return best ?? (words.length >= 3 ? "en" : null);
}

/** Whether a piece of text has anything a translator would change (not only spaces, numbers, links or symbols). */
export function hasWords(s: string): boolean {
  return /\p{L}{2,}/u.test(s.replace(/https?:\/\/\S+|\S+@\S+\.\S+/g, " "));
}

/** Splits one long piece at sentence ends (then spaces, then hard) so each part is at most `max` characters. */
export function splitLong(s: string, max: number = R116_LIMITS.pieceChars): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = Math.max(...[". ", "! ", "? ", "। ", "؟ ", "。", "\n"].map((p) => { const i = head.lastIndexOf(p); return i < 0 ? -1 : i + p.length; }));
    if (cut < max / 3) cut = head.lastIndexOf(" ") + 1;
    if (cut < max / 3) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/** A text cut into pieces: `t` pieces go to the translator, the others (spaces and line breaks) stay as they are. */
export type Piece = { s: string; t: boolean };

/** Plain text (a chat message, a text mail, a doc) as pieces: line breaks kept, each line split if long. */
export function textPieces(text: string, max: number = R116_LIMITS.pieceChars): Piece[] {
  const out: Piece[] = [];
  for (const part of text.split(/(\s*\n\s*)/)) {
    if (!part) continue;
    if (/^\s*\n\s*$/.test(part) || !hasWords(part)) { out.push({ s: part, t: false }); continue; }
    const lead = /^\s*/.exec(part)![0], trail = /\s*$/.exec(part)![0];
    if (lead) out.push({ s: lead, t: false });
    const core = part.slice(lead.length, part.length - trail.length);
    for (const p of splitLong(core, max)) out.push({ s: p, t: true });
    if (trail) out.push({ s: trail, t: false });
  }
  return out;
}

/** The strings to send for a list of pieces, each once (repeats cost nothing twice). */
export function uniqueTexts(pieces: Piece[]): string[] {
  return [...new Set(pieces.filter((p) => p.t).map((p) => p.s.trim()).filter(Boolean))];
}

/** Puts pieces back together with their translations (a missing translation keeps the original). */
export function joinPieces(pieces: Piece[], map: Map<string, string>, escape: (s: string) => string = (s) => s): string {
  return pieces.map((p) => {
    if (!p.t) return p.s;
    const k = p.s.trim(), tr = map.get(k);
    if (!tr) return escape(p.s);
    const lead = /^\s*/.exec(p.s)![0], trail = /\s*$/.exec(p.s)![0];
    return lead + escape(tr) + trail;
  }).join("");
}

/** Groups strings into calls: at most `chars` characters and `items` strings each. Returns index groups. */
export function batches(texts: string[], chars: number = R116_LIMITS.batchChars, items: number = R116_LIMITS.batchTexts): number[][] {
  const out: number[][] = [];
  let cur: number[] = [], n = 0;
  texts.forEach((t, i) => {
    if (cur.length && (cur.length >= items || n + t.length > chars)) { out.push(cur); cur = []; n = 0; }
    cur.push(i); n += t.length;
  });
  if (cur.length) out.push(cur);
  return out;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", hellip: "\u2026", ndash: "\u2013", mdash: "\u2014", copy: "\u00a9" };
/** Decodes the character references found in HTML text (named ones not listed stay as written). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
/** Escapes text for HTML, so a translation can only ever be text, never markup. */
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Tags whose text is never translated (code, styles, scripts and the like). */
const SKIP = new Set(["style", "script", "code", "pre", "kbd", "samp", "title", "textarea", "svg", "math", "noscript", "template"]);
const TAG_RE = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^\s/>]*(?:[^>"']|"[^"]*"|'[^']*')*>/g;

/**
 * Sanitised mail HTML as pieces: tags, comments and text inside code or styles stay exactly as they are; every other
 * text node is a piece to translate (decoded, so the translator sees words, not character references).
 */
export function htmlPieces(html: string, max: number = R116_LIMITS.pieceChars): Piece[] {
  const out: Piece[] = [];
  const skip: string[] = [];
  let last = 0;
  const pushText = (raw: string) => {
    if (!raw) return;
    if (skip.length || !hasWords(decodeEntities(raw))) { out.push({ s: raw, t: false }); return; }
    for (const p of textPieces(decodeEntities(raw), max)) out.push(p.t ? p : { s: escapeHtml(p.s), t: false });
  };
  for (const m of html.matchAll(TAG_RE)) {
    pushText(html.slice(last, m.index));
    const tag = m[0];
    out.push({ s: tag, t: false });
    const name = /^<\/?([a-zA-Z][^\s/>]*)/.exec(tag)?.[1]?.toLowerCase();
    if (name && SKIP.has(name)) {
      if (tag.startsWith("</")) { const i = skip.lastIndexOf(name); if (i >= 0) skip.splice(i, 1); }
      else if (!tag.endsWith("/>")) skip.push(name);
    }
    last = m.index + tag.length;
  }
  pushText(html.slice(last));
  return out;
}

/** The translated HTML: tags kept byte for byte, each translation escaped as text. The reading pane sanitises it again. */
export const joinHtml = (pieces: Piece[], map: Map<string, string>) => joinPieces(pieces, map, escapeHtml);

/** Preferences, kept per person on this device. */
export type R116Prefs = { target: R116Language; autoOffer: boolean };
export const R116_PREFS_KEY = (userId: string) => `multies.translate.${userId}`;
export function readPrefs(raw: string | null, fallback: R116Language = "en"): R116Prefs {
  try {
    const v = JSON.parse(raw ?? "{}") as Partial<R116Prefs>;
    return { target: isR116Language(v.target) ? v.target : fallback, autoOffer: v.autoOffer !== false };
  } catch { return { target: fallback, autoOffer: true }; }
}

/** Read aloud: text cut at sentences into parts short enough for every browser's speech engine. */
export function speechChunks(text: string, max = 220): string[] {
  return text.split(/\n\s*\n|\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(hasWords).flatMap((l) => splitLong(l, max).map((p) => p.trim())).filter(Boolean);
}

/** The few fields of a device voice the picker reads (SpeechSynthesisVoice has them). */
export type VoiceLike = { lang: string; name: string; localService?: boolean; default?: boolean };
/**
 * The device voice for a language: an exact tag first, then the language alone, a voice on the device before a network
 * one. Nepali falls back to a Hindi voice (same script); `fallback` names the language of the voice used then.
 */
export function pickVoice<V extends VoiceLike>(voices: V[], code: R116Language): { voice: V | null; fallback: R116Language | null } {
  const find = (c: R116Language): V | null => {
    const norm = (v: V) => v.lang.replace("_", "-").toLowerCase();
    const local = [...voices].sort((a, b) => Number(!!b.localService) - Number(!!a.localService));
    for (const tag of SPEECH_TAGS[c]) {
      const t = tag.toLowerCase();
      const hit = local.find((v) => norm(v) === t) ?? (t === c ? local.find((v) => norm(v).split("-")[0] === c) : undefined);
      if (hit) return hit;
    }
    return null;
  };
  const voice = find(code);
  if (voice) return { voice, fallback: null };
  if (code === "ne") { const hi = find("hi"); if (hi) return { voice: hi, fallback: "hi" }; }
  return { voice: null, fallback: null };
}

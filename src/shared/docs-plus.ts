/**
 * R103 Docs plus: shared rules for the link library, the web clipper and spell check (web and server).
 * Pure functions only, so both sides agree and unit tests cover every rule.
 */

/** The 20 spelling languages offered. The browser's own dictionaries do the checking; the codes go on `lang`. */
export const SPELL_LANGUAGES = [
  { code: "en-AU", label: "English (Australia)" }, { code: "en-GB", label: "English (UK)" }, { code: "en-US", label: "English (US)" },
  { code: "ne-NP", label: "Nepali" }, { code: "hi-IN", label: "Hindi" }, { code: "de-DE", label: "German" }, { code: "fr-FR", label: "French" },
  { code: "es-ES", label: "Spanish" }, { code: "it-IT", label: "Italian" }, { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "pt-PT", label: "Portuguese (Portugal)" }, { code: "nl-NL", label: "Dutch" }, { code: "sv-SE", label: "Swedish" },
  { code: "da-DK", label: "Danish" }, { code: "nb-NO", label: "Norwegian" }, { code: "fi-FI", label: "Finnish" }, { code: "pl-PL", label: "Polish" },
  { code: "cs-CZ", label: "Czech" }, { code: "tr-TR", label: "Turkish" }, { code: "id-ID", label: "Indonesian" },
] as const;
export type SpellLang = (typeof SPELL_LANGUAGES)[number]["code"];
export const isSpellLang = (s: unknown): s is SpellLang => typeof s === "string" && SPELL_LANGUAGES.some((l) => l.code === s);

/**
 * Common English typos and their fixes. Our own list (no third party word list), used by "Check spelling" for the
 * English languages; every other language relies on the browser's own dictionary and its right click suggestions.
 */
const TYPOS: Record<string, string> = {
  teh: "the", hte: "the", adn: "and", nad: "and", taht: "that", thier: "their", recieve: "receive", recieved: "received", reciept: "receipt",
  beleive: "believe", belive: "believe", acheive: "achieve", acheived: "achieved", wierd: "weird", freind: "friend", freinds: "friends",
  untill: "until", wich: "which", whcih: "which", becuase: "because", becasue: "because", beacuse: "because", definately: "definitely",
  definatly: "definitely", seperate: "separate", seperately: "separately", occured: "occurred", occurence: "occurrence", occassion: "occasion",
  accomodate: "accommodate", accomodation: "accommodation", adress: "address", agressive: "aggressive", apparantly: "apparently",
  arguement: "argument", basicly: "basically", begining: "beginning", calender: "calendar", catagory: "category", commited: "committed",
  comming: "coming", concious: "conscious", copywrite: "copyright", embarass: "embarrass", enviroment: "environment", existance: "existence",
  familar: "familiar", finaly: "finally", foriegn: "foreign", fourty: "forty", foward: "forward", goverment: "government", gaurd: "guard",
  happend: "happened", harrass: "harass", immediatly: "immediately", independant: "independent", knowlege: "knowledge", liason: "liaison",
  libary: "library", lisence: "licence", maintenence: "maintenance", millenium: "millennium", mispell: "misspell", neccessary: "necessary",
  necesary: "necessary", noticable: "noticeable", ocasion: "occasion", oppurtunity: "opportunity", posession: "possession", prefered: "preferred",
  publically: "publicly", realy: "really", recomend: "recommend", reccomend: "recommend", refered: "referred", relevent: "relevant",
  remeber: "remember", responsability: "responsibility", rythm: "rhythm", sucess: "success", succesful: "successful", successfull: "successful",
  supercede: "supersede", suprise: "surprise", tommorow: "tomorrow", tomorow: "tomorrow", tounge: "tongue", truely: "truly", twelth: "twelfth",
  tyrany: "tyranny", wether: "whether", wheather: "weather", whereever: "wherever", writting: "writing", yeild: "yield", acn: "can", cna: "can",
  jsut: "just", juts: "just", knwo: "know", konw: "know", nwe: "new", eb: "be", fo: "of", ot: "to", tihs: "this", thsi: "this", yuo: "you",
  yoru: "your", waht: "what", whta: "what", woudl: "would", wouldnt: "wouldn't", dont: "don't", doesnt: "doesn't", didnt: "didn't",
  cant: "can't", wont: "won't", isnt: "isn't", arent: "aren't", wasnt: "wasn't", havent: "haven't", shouldnt: "shouldn't", couldnt: "couldn't",
  im: "I'm", ive: "I've", alot: "a lot", buisness: "business", busness: "business", bussiness: "business",
  managment: "management", meetting: "meeting", schedual: "schedule", shedule: "schedule", sincerly: "sincerely", regaurds: "regards",
  reguards: "regards", thnaks: "thanks", thansk: "thanks", attatched: "attached", attatch: "attach", attachement: "attachment",
  aplication: "application", availible: "available", avaliable: "available", benifit: "benefit", buget: "budget", cheif: "chief",
  colum: "column", comittee: "committee", commitee: "committee", completly: "completely", custmer: "customer", costumer: "customer",
  dissapoint: "disappoint", excercise: "exercise", explaination: "explanation", grammer: "grammar", heigth: "height",
  inital: "initial", intresting: "interesting", invoce: "invoice", lenght: "length", mesage: "message",
  messsage: "message", paymnet: "payment", peice: "piece", perfomance: "performance", persue: "pursue", priviledge: "privilege",
  proccess: "process", recieving: "receiving", similiar: "similar", strenght: "strength", tecnical: "technical", threshhold: "threshold",
  transfered: "transferred", usefull: "useful", wensday: "Wednesday", wendsday: "Wednesday", febuary: "February", feburary: "February",
};

const EN = new Set<string>(["en-AU", "en-GB", "en-US"]);
export interface SpellIssue { word: string; index: number; suggestion: string }

/** Keep the case of the typed word: "Teh" gives "The", "TEH" gives "THE". */
export function matchCase(typed: string, fix: string): string {
  if (typed.length > 1 && typed === typed.toUpperCase()) return fix.toUpperCase();
  if (typed[0] && typed[0] === typed[0].toUpperCase() && typed[0] !== typed[0].toLowerCase()) return fix[0].toUpperCase() + fix.slice(1);
  return fix;
}

/**
 * Words in `text` that are known typos for an English language, with the fix. Skips words inside links, emails,
 * code (`...`) and anything in `ignore` (lower case). At most `limit` issues.
 */
export function checkSpelling(text: string, lang: string = "en-AU", ignore: Iterable<string> = [], limit = 200): SpellIssue[] {
  if (!EN.has(lang)) return [];
  const skip = new Set([...ignore].map((s) => s.toLowerCase()));
  const masked = text.replace(/`[^`]*`|\bhttps?:\/\/\S+|\S+@\S+\.\S+/g, (m) => " ".repeat(m.length));
  const out: SpellIssue[] = [];
  const re = /[A-Za-z][A-Za-z']*/g;
  for (let m = re.exec(masked); m && out.length < limit; m = re.exec(masked)) {
    const word = m[0].replace(/'+$/, "");
    const key = word.toLowerCase();
    if (skip.has(key) || !Object.prototype.hasOwnProperty.call(TYPOS, key)) continue;
    // "Im" alone is a typo for "I'm" only when it is a whole word; "IM" (all caps) may be an acronym.
    if (word.length <= 3 && word === word.toUpperCase() && word.length > 1) continue;
    out.push({ word, index: m.index, suggestion: matchCase(word, TYPOS[key]) });
  }
  return out;
}

/** Apply fixes (right to left so indexes stay true). */
export function applyFixes(text: string, issues: SpellIssue[]): string {
  let s = text;
  for (const i of [...issues].sort((a, b) => b.index - a.index)) {
    if (s.slice(i.index, i.index + i.word.length) !== i.word) continue;
    s = s.slice(0, i.index) + i.suggestion + s.slice(i.index + i.word.length);
  }
  return s;
}

// ---------------------------------------------------------------- links

export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 32;

/** Tags: trimmed, lower case, spaces to single hyphen free words, no "#", unique, at most 12 of 32 characters. */
export function normalizeTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,\n]/) : [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const v = t.replace(/^#+/, "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, MAX_TAG_LENGTH).trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|yclid|_hsenc|_hsmi)$/i;

/**
 * The key a saved link is unique on: http(s) only, lower case host, no default port, no fragment, no tracking
 * parameters, no trailing slash on a path. Returns null for anything that is not an http(s) URL.
 */
export function linkKey(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

/** A URL a person typed: adds https:// when no scheme was given. */
export function withScheme(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
}

export const siteOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

// ---------------------------------------------------------------- comments

export type CommentThread = "team" | "public";
export type CommentStatus = "visible" | "pending" | "hidden";
export const COMMENT_MAX = 4000;
export const PUBLIC_NAME_MAX = 80;

/** "@Name" mentions in a comment body, matched against the people offered (longest names first). */
export function mentionedIds(body: string, people: { id: string; name: string }[]): string[] {
  const ids: string[] = [];
  const lower = body.toLowerCase();
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const n = p.name.trim().toLowerCase();
    if (!n) continue;
    const at = lower.indexOf(`@${n}`);
    if (at < 0) continue;
    const after = lower[at + n.length + 1];
    if (after && /[a-z0-9]/.test(after)) continue;
    if (!ids.includes(p.id)) ids.push(p.id);
  }
  return ids;
}

/**
 * Review Z3: one check for regular expressions people type (doc inbox rules, form answer patterns) before the server
 * or a browser runs them. JavaScript's engine backtracks, so a pattern can take seconds to minutes on a short text
 * when its repeats can split the same characters many ways. Refused:
 * - back references (\1, \k<name>) and lookarounds ((?=, (?!, (?<=, (?<!);
 * - a repeated group that has a repeat or a choice inside it ("(a+)+", "(a|ab)*");
 * - two repeats that can take the same characters with only optional parts between them ("\w*\w*", "\d+\w*");
 * - more than 200 characters, and anything that does not compile.
 * Repeats are `*`, `+`, `{n,}` and `{n,m}`; `?`, and an exact `{n}` on one character, are fine. The check is conservative: a
 * pattern it refuses may be harmless, never the other way round for these shapes.
 */

export const REGEX_MAX_LENGTH = 200;

/** One element of a sequence: a single character matcher, or a group, with its repeat. */
interface Atom {
  /** A pattern that matches exactly one character of this atom, for overlap probes (null for a group). */
  one: string | null;
  group: Seq[] | null;
  min: number;
  max: number;
}
type Seq = Atom[];

const PROBES = (() => {
  const out: string[] = [];
  for (let c = 0; c < 128; c++) out.push(String.fromCharCode(c));
  out.push("é", "ß", "Ж", "中", " ", " ", "٣", "😀");
  return out;
})();

class Bad extends Error {}

/** Parses the pattern far enough to see its sequences, groups and repeats. Throws Bad for refused syntax. */
function parse(p: string): Seq[] {
  let i = 0;
  const alternatives = (): Seq[] => {
    const alts: Seq[] = [[]];
    while (i < p.length && p[i] !== ")") {
      if (p[i] === "|") { i++; alts.push([]); continue; }
      const atom = parseAtom();
      if (atom) alts[alts.length - 1].push(quantify(atom));
    }
    return alts;
  };
  const parseAtom = (): Atom | null => {
    const c = p[i];
    if (c === "(") {
      i++;
      if (p[i] === "?") {
        const head = p.slice(i, i + 3);
        if (head.startsWith("?=") || head.startsWith("?!") || head === "?<=" || head === "?<!") throw new Bad("lookaround");
        if (p[i + 1] === ":") i += 2;
        else if (p[i + 1] === "<") { const end = p.indexOf(">", i); if (end < 0) throw new Bad("group"); i = end + 1; }
        else throw new Bad("group");
      }
      const group = alternatives();
      if (p[i] !== ")") throw new Bad("unclosed");
      i++;
      return { one: null, group, min: 1, max: 1 };
    }
    if (c === "[") {
      let j = i + 1;
      if (p[j] === "^") j++;
      if (p[j] === "]") j++;
      for (; j < p.length && p[j] !== "]"; j++) if (p[j] === "\\") j++;
      if (j >= p.length) throw new Bad("class");
      const one = p.slice(i, j + 1);
      i = j + 1;
      return { one, group: null, min: 1, max: 1 };
    }
    if (c === "\\") {
      const n = p[i + 1] ?? "";
      if (/[1-9]/.test(n) || n === "k") throw new Bad("backref");
      if (n === "b" || n === "B") { i += 2; return null; }
      let len = 2;
      if (n === "u" && p[i + 2] === "{") len = p.indexOf("}", i) - i + 1;
      else if (n === "u") len = 6;
      else if (n === "x") len = 4;
      else if (n === "p" || n === "P") len = p.indexOf("}", i) - i + 1;
      else if (n === "c") len = 3;
      if (len <= 0) throw new Bad("escape");
      const one = p.slice(i, i + len);
      i += len;
      return { one, group: null, min: 1, max: 1 };
    }
    if (c === "^" || c === "$") { i++; return null; }
    if (c === "*" || c === "+" || c === "?" || c === "{") throw new Bad("repeat");
    i++;
    return { one: c === "." ? "." : c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), group: null, min: 1, max: 1 };
  };
  const quantify = (a: Atom): Atom => {
    const c = p[i];
    let min: number, max: number;
    if (c === "*") { min = 0; max = Infinity; i++; }
    else if (c === "+") { min = 1; max = Infinity; i++; }
    else if (c === "?") { min = 0; max = 1; i++; }
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
      if (!m) return a; // a literal brace (the compile step decides)
      min = Number(m[1]); max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      i += m[0].length;
    } else return a;
    if (p[i] === "?") i++; // lazy: the same work in the worst case
    if (p[i] === "*" || p[i] === "+" || p[i] === "{") throw new Bad("repeat");
    return { ...a, min, max };
  };
  const top = alternatives();
  if (i < p.length) throw new Bad("unbalanced");
  return top;
}

// A group repeated even an exact number of times multiplies its choices ("(a|a){30}"); a single character repeated an
// exact number of times ("\d{4}") is a fixed length and splits nothing.
const repeats = (a: Atom) => (a.group ? a.max > 1 : a.max > a.min);
/** Single character patterns an atom can start with or be made of (every one inside a group). */
function chars(a: Atom): string[] {
  if (a.one) return [a.one];
  return (a.group ?? []).flatMap((s) => s.flatMap(chars));
}
function hasRepeat(seqs: Seq[]): boolean {
  return seqs.some((s) => s.some((a) => repeats(a) || (a.group ? hasRepeat(a.group) : false)));
}
function overlap(x: string[], y: string[], flags: string): boolean {
  const rx = x.map((s) => new RegExp(`^(?:${s})$`, flags)); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp (one character class or escape, no repeat: linear)
  const ry = y.map((s) => new RegExp(`^(?:${s})$`, flags)); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp (one character class or escape, no repeat: linear)
  return PROBES.some((ch) => rx.some((r) => r.test(ch)) && ry.some((r) => r.test(ch)));
}

function checkSeq(seq: Seq, flags: string) {
  for (const a of seq) {
    if (!a.group) continue;
    if (repeats(a) && (a.group.length > 1 || hasRepeat(a.group))) throw new Bad("nested");
    for (const s of a.group) checkSeq(s, flags);
  }
  // Two repeating parts (a repeat, or a group holding one) that can take the same characters, with only optional
  // parts between them.
  for (let x = 0; x < seq.length; x++) {
    const ax = seq[x];
    if (!(repeats(ax) || (ax.group && hasRepeat(ax.group)))) continue;
    for (let y = x + 1; y < seq.length; y++) {
      const ay = seq[y];
      if ((repeats(ay) || (ay.group && hasRepeat(ay.group))) && overlap(chars(ax), chars(ay), flags)) throw new Bad("overlap");
      if (ay.min > 0) break;
    }
  }
}

/** Why a pattern is refused, or null when it is safe to run. `flags` are the ones it will run with. */
export function regexProblem(pattern: string, flags = "u"): string | null {
  if (!pattern) return "Add a pattern.";
  if (pattern.length > REGEX_MAX_LENGTH) return `Keep it under ${REGEX_MAX_LENGTH} characters.`;
  try { new RegExp(pattern, flags); } catch { return "This pattern is not valid."; } // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp (compiled only, never run)
  try {
    for (const s of parse(pattern)) checkSeq(s, flags);
  } catch (e) {
    if (!(e instanceof Bad)) return "This pattern is not valid.";
    if (e.message === "backref") return "Patterns cannot refer back to an earlier group.";
    if (e.message === "lookaround") return "Patterns cannot look ahead or behind.";
    if (e.message === "nested") return "This pattern repeats a group that repeats or has choices. Simplify it.";
    if (e.message === "overlap") return "Two repeats in this pattern can match the same characters. Simplify it.";
    return "This pattern is not valid.";
  }
  return null;
}

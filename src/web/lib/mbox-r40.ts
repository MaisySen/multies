/**
 * R40: reads an .mbox file in the browser (Gmail Takeout, Apple Mail and most mail apps export one) so the server only
 * stores messages. Works on bytes, so every message keeps its exact raw form whatever its charset.
 *
 * A message starts at a "From " line at the top of the file or after a blank line (the From_ separator); that line
 * is dropped. Lines quoted as ">From " (or ">>From ", the mboxrd form) lose one ">". LF and CRLF files both work.
 */

const F = 0x46, R = 0x72, O = 0x6f, M = 0x6d, SP = 0x20, LF = 0x0a, CR = 0x0d, GT = 0x3e;

const isFromAt = (b: Uint8Array, i: number) => b[i] === F && b[i + 1] === R && b[i + 2] === O && b[i + 3] === M && b[i + 4] === SP;

/** Offsets of every From_ separator line. */
export function mboxStarts(b: Uint8Array): number[] {
  const out: number[] = [];
  if (isFromAt(b, 0)) out.push(0);
  for (let i = 1; i < b.length - 5; i++) {
    if (b[i - 1] !== LF || !isFromAt(b, i)) continue;
    // The line before must be blank: "\n\n" or "\r\n\r\n" (or the "\n" right at the start).
    const prevBlank = i === 1 || b[i - 2] === LF || (b[i - 2] === CR && (i === 2 || b[i - 3] === LF));
    if (prevBlank) out.push(i);
  }
  return out;
}

/** Drops one ">" from lines that read ">From " or ">>From " and so on. */
export function unquoteFrom(b: Uint8Array): Uint8Array {
  const keep: number[] = [];
  let changed = false;
  for (let i = 0; i < b.length; i++) {
    if ((i === 0 || b[i - 1] === LF) && b[i] === GT) {
      let j = i;
      while (b[j] === GT) j++;
      if (isFromAt(b, j)) { changed = true; continue; }
    }
    keep.push(i);
  }
  if (!changed) return b;
  const out = new Uint8Array(keep.length);
  for (let k = 0; k < keep.length; k++) out[k] = b[keep[k]];
  return out;
}

/** Splits an mbox into raw messages. A file with no From_ line is read as one message when it looks like mail. */
export function splitMbox(b: Uint8Array): Uint8Array[] {
  if (!b.length) return [];
  const starts = mboxStarts(b);
  if (!starts.length) return looksLikeMail(b) ? [b] : [];
  const out: Uint8Array[] = [];
  for (let s = 0; s < starts.length; s++) {
    let from = starts[s];
    while (from < b.length && b[from] !== LF) from++;
    from++;
    const hasNext = s + 1 < starts.length;
    let to = hasNext ? starts[s + 1] : b.length;
    // The blank line before the next separator belongs to the mbox, not the message.
    if (hasNext && to > from && b[to - 1] === LF) to--;
    if (hasNext && to > from && b[to - 1] === CR) to--;
    if (to <= from) continue;
    const msg = unquoteFrom(b.subarray(from, to));
    if (msg.length) out.push(msg);
  }
  return out;
}

/** A single .eml saved as .mbox: its first line is a mail header. */
function looksLikeMail(b: Uint8Array) {
  const first = new TextDecoder().decode(b.subarray(0, 200)).split(/\r?\n/)[0] ?? "";
  return /^(Received|Return-Path|From|Subject|Message-ID|Date|To|MIME-Version|Delivered-To):/i.test(first);
}

/** Raw bytes as base64, in slices so a large message does not overflow the call stack. */
export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Groups messages into batches of at most `max` messages and about `maxBytes` of mail (a single big message gets its own batch). */
export function mboxBatches(msgs: Uint8Array[], max = 3, maxBytes = 192 * 1024): Uint8Array[][] {
  const out: Uint8Array[][] = [];
  let cur: Uint8Array[] = [];
  let bytes = 0;
  for (const m of msgs) {
    if (cur.length && (cur.length >= max || bytes + m.length > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(m); bytes += m.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export const MBOX_MAX_FILE_MB = 200;

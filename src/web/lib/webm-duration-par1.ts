/**
 * PAR1 (HQ MB-352): a browser's recorder writes a webm with no length in its header, so some players show no duration.
 * After Stop we write the length into the header in place, without moving any other byte: the Segment Info's MuxingApp
 * (or WritingApp) element is replaced by a Duration element of the same total size plus an EBML Void filler. Same size
 * means a file already written to disk is fixed with one small positional write; nothing is re-encoded or re-read.
 * No dependency. Answers null when the head is not a webm we understand (the file is then left exactly as it was).
 */
const EBML = 0x1a45dfa3, SEGMENT = 0x18538067, INFO = 0x1549a966, DURATION = 0x4489, MUXING_APP = 0x4d80, WRITING_APP = 0x5741, VOID = 0xec;
const CLUSTER = 0x1f43b675, TRACKS = 0x1654ae6b;

interface El { id: number; start: number; dataStart: number; size: number | null; end: number }

/** Reads one element header at pos: ID (1 to 4 bytes) and size (1 to 8 bytes; all ones = unknown). */
function readEl(b: Uint8Array, pos: number): El | null {
  if (pos >= b.length) return null;
  const first = b[pos]!;
  let idLen = 1; while (idLen <= 4 && !(first & (0x80 >> (idLen - 1)))) idLen++;
  if (idLen > 4 || pos + idLen > b.length) return null;
  let id = 0; for (let i = 0; i < idLen; i++) id = id * 256 + b[pos + i]!;
  const sp = pos + idLen; if (sp >= b.length) return null;
  const s0 = b[sp]!;
  let sLen = 1; while (sLen <= 8 && !(s0 & (0x80 >> (sLen - 1)))) sLen++;
  if (sLen > 8 || sp + sLen > b.length) return null;
  let size = s0 & (0xff >> sLen), allOnes = size === (0xff >> sLen);
  for (let i = 1; i < sLen; i++) { const v = b[sp + i]!; size = size * 256 + v; if (v !== 0xff) allOnes = false; }
  const dataStart = sp + sLen;
  return { id, start: pos, dataStart, size: allOnes ? null : size, end: allOnes ? Infinity : dataStart + size };
}

function voidEl(total: number): number[] | null {
  if (total === 0) return [];
  if (total < 2 || total - 2 > 126) return null;
  return [VOID, 0x80 | (total - 2), ...new Array<number>(total - 2).fill(0)];
}

function durationEl(ms: number, total: number): number[] | null {
  for (const width of [8, 4] as const) {
    const fill = voidEl(total - (3 + width));
    if (!fill) continue;
    const v = new DataView(new ArrayBuffer(width));
    if (width === 8) v.setFloat64(0, ms); else v.setFloat32(0, ms);
    return [0x44, 0x89, 0x80 | width, ...new Uint8Array(v.buffer), ...fill];
  }
  return null;
}

/** Where to write and what, so the head carries `ms` as its duration (TimecodeScale 1 ms, the recorder's default). */
export function webmDurationPatch(head: Uint8Array, ms: number): { offset: number; bytes: Uint8Array } | null {
  if (!(ms > 0) || !Number.isFinite(ms)) return null;
  const ebml = readEl(head, 0);
  if (!ebml || ebml.id !== EBML || ebml.size === null) return null;
  const seg = readEl(head, ebml.end);
  if (!seg || seg.id !== SEGMENT) return null;
  let pos = seg.dataStart;
  while (pos < head.length) {
    const el = readEl(head, pos);
    if (!el || el.id === CLUSTER || el.id === TRACKS && el.size === null) return null;
    if (el.id === INFO) {
      if (el.size === null || el.end > head.length) return null;
      let c = el.dataStart, spare: El | null = null;
      while (c < el.end) {
        const ch = readEl(head, c);
        if (!ch || ch.size === null) return null;
        if (ch.id === DURATION && (ch.size === 4 || ch.size === 8)) {
          const v = new DataView(new ArrayBuffer(ch.size));
          if (ch.size === 8) v.setFloat64(0, ms); else v.setFloat32(0, ms);
          return { offset: ch.dataStart, bytes: new Uint8Array(v.buffer) };
        }
        if ((ch.id === MUXING_APP || ch.id === WRITING_APP) && (!spare || spare.id !== MUXING_APP)) spare = ch;
        c = ch.end;
      }
      if (!spare) return null;
      const bytes = durationEl(ms, spare.end - spare.start);
      return bytes ? { offset: spare.start, bytes: new Uint8Array(bytes) } : null;
    }
    if (el.size === null) return null;
    pos = el.end;
  }
  return null;
}

/** The whole recording as a Blob with the duration written in (or the same Blob when it can't be). */
export async function withWebmDuration(blob: Blob, ms: number): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const p = webmDurationPatch(head, ms);
  if (!p) return blob;
  return new Blob([blob.slice(0, p.offset), new Uint8Array(p.bytes), blob.slice(p.offset + p.bytes.length)], { type: blob.type });
}

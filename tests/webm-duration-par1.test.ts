import { describe, expect, it } from "vitest";
import { webmDurationPatch, withWebmDuration } from "@/web/lib/webm-duration-par1";
import { FileSink, MemorySink } from "@/web/lib/video-rec-vid1";

/** PAR1 (MB-352): the recorded length goes into the webm header in place, same size, nothing else moves. */
const vint = (n: number) => [0x80 | n];
const el = (id: number[], data: number[]) => [...id, ...vint(data.length), ...data];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** A head shaped like the browser recorder's: EBML, Segment of unknown size, Info with no Duration, then Tracks. */
function chromeHead(withDuration = false) {
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], [...el([0x42, 0x82], ascii("webm")), ...el([0x42, 0x87], [4]), ...el([0x42, 0x85], [2])]);
  const info = el([0x15, 0x49, 0xa9, 0x66], [
    ...el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]),
    ...(withDuration ? el([0x44, 0x89], [0, 0, 0, 0, 0, 0, 0, 0]) : []),
    ...el([0x4d, 0x80], ascii("Chrome")), ...el([0x57, 0x41], ascii("Chrome")),
  ]);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], [0xae, 0x80]);
  return new Uint8Array([...ebml, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...info, ...tracks, 0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 2, 3]);
}
function applied(head: Uint8Array, ms: number) {
  const p = webmDurationPatch(head, ms)!;
  const out = head.slice(); out.set(p.bytes, p.offset); return { out, p };
}
function readDuration(b: Uint8Array) {
  for (let i = 0; i < b.length - 3; i++) if (b[i] === 0x44 && b[i + 1] === 0x89) {
    const w = b[i + 2]! & 0x7f; const v = new DataView(b.buffer, b.byteOffset + i + 3, w);
    return w === 8 ? v.getFloat64(0) : v.getFloat32(0);
  }
  return null;
}

describe("PAR1 webm duration (MB-352)", () => {
  it("replaces MuxingApp with a Duration of the same size and keeps every other byte", () => {
    const head = chromeHead();
    const { out, p } = applied(head, 83_500);
    expect(out.length).toBe(head.length);
    expect(readDuration(out)).toBeCloseTo(83_500, 0);
    expect(Array.from(out.slice(0, p.offset))).toEqual(Array.from(head.slice(0, p.offset)));
    expect(Array.from(out.slice(p.offset + p.bytes.length))).toEqual(Array.from(head.slice(p.offset + p.bytes.length)));
    expect(Array.from(out.slice(p.offset + 7, p.offset + 9))).toEqual([0xec, 0x80]); // the Void filler
    // A second pass finds the Duration it wrote and only changes its value.
    const again = webmDurationPatch(out, 90_000)!;
    expect(again.bytes.length).toBe(4);
  });

  it("overwrites an existing Duration in place", () => {
    const head = chromeHead(true);
    const { out, p } = applied(head, 1234.5);
    expect(p.bytes.length).toBe(8);
    expect(readDuration(out)).toBe(1234.5);
  });

  it("leaves anything that is not a webm head alone", () => {
    expect(webmDurationPatch(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), 1000)).toBeNull(); // mp4
    expect(webmDurationPatch(chromeHead(), 0)).toBeNull();
    expect(webmDurationPatch(chromeHead().slice(0, 30), 1000)).toBeNull(); // cut short
  });

  it("the memory sink answers a whole video with the duration in it", async () => {
    const s = new MemorySink("video/webm");
    const head = chromeHead();
    await s.write(new Blob([head.slice(0, 40)])); await s.write(new Blob([head.slice(40)]));
    const blob = (await s.close(5000))!;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length).toBe(head.length);
    expect(readDuration(bytes)).toBeCloseTo(5000, 0);
    expect(await withWebmDuration(new Blob([new Uint8Array([1, 2, 3])]), 1000).then((b) => b.size)).toBe(3);
  });

  it("the file sink writes the length at its place before closing, only on a real file stream", async () => {
    const head = chromeHead();
    const writes: unknown[] = []; let closed = false;
    const real = { write: async (b: unknown) => { writes.push(b); }, close: async () => { closed = true; }, seek: async () => undefined };
    const s = new FileSink(real);
    await s.write(new Blob([head]));
    await s.close(7000);
    expect(closed).toBe(true);
    const last = writes[writes.length - 1] as { type: string; position: number; data: Uint8Array };
    expect(last.type).toBe("write");
    const out = head.slice(); out.set(last.data, last.position);
    expect(readDuration(out)).toBeCloseTo(7000, 0);
    // A stream without seek (an old browser or a test double) gets only the video chunks, as before.
    const plain: unknown[] = [];
    const s2 = new FileSink({ write: async (b) => { plain.push(b); }, close: async () => undefined });
    await s2.write(new Blob([head])); await s2.close(7000);
    expect(plain.length).toBe(1);
  });
});

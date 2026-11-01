/**
 * R92: a QR code as a PNG for mail clients (they do not show SVG). uqr makes the matrix; the PNG is written here with
 * the platform's zlib stream, so no extra package. Black on white, 8 pixels per module.
 */
import { encode } from "uqr";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function zlib(raw: Uint8Array) {
  const cs = new CompressionStream("deflate");
  const w = cs.writable.getWriter();
  void w.write(raw as Uint8Array<ArrayBuffer>);
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

export async function qrPng(value: string, scale = 8): Promise<Uint8Array> {
  const qr = encode(value, { ecc: "M", border: 2 });
  const size = qr.size * scale;
  const rowBytes = 1 + Math.ceil(size / 8);
  const raw = new Uint8Array(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const row = qr.data[Math.floor(y / scale)];
    for (let x = 0; x < size; x++) {
      // 1 bit grey: 0 is black. Set the bit for white modules.
      if (!row[Math.floor(x / scale)]) raw[y * rowBytes + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size); v.setUint32(4, size);
  ihdr[8] = 1; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", await zlib(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

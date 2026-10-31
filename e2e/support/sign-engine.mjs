#!/usr/bin/env node
/**
 * R107: a stand in document engine for the e-sign local e2e and screenshots only (localhost). It answers the
 * job API shape for thumbnails, to-jpeg and sign at once. The signed copy carries the job id, so each finished
 * copy has its own fingerprint, and the result names that fingerprint as the real engine does. It does NOT
 * check signatures and never runs anywhere but localhost. Usage: node e2e/support/sign-engine.mjs <port>
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { zipSync, strToU8 } from "fflate";

const PORT = Number(process.argv[2] ?? 8874);
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
/** A white page with grey text lines, like a contract. */
function page(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h, 255);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    const line = y > 60 && y < h - 120 && y % 22 < 3;
    if (!line) continue;
    for (let x = 50; x < w - 50 - ((y * 7) % 120); x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = raw[o + 1] = raw[o + 2] = 200; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const P1 = page(600, 849);
const P2 = page(600, 849);
const THUMBS = Buffer.from(zipSync({ "page-001.png": P1, "page-002.png": P2, "pages.json": strToU8(JSON.stringify([{ page: 1, width: 595.28, height: 841.89 }, { page: 2, width: 595.28, height: 841.89 }])) }));
const jobs = new Map();
const json = (res, code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = [];
  for await (const c of req) parts.push(c);
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (req.method === "POST" && url.pathname === "/internal/v1/jobs") {
    const op = url.searchParams.get("op");
    const id = Math.random().toString(16).slice(2).padEnd(16, "0").slice(0, 16) + "e5e5";
    let out; let result;
    if (op === "thumbnails") { out = THUMBS; result = { pages: 2 }; }
    else if (op === "to-jpeg") { out = THUMBS; result = { pages: 2 }; }
    else { out = Buffer.from(`%PDF-1.4\n% signed copy ${id}\n1 0 obj << /Type /Page /MediaBox [0 0 595.28 841.89] >> endobj\n%%EOF\n`); result = { pages: 3, sha256: "" }; result.sha256 = createHash("sha256").update(out).digest("hex"); }
    jobs.set(id, { out, result, op });
    return json(res, 202, { id, status: "queued" });
  }
  const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
  const job = m && jobs.get(m[1]);
  if (!job) return json(res, 404, { error: "not_found" });
  if (m[2]) { res.writeHead(200, { "content-type": job.op === "sign" ? "application/pdf" : "application/zip" }); return res.end(job.out); }
  return json(res, 200, { id: m[1], status: "done", output: { bytes: job.out.length }, result: job.result });
}).listen(PORT, "127.0.0.1", () => console.log(`sign engine on ${PORT}`));

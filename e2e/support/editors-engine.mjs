#!/usr/bin/env node
/**
 * Tools P2, H7: a stand in document engine for the editors' local e2e and screenshots only. It speaks the
 * job API shape (POST /internal/v1/jobs?op=, GET /internal/v1/jobs/<id>, GET .../output) for thumbnails,
 * organize, form-fields, form-fill and compare. It does NOT check signatures and never runs anywhere but
 * localhost. Usage: node e2e/support/editors-engine.mjs <port>
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { zipSync } from "fflate";

const PORT = Number(process.argv[2] ?? 8833);
const PDF = readFileSync(new URL("../fixtures/tools/sample-a.pdf", import.meta.url));
const PAGES = 6;

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A small portrait page: a coloured title band, grey text lines, a picture box, and the page number as dots. */
function pagePng(n) {
  const w = 140, h = 198;
  const hues = [[0, 113, 227], [88, 86, 214], [255, 149, 0], [52, 199, 89], [255, 59, 48], [175, 82, 222]];
  const [r0, g0, b0] = hues[(n - 1) % hues.length];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      let c = [255, 255, 255];
      if (y >= 14 && y < 26 && x >= 12 && x < 90) c = [r0, g0, b0];
      else if (y >= 36 && y < 160 && (y - 36) % 10 < 4 && x >= 12 && x < (y % 30 === 6 ? 90 : 128)) c = [214, 216, 222];
      else if (y >= 92 && y < 132 && x >= 76 && x < 128) c = [Math.round(r0 * 0.3 + 178), Math.round(g0 * 0.3 + 178), Math.round(b0 * 0.3 + 178)];
      for (let d = 0; d < n; d++) if (y >= 176 && y < 184 && x >= 12 + d * 12 && x < 20 + d * 12) c = [r0, g0, b0];
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const THUMBS = Buffer.from(zipSync(Object.fromEntries(Array.from({ length: PAGES }, (_, i) => [`page-${String(i + 1).padStart(3, "0")}.png`, pagePng(i + 1)])), { level: 0 }));

const FIELDS = { fields: [
  { name: "Applicant.Full_name[0]", type: "text", value: "", options: [], page: 1, rect: [0, 0, 1, 1], required: true },
  { name: "Applicant.Email[0]", type: "text", value: "", options: [], page: 1, rect: [0, 0, 1, 1], required: true },
  { name: "Applicant.Phone[0]", type: "text", value: "", options: [], page: 1, rect: [0, 0, 1, 1], required: false },
  { name: "State", type: "choice", value: "", options: ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"], page: 1, rect: [0, 0, 1, 1], required: true },
  { name: "Membership", type: "radio", value: "", options: ["Monthly", "Yearly"], page: 2, rect: [0, 0, 1, 1], required: false },
  { name: "agreeTerms", type: "checkbox", value: "Off", options: [], page: 2, rect: [0, 0, 1, 1], required: true },
  { name: "Signature1", type: "signature", value: null, options: [], page: 2, rect: [0, 0, 1, 1], required: false },
] };
const CHANGES = { pages: [
  { page: 1, added: ["Payment is due within 14 days of the invoice date."], removed: ["Payment is due within 30 days of the invoice date."] },
  { page: 3, added: ["The term renews for 12 months unless either party gives 60 days notice."], removed: ["The term ends on 30 June 2027."] },
  { page: 4, added: [], removed: ["Clause 9.2 Exclusivity"] },
] };

const jobs = new Map();
const readBody = (req) => new Promise((res) => { const parts = []; req.on("data", (d) => parts.push(d)); req.on("end", () => res(Buffer.concat(parts))); });
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (req.method === "POST" && url.pathname === "/internal/v1/jobs") {
    const body = await readBody(req);
    const text = body.toString("latin1");
    const op = url.searchParams.get("op");
    const output = /name="output"\r\n\r\n(json|pdf)/.exec(text)?.[1] ?? "pdf";
    const noFields = /filename="[^"]*no-?fields[^"]*"/i.test(text);
    const id = Math.random().toString(16).slice(2).padEnd(16, "0").slice(0, 16) + "e7e7";
    let out, ctype, result;
    if (op === "thumbnails") { out = THUMBS; ctype = "application/zip"; result = { pages: PAGES }; }
    else if (op === "form-fields") { out = Buffer.from(JSON.stringify(noFields ? { fields: [] } : FIELDS)); ctype = "application/json"; result = { fields: noFields ? 0 : FIELDS.fields.length }; }
    else if (op === "compare" && output === "json") { out = Buffer.from(JSON.stringify(CHANGES)); ctype = "application/json"; result = { pages_changed: 3, words_added: 23, words_removed: 18 }; }
    else if (op === "compare") { out = PDF; ctype = "application/pdf"; result = { pages_changed: 3, words_added: 23, words_removed: 18 }; }
    else if (op === "organize") { const plan = /name="plan"\r\n\r\n([^\r]*)/.exec(text)?.[1]; out = PDF; ctype = "application/pdf"; result = { pages: plan ? JSON.parse(plan).length : PAGES }; }
    else if (op === "form-fill") { const v = /name="values"\r\n\r\n([^\r]*)/.exec(text)?.[1]; out = PDF; ctype = "application/pdf"; result = { fields_filled: v ? Object.keys(JSON.parse(v)).length : 0 }; }
    else return json(res, 400, { error: "bad_op", message: "Unknown op." });
    jobs.set(id, { id, op, out, ctype, result, at: Date.now() });
    return json(res, 202, { id, op, status: "queued" });
  }
  const m = /^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/.exec(url.pathname);
  const job = m && jobs.get(m[1]);
  if (!job) return json(res, 404, { error: "not_found" });
  if (m[2]) { res.writeHead(200, { "content-type": job.ctype, "content-length": job.out.length }); return res.end(job.out); }
  const done = Date.now() - job.at > 600;
  return json(res, 200, { id: job.id, op: job.op, status: done ? "done" : "running", output: done ? { bytes: job.out.length } : undefined, result: done ? job.result : undefined });
}).listen(PORT, "127.0.0.1", () => console.log(`editors engine on ${PORT}`));

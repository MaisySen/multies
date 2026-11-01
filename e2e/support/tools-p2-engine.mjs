#!/usr/bin/env node
/**
 * Tools P2, H2: a stand in document engine for the Tools page e2e and screenshots only (local). It speaks the job API
 * shape (POST /internal/v1/jobs?op=, GET /internal/v1/jobs/<id>, GET .../output, GET /internal/v1/operations) and
 * answers each op with a small file of the right type. It does NOT check signatures. Usage: node e2e/support/tools-p2-engine.mjs <port>
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";

const PORT = Number(process.argv[2] ?? 8823);
const PDF = readFileSync(new URL("../fixtures/tools/sample-a.pdf", import.meta.url));
const MATCHES = { matches: [
  { kind: "tfn", text: "123 456 782", page: 1, rect: [72, 120, 160, 132] },
  { kind: "abn", text: "51 824 753 556", page: 1, rect: [72, 140, 180, 152] },
  { kind: "bsb_account", text: "062-000 12345678", page: 2, rect: [72, 300, 200, 312] },
  { kind: "card", text: "4111 1111 1111 1111", page: 2, rect: [72, 320, 220, 332] },
  { kind: "phone", text: "0412 345 678", page: 1, rect: [72, 200, 150, 212] },
  { kind: "phone", text: "+61 2 9374 4000", page: 3, rect: [72, 220, 170, 232] },
  { kind: "email", text: "jane.citizen@example.com", page: 1, rect: [72, 240, 230, 252] },
  { kind: "medicare", text: "2123 45670 1", page: 3, rect: [72, 260, 170, 272] },
] };
const XLSX = Buffer.from(zipSync({ "[Content_Types].xml": Buffer.from("<Types/>"), "xl/workbook.xml": Buffer.from("<workbook/>") }, { level: 0 }));
const TYPES = { pdf: "application/pdf", json: "application/json", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", txt: "text/plain", md: "text/markdown", zip: "application/zip",
  // R86: video, audio and photo results.
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", gif: "image/gif", jpg: "image/jpeg", png: "image/png",
  // R100b
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", odp: "application/vnd.oasis.opendocument.presentation", odg: "application/vnd.oasis.opendocument.graphics", svg: "image/svg+xml" };
const CLIP = readFileSync(new URL("../fixtures/convert/clip.mp4", import.meta.url));
const JPG = readFileSync(new URL("../fixtures/convert/photo-b.jpg", import.meta.url));
const PNG = readFileSync(new URL("../fixtures/convert/photo-a.png", import.meta.url));
const AUDIO = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac", "opus", "oga"]);

function output(op, fields, name = "") {
  // R86: media and photos come back as the type asked for; compress halves a PDF or video.
  if (op === "media-convert") { const t = fields.to || "mp4"; return [t, t === "gif" ? PNG : CLIP.subarray(0, Math.max(1000, CLIP.length >> 1))]; }
  if (op === "media-compress") return [AUDIO.has(name.split(".").pop().toLowerCase()) ? "m4a" : "mp4", CLIP.subarray(0, CLIP.length >> 1)];
  // R100b: slides and drawings come back as the type asked for; the image op returns a small PNG.
  if (op === "slides-convert") { const t = fields.to || "pdf"; return [t, t === "pdf" ? PDF : t === "svg" ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') : XLSX]; }
  if (op === "image-transform") return [fields.format === "jpeg" ? "jpg" : "png", fields.format === "jpeg" ? JPG : PNG];
  if (op === "photo-convert") return [fields.to === "png" ? "png" : "jpg", fields.to === "png" ? PNG : JPG];
  if (op === "pii-find") return ["json", Buffer.from(JSON.stringify(MATCHES))];
  if (op === "pdf-tables" || op === "excel-merge" || op === "excel-clean") return ["xlsx", XLSX];
  if (op === "pdf-to") {
    const t = fields.target || "txt";
    if (t === "xlsx") return ["xlsx", XLSX];
    if (t === "png") return ["zip", Buffer.from(zipSync({ "page-001.png": Buffer.from("png") }, { level: 0 }))];
    return [t, Buffer.from(t === "csv" ? "Date,Amount\n2026-10-01,120.00\n" : "Statement for October\n")];
  }
  return ["pdf", PDF];
}
function facts(op, job) {
  switch (op) {
    case "compress": case "media-compress": return { in_bytes: job.inBytes, out_bytes: Math.round(job.inBytes / 2), level: "medium" };
    case "media-convert": return { seconds: 3, copied: false };
    case "ebook-to-pdf": return { chapters: 4, pages: 9 };
    case "pii-find": return { matches: MATCHES.matches.length };
    case "redact": return { matches: 5, phrases: 5, verified: true };
    case "pdf-tables": return { tables: 3 };
    case "excel-merge": return { rows: 240, sheets: 2 };
    case "excel-clean": return { rows: 118, rows_removed: 7 };
    case "stamp": return { pages_changed: 6 };
    case "scan-clean": return { pages: 3, pages_with_text: 3 };
    default: return { pages: 6 };
  }
}

const jobs = new Map();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (status, body, type = "application/json") => { res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) }); res.end(body); };
  if (url.pathname === "/healthz") return send(200, JSON.stringify({ ok: true }));
  if (req.method === "POST" && url.pathname === "/internal/v1/jobs") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const fd = await new Request("http://x", { method: "POST", body, headers: { "content-type": req.headers["content-type"] } }).formData();
    const fields = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string") fields[k] = v;
    const op = url.searchParams.get("op");
    const id = Math.random().toString(16).slice(2).padEnd(16, "c") + "beef";
    const upload = [...fd.values()].find((v) => typeof v !== "string");
    const [ext, bytes] = output(op, fields, upload?.name ?? "");
    jobs.set(id, { id, ws: req.headers["x-multies-ws"], op, ext, bytes, at: Date.now(), inBytes: upload?.size ?? 0 });
    return send(202, JSON.stringify({ id, status: "queued" }));
  }
  const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
  const job = m && jobs.get(m[1]);
  if (!job || job.ws !== req.headers["x-multies-ws"]) return send(404, JSON.stringify({ error: "not_found" }));
  if (m[2]) return send(200, job.bytes, TYPES[job.ext]);
  const done = Date.now() - job.at > 1200;
  // R86: long jobs say how far they are (seconds of video done of total).
  const progress = done ? undefined : { done: Math.min(9, Math.round((Date.now() - job.at) / 130)), total: 10 };
  return send(200, JSON.stringify({ id: job.id, status: done ? "done" : "running", progress, result: done ? facts(job.op, job) : undefined, output: done ? { name: `out.${job.ext}`, bytes: job.bytes.length, content_type: TYPES[job.ext] } : undefined }));
});
server.listen(PORT, "127.0.0.1", () => console.log(`tools p2 engine on ${PORT}`));

#!/usr/bin/env node
/**
 * Tools P2, H6: a stand in document engine for the automation screenshots only (localhost). It takes any
 * job, answers done at once, and returns a small PDF (compress returns about a fifth of the upload; a
 * render-batch returns a zip of PDFs named by each row's _file). It does not check signatures.
 * Usage: node e2e/support/auto-engine.mjs <port>
 */
import http from "node:http";
import { zipSync } from "fflate";

const PORT = Number(process.argv[2] ?? 8873);
const jobs = new Map();
let n = 0;
const require_hex = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
const pdf = (pad = 0) => Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%"), Buffer.alloc(pad, 32), Buffer.from("\n%%EOF\n")]);

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const json = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (req.method === "POST" && url.pathname === "/internal/v1/jobs") {
    const fd = await new Request("http://x", { method: "POST", body, headers: { "content-type": req.headers["content-type"] } }).formData();
    const op = url.searchParams.get("op");
    const f = fd.get("files");
    const size = f && typeof f !== "string" ? f.size : 0;
    const rows = fd.get("rows");
    const id = (++n).toString(16).padStart(8, "0") + require_hex();
    jobs.set(id, { op, size, rows: typeof rows === "string" ? JSON.parse(rows) : [] });
    return json(202, { id, op, status: "queued" });
  }
  const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
  const job = m ? jobs.get(m[1]) : undefined;
  if (!job) return json(404, { error: "not_found" });
  if (req.method === "DELETE") { jobs.delete(m[1]); res.writeHead(204); return res.end(); }
  if (m[2]) {
    if (job.op === "render-batch") {
      const z = {};
      for (const r of job.rows) z[`${r._file}.pdf`] = new Uint8Array(pdf(2000));
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(Buffer.from(zipSync(z)));
    }
    const out = job.op === "compress" ? pdf(Math.max(1000, Math.round(job.size * 0.22))) : pdf(48_000);
    res.writeHead(200, { "content-type": "application/pdf" });
    return res.end(out);
  }
  return json(200, { id: m[1], op: job.op, status: "done", output: { bytes: 1000 } });
}).listen(PORT, "127.0.0.1", () => console.log(`auto engine on ${PORT}`));

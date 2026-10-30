#!/usr/bin/env node
/**
 * Tools P2, H4: a stand in document engine for the attachment index's local e2e and screenshots only. It
 * speaks the job API shape for extract-text (POST /internal/v1/jobs?op=extract-text, GET /internal/v1/jobs/<id>,
 * GET .../output, DELETE) and answers with the uploaded file's own bytes as text (a PDF fixture gets a fixed
 * invoice text). It does NOT check signatures and never runs anywhere but localhost.
 * Usage: node e2e/support/index-engine.mjs <port>
 */
import http from "node:http";

const PORT = Number(process.argv[2] ?? 8853);
const jobs = new Map();
let n = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const json = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (req.method === "POST" && url.pathname === "/internal/v1/jobs") {
    const fd = await new Request("http://x", { method: "POST", body, headers: { "content-type": req.headers["content-type"] } }).formData();
    const f = fd.get("files");
    const raw = Buffer.from(await f.arrayBuffer()).toString("latin1");
    const text = raw.startsWith("%PDF")
      ? "Harbour Supplies Pty Ltd\nTAX INVOICE\nABN 51 824 753 556\nInvoice number 2207\nOffice chairs x 4\nTotal $1,980.00 including GST\nPayment terms 14 days"
      : raw;
    const id = `idx${++n}job`;
    jobs.set(id, { id, text, status: "done" });
    return json(202, { id, op: url.searchParams.get("op"), status: "queued" });
  }
  const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-z0-9]+)(\/output)?$/);
  const job = m ? jobs.get(m[1]) : undefined;
  if (!job) return json(404, { error: "not_found" });
  if (req.method === "DELETE") { jobs.delete(job.id); res.writeHead(204); return res.end(); }
  if (m[2]) return json(200, { pages: [{ page: 1, text: job.text, ocr: true }], chars: job.text.length });
  return json(200, { id: job.id, status: job.status });
});
server.listen(PORT, "127.0.0.1", () => console.log(`index engine on ${PORT}`));

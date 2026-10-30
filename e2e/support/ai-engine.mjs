#!/usr/bin/env node
/**
 * Tools P2, H3: a stand in document engine for the AI helpers' local e2e and screenshots only. It speaks the
 * job API shape for extract-text, segments, translate-apply, render and merge, picks sample text by the
 * uploaded file's name (lease, contract, invoice, receipt), and does NOT check signatures. Localhost only.
 * Usage: node e2e/support/ai-engine.mjs <port>
 */
import http from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.argv[2] ?? 8843);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const TEXT = {
  lease: [
    "Commercial lease. Landlord: Harbour Properties Pty Ltd. Tenant: Blue Cafe Pty Ltd. Premises: Shop 4, 12 King Street, Sydney.",
    "Rent is $4,200 per month plus GST, paid monthly in advance. The bond is $12,600 and is held by the landlord.",
    "Either party may end this lease with 60 days written notice. The tenant may not sublet without consent.",
  ],
  contract: [
    "SERVICES AGREEMENT\nThis agreement is made between Blue Cafe Pty Ltd and Fresh Linen Co.\nCommencement date: 1 December 2026.\nThe agreement has a term of 12 months and will automatically renew for further 12 month periods unless either party gives 30 days written notice. Fees are $1,200 per month.",
  ],
  invoice: ["Acme Plumbing Pty Ltd\nTAX INVOICE\nABN 51 824 753 556\nInvoice No: INV-20391\nInvoice date: 14/10/2026\nDue date: 28 October 2026\nSubtotal $300.00\nGST $30.00\nTotal amount due $330.00"],
  receipt: ["Harbour Office Supplies\nTax invoice\nABN 51 824 753 556\nReceipt #4471\n12 Oct 2026\nPrinter paper 2x 18.18\nGST $3.64\nTotal $40.00"],
};
const jobs = new Map();

function pick(body) {
  const m = body.toString("latin1").match(/filename="([^"]*)"/);
  const name = (m?.[1] ?? "").toLowerCase();
  for (const k of Object.keys(TEXT)) if (name.includes(k)) return k;
  return "lease";
}

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const body = Buffer.concat(chunks);
    const json = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (url.pathname === "/healthz") return json(200, { ok: true });
    if (req.method === "POST" && url.pathname === "/internal/v1/jobs") {
      const id = randomBytes(10).toString("hex");
      jobs.set(id, { op: url.searchParams.get("op"), kind: pick(body), at: Date.now() });
      return json(202, { id, status: "queued" });
    }
    const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
    const job = m && jobs.get(m[1]);
    if (!job) return json(404, { error: "not_found" });
    if (!m[2]) {
      const done = Date.now() - job.at > 700;
      return json(200, { id: m[1], op: job.op, status: done ? "done" : "running", output: { bytes: 1000 }, result: { pages: TEXT[job.kind].length } });
    }
    if (job.op === "extract-text") return json(200, { pages: TEXT[job.kind].map((text, i) => ({ page: i + 1, text, ocr: false })), chars: 1000 });
    if (job.op === "segments") return json(200, { segments: TEXT[job.kind].flatMap((t, p) => t.split(/(?<=\.)\s+/).map((s, i) => ({ id: `p${p + 1}s${i}`, text: s, page: p + 1 }))) });
    res.writeHead(200, { "content-type": "application/pdf", "content-length": PDF.length });
    res.end(PDF);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`ai stand in engine on ${PORT}`));

// Bundle stats for the web build (R25). Reads dist/web, prints JSON.
// Usage: node scripts/bundle-stats-r25.mjs [distDir]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dist = process.argv[2] ?? "dist/web";
const assets = path.join(dist, "assets");
const files = fs.readdirSync(assets).filter((f) => f.endsWith(".js"));
const rows = files.map((f) => {
  const buf = fs.readFileSync(path.join(assets, f));
  return {
    file: f,
    raw: buf.length,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buf).length,
  };
});
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const entryName = /<script[^>]+type="module"[^>]+src="\/assets\/([^"]+)"/.exec(html)?.[1] ?? "";
const preloads = [...html.matchAll(/rel="modulepreload"[^>]*href="\/assets\/([^"]+)"/g)].map((m) => m[1]);
const entry = rows.find((r) => r.file === entryName);
const sum = (k, list) => list.reduce((a, r) => a + r[k], 0);
const initial = rows.filter((r) => r.file === entryName || preloads.includes(r.file));
const kb = (n) => Math.round(n / 102.4) / 10;
const out = {
  chunks: rows.length,
  totalJsKb: { raw: kb(sum("raw", rows)), gzip: kb(sum("gzip", rows)), brotli: kb(sum("brotli", rows)) },
  entry: entry ? { file: entry.file, rawKb: kb(entry.raw), gzipKb: kb(entry.gzip), brotliKb: kb(entry.brotli) } : null,
  initialHtmlJsKb: { files: initial.length, raw: kb(sum("raw", initial)), gzip: kb(sum("gzip", initial)), brotli: kb(sum("brotli", initial)) },
  largest10: rows
    .sort((a, b) => b.raw - a.raw)
    .slice(0, 10)
    .map((r) => ({ file: r.file, rawKb: kb(r.raw), gzipKb: kb(r.gzip) })),
};
console.log(JSON.stringify(out, null, 2));

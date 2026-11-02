#!/usr/bin/env node
// Rebuilds vendored files that are too large for one request to the code host.
// Each file lives in vendor/<name>/ as one gzip stream split into parts plus its sha256;
// this writes the exact original bytes into public/vendor/ before vite copies public/.
// Usage: node scripts/restore-vendor.mjs            restore (idempotent, fails on any mismatch)
//        node scripts/restore-vendor.mjs --pack <v> pack public/vendor/scalar-api-reference-<v>.js
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync, constants } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "vendor", "scalar");
const outDir = path.join(root, "public", "vendor");
const PART_BYTES = 800 * 1024;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function pack(version) {
  const name = `scalar-api-reference-${version}.js`;
  const data = readFileSync(path.join(outDir, name));
  const gz = gzipSync(data, { level: constants.Z_BEST_COMPRESSION });
  for (const f of readdirSync(srcDir)) if (f.includes(".gz.part") || f.endsWith(".sha256")) rmSync(path.join(srcDir, f));
  const count = Math.ceil(gz.length / PART_BYTES);
  const size = Math.ceil(gz.length / count);
  for (let i = 0; i < count; i++) writeFileSync(path.join(srcDir, `${name}.gz.part${i + 1}`), gz.subarray(i * size, (i + 1) * size));
  writeFileSync(path.join(srcDir, `${name}.sha256`), `${sha256(data)}  ${name}\n`);
  console.log(`packed ${name}: ${count} parts`);
}

function restore() {
  for (const f of readdirSync(srcDir).filter((f) => f.endsWith(".sha256"))) {
    const name = f.slice(0, -".sha256".length);
    const expected = readFileSync(path.join(srcDir, f), "utf8").trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`restore-vendor: bad sha256 file ${f}`);
    const out = path.join(outDir, name);
    if (existsSync(out) && sha256(readFileSync(out)) === expected) continue;
    const parts = readdirSync(srcDir)
      .filter((p) => p.startsWith(`${name}.gz.part`))
      .sort((a, b) => Number(a.split(".part")[1]) - Number(b.split(".part")[1]));
    if (parts.length === 0) throw new Error(`restore-vendor: no parts for ${name}`);
    const data = gunzipSync(Buffer.concat(parts.map((p) => readFileSync(path.join(srcDir, p)))));
    const got = sha256(data);
    if (got !== expected) throw new Error(`restore-vendor: ${name} sha256 ${got} does not match ${expected}`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(out, data);
    console.log(`restore-vendor: ${name} rebuilt (${data.length} bytes, sha256 ok)`);
  }
}

const i = process.argv.indexOf("--pack");
if (i > -1) pack(process.argv[i + 1]);
else restore();

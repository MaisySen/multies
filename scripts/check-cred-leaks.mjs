#!/usr/bin/env node
/**
 * Credential leak check (R27). Fails (exit 1) when any value from ../CREDENTIALS.local.md appears in a log or
 * transcript under the task directories (default /home/user/tab/tasks; CRED_LEAK_ROOTS=dir1:dir2 to change).
 * Prints only the file path and the key name, never the value. Runs in the pre-commit hook and in
 * tests/cred-leaks.test.ts. Files that are meant to hold secrets (mode 600 *.secret.json, .stalwart-env.json) are skipped.
 * `--scrub` redacts the values it finds in place (for cleaning up old logs), then exits 0.
 * A cache of clean files (path, size, mtime) for the current value set keeps repeat runs fast.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { loadEntries, secretTokens } from "./creds.mjs";

const TEXT = /\.(log|txt|json|jsonl|md|out|err|mjs|js|ts|py|sh|html|csv|yaml|yml|env)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "test-results", "playwright-report"]);
const SKIP_FILES = new Set([".stalwart-env.json"]);
const MAX = 64 * 1024 * 1024;

export function scan({ roots, entries = loadEntries(), cacheFile, min = 8, scrub = false } = {}) {
  const tokens = secretTokens(entries, min);
  if (!tokens.length) return { tokens: 0, files: 0, hits: [] };
  const keyOf = new Map();
  for (const e of entries) for (const t of secretTokens([e], min)) if (!keyOf.has(t)) keyOf.set(t, e.key);
  const setId = createHash("sha256").update(tokens.join("\u0000")).digest("hex").slice(0, 16);
  let cache = {};
  if (cacheFile && existsSync(cacheFile)) { try { const c = JSON.parse(readFileSync(cacheFile, "utf8")); if (c.setId === setId) cache = c.clean || {}; } catch { /* rebuild */ } }
  const clean = {};
  const hits = [];
  let files = 0;
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) walk(p); continue; }
      if (!d.isFile() || !TEXT.test(d.name) || SKIP_FILES.has(d.name)) continue;
      let st; try { st = statSync(p); } catch { continue; }
      if (st.size > MAX || st.size === 0) continue;
      const sig = `${st.size}:${st.mtimeMs}`;
      files++;
      if (cache[p] === sig) { clean[p] = sig; continue; }
      let buf; try { buf = readFileSync(p, "latin1"); } catch { continue; }
      const found = tokens.filter((t) => buf.includes(t));
      if (found.length) {
        hits.push({ file: p, keys: [...new Set(found.map((t) => keyOf.get(t) || "?"))] });
        if (scrub) { let s = buf; for (const t of found) s = s.split(t).join("[redacted]"); writeFileSync(p, s, "latin1"); }
      } else clean[p] = sig;
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r);
  if (cacheFile) { mkdirSync(path.dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify({ setId, clean }), { mode: 0o600 }); }
  return { tokens: tokens.length, files, hits };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const roots = (process.env.CRED_LEAK_ROOTS || "/home/user/tab/tasks").split(":").filter(Boolean);
  const scrub = process.argv.includes("--scrub");
  const r = scan({ roots, scrub, cacheFile: path.join(os.homedir(), ".cache", "multies-cred-leak-scan.json") });
  if (!r.tokens) { console.log("cred-leaks: no credentials file, nothing to check"); process.exit(0); }
  for (const h of r.hits) console.log(`LEAK ${h.file}: ${h.keys.join(", ")}`);
  console.log(`cred-leaks: ${r.files} files checked against ${r.tokens} values, ${r.hits.length} with a credential${scrub ? " (redacted in place)" : ""}`);
  process.exit(r.hits.length && !scrub ? 1 : 0);
}

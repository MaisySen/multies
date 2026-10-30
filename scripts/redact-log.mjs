#!/usr/bin/env node
/**
 * Log filter (R26): `some-command 2>&1 | node scripts/redact-log.mjs` prints the output with every credential masked.
 * Values are found BY NAME, not by length: each `NAME=value` (or `NAME (note)=value`, `NAME: value`) line whose
 * name looks like a credential in .dev.vars, .env*, ../preview.env.local and ../CREDENTIALS.local.md, plus the
 * same names in this process's environment. A length rule alone once let a short password with a "!" through.
 * Credential shapes (bearer tokens, JWTs, provider key prefixes, name=value pairs) are masked too.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseCredentials, secretTokens } from "./creds.mjs";

const NAME = /pass(word)?|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|dsn|cvc/i;
const MASK = "[masked]";

export function valuesFromText(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[-*]\s*/, "");
    const m = line.match(/^([A-Za-z0-9_ .()'",-]{2,120}?)\s*[:=]\s*`?([^`\s][^`]*?)`?\s*$/);
    if (!m || !NAME.test(m[1])) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    if (v.length >= 6 && !/^https?:\/\/[^@]*$/.test(v) && !v.includes(" ")) out.push(v);
  }
  return out;
}

export function knownValues(root = process.cwd(), env = process.env) {
  const files = [];
  for (const dir of [root, path.resolve(root, "..")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f === ".dev.vars" || f.startsWith(".env") || f === "preview.env.local" || f === "CREDENTIALS.local.md") files.push(path.join(dir, f));
    }
  }
  const vals = files.flatMap((f) => { try { const t = readFileSync(f, "utf8"); return [...valuesFromText(t), ...secretTokens(parseCredentials(t), 6)]; } catch { return []; } });
  for (const [k, v] of Object.entries(env)) if (NAME.test(k) && typeof v === "string" && v.length >= 6) vals.push(v);
  return [...new Set(vals)].sort((a, b) => b.length - a.length);
}

const SHAPES = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (m) => `${m.split(/\s+/)[0]} ${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => MASK],
  [/\b(re|sk|rk|pk|whsec|ghp|gho|ghs|github_pat|xox[abpr])_[A-Za-z0-9_]{12,}/g, () => MASK],
  [/([A-Za-z0-9_.-]*(?:pass(?:word)?|secret|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*(?:\s*\([^)\n]{0,40}\))?["']?\s*[:=]\s*["'`]?)([^\s"'`,;&}]+)/gi, (_m, n, v) => (v === MASK ? `${n}${v}` : `${n}${MASK}`)],
];

export function maskLine(line, known) {
  let out = line;
  for (const v of known) out = out.split(v).join(MASK);
  for (const [re, fn] of SHAPES) out = out.replace(re, fn);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const known = knownValues();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (l) => process.stdout.write(maskLine(l, known) + "\n"));
}

#!/usr/bin/env node
/**
 * Credentials helper (R27). The ONE way scripts read ../CREDENTIALS.local.md.
 *
 * It never hands a value back as text. A value can only go:
 *   - into a child process's environment:  node scripts/creds.mjs run KEY[,KEY...] -- <cmd> [args...]
 *     (the child's stdout and stderr are masked for every known credential value before they reach this terminal)
 *   - into a file with mode 600:           node scripts/creds.mjs file KEY <path>
 * and the only things it prints are key names, lengths and file paths:  node scripts/creds.mjs keys
 *
 * In code, import { envWith, writeSecretFile } from "./creds.mjs". envWith returns an env object whose
 * console.log, util.inspect, String() and JSON.stringify forms are masked, so printing it shows no value.
 *
 * Keys are the names in the file: `NAME=value`, `- NAME: value`, `- Label (NOTE): value`, and the
 * `user / secret` pairs (`Label (USER_KEY / SECRET_KEY): user / secret`) which become two keys.
 * Set CREDENTIALS_PATH to read another file (tests use a fixture).
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PATH = path.resolve(HERE, "..", "..", "CREDENTIALS.local.md");
export const MASK = "[masked]";

const clean = (v) => v.trim().replace(/^`|`$/g, "").replace(/^["']|["']$/g, "").trim();

/** Parse the credentials file into [{ key, value }]. Pure; never logs. */
export function parseCredentials(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    const line = raw.replace(/^\s*[-*]\s*/, "");
    // Label (A / B): x / y   -> A=x, B=y
    let m = line.match(/^[^:=]*?\(\s*([A-Z][A-Z0-9_]*)\s*\/\s*([A-Z][A-Z0-9_]*)\s*\)\s*[:=]\s*(.+?)\s*\/\s*(.+?)\s*$/);
    if (m) { out.push({ key: m[1], value: clean(m[3]) }, { key: m[2], value: clean(m[4]) }); continue; }
    // NAME=value | NAME (note)=value | Label: value
    m = line.match(/^([A-Za-z0-9_ .()'",/+-]{2,120}?)\s*(?:=|:\s)\s*(.+?)\s*$/) || line.match(/^([A-Za-z0-9_ .()'",/+-]{2,120}?)\s*:\s*(\S.*?)\s*$/);
    if (!m) continue;
    const label = m[1].trim();
    const inParen = label.match(/\(\s*([A-Z][A-Z0-9_]{2,})\s*\)/);
    const lead = label.match(/^([A-Z][A-Z0-9_]{2,})\s*\(/);
    const key = /^[A-Z][A-Z0-9_]*$/.test(label) ? label : lead ? lead[1] : inParen ? inParen[1] : label;
    const value = clean(m[2]);
    if (value) out.push({ key, value });
  }
  return out;
}

const SECRET_NAME = /pass(word)?|secret|token|api[_ -]?key|private[_ -]?key|signing|dsn|cookie|cvc|\bpin\b|recovery|credential|_KEY\b/i;
/** Values that are public by design (served in every page), so not secrets. */
export const PUBLIC_KEYS = new Set(["WEB_ANALYTICS_BEACON_TOKEN", "CF_BEACON_TOKEN", "STRIPE_PUBLISHABLE_KEY", "VITE_STRIPE_PUBLISHABLE_KEY"]);
const classes = (v) => [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(v)).length;

/** Values of credential-named keys that look like secrets (not prose, a URL, an email, a path or a date). Used by the leak check and the masking. */
/** A line that only points at where a secret lives (Bitwarden), with no value in it. Its task ids and tenant
 * names are not secrets; treating them as such made the R27 scan flag every log that mentions them (SEC5, Nov 2 2026). */
export const isPointer = (v) => /bitwarden/i.test(v) && /not stored here|value only in|superseded value removed|\bsee\b/i.test(v);

export function secretTokens(entries, min = 8) {
  const toks = new Set();
  for (const { key, value } of entries) {
    if (!SECRET_NAME.test(key) || /\bnames?\b/i.test(key) || PUBLIC_KEYS.has(key)) continue;
    if (isPointer(value)) continue; // "not stored here, see Bitwarden item ..." holds no value (SEC5)
    for (const t of value.split(/\s+/)) {
      const v = clean(t).replace(/^[("'<`]+|[)"'>`,.;:]+$/g, "");
      if (/["'()<>]/.test(v)) continue;
      if (v.length < min) continue;
      if (/^https?:\/\//i.test(v) || /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v)) continue;
      if (/^[a-z]+$/i.test(v) && v.length < 20) continue; // a plain word
      if (/^[\w.-]+\.(md|json|ts|mjs|js|py|toml|txt|png|sql)$/i.test(v) || v.startsWith("/")) continue; // a path
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) continue; // a date
      if (classes(v) < 2 && v.length < 24) continue; // prose, a slug or a bare number
      if (/^[A-Z][A-Z0-9_]+$/.test(v)) continue; // another key's name
      toks.add(v);
    }
  }
  return [...toks].sort((a, b) => b.length - a.length);
}

export function loadEntries(file = process.env.CREDENTIALS_PATH || DEFAULT_PATH) {
  if (!existsSync(file)) return [];
  return parseCredentials(readFileSync(file, "utf8"));
}

function lookup(entries, key) {
  const hit = entries.filter((e) => e.key === key);
  if (!hit.length) throw new Error(`creds: no key named ${key} (see: node scripts/creds.mjs keys)`);
  return hit[hit.length - 1].value;
}

function maskObject(obj, names) {
  const masked = () => Object.fromEntries(Object.keys(obj).map((k) => [k, names.has(k) ? MASK : obj[k]]));
  Object.defineProperty(obj, inspect.custom, { value: () => masked(), enumerable: false });
  Object.defineProperty(obj, "toJSON", { value: () => masked(), enumerable: false });
  Object.defineProperty(obj, "toString", { value: () => "[env with masked credentials]", enumerable: false });
  return obj;
}

/** A copy of `base` with the named credentials added as env vars. `rename` maps KEY -> ENV_NAME. Prints as masked. */
export function envWith(keys, { base = process.env, rename = {}, entries = loadEntries() } = {}) {
  const env = { ...base };
  const names = new Set();
  for (const key of keys) { const name = rename[key] || key; env[name] = lookup(entries, key); names.add(name); }
  return maskObject(env, names);
}

/** Write one credential to a file with mode 600. Returns the path and the length only. */
export function writeSecretFile(key, file, { entries = loadEntries() } = {}) {
  const v = lookup(entries, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, v, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, length: v.length };
}

export function maskText(text, tokens) {
  let out = text;
  for (const t of tokens) out = out.split(t).join(MASK);
  return out;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const entries = loadEntries();
  if (cmd === "keys") {
    for (const e of entries) if (/^[A-Z][A-Z0-9_]+$/.test(e.key)) process.stdout.write(`${e.key} (${e.value.length} chars)\n`);
    return 0;
  }
  if (cmd === "file") {
    const [key, file] = rest;
    const r = writeSecretFile(key, file, { entries });
    process.stdout.write(`wrote ${key} to ${r.file} (${r.length} chars, mode 600)\n`);
    return 0;
  }
  if (cmd === "run") {
    const sep = rest.indexOf("--");
    if (sep < 1) { process.stderr.write("usage: creds.mjs run KEY[,KEY] -- cmd args\n"); return 2; }
    const keys = rest[0].split(",").map((k) => k.trim()).filter(Boolean);
    const env = envWith(keys, { entries });
    const tokens = secretTokens(entries, 6);
    const child = spawn(rest[sep + 1], rest.slice(sep + 2), { env: { ...env }, stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.on("data", (d) => process.stdout.write(maskText(d.toString(), tokens)));
    child.stderr.on("data", (d) => process.stderr.write(maskText(d.toString(), tokens)));
    child.on("close", (code) => process.exit(code ?? 1));
    return null;
  }
  process.stderr.write("usage: creds.mjs keys | file KEY PATH | run KEY[,KEY] -- cmd args   (no command prints a value)\n");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
